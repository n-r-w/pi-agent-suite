import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { readConveneCouncilConfig } from "./config";
import { ISSUE_PREFIX } from "./constants";
import { buildBaseCouncilMessages, createParticipantState } from "./context";
import { parseThinking } from "./guards";
import {
	buildClarificationReviewTask,
	buildFinalAnswerTask,
	buildInitialOpinionTask,
	buildMissingInformationResponseTask,
	buildOpinionReviewTask,
} from "./prompts";
import { requestFinalAnswer, requestParticipantDiscussion } from "./provider";
import { resolveCouncilRuntime } from "./runtime";
import { formatToolOutput } from "./tool-output";
import type {
	AcceptedParticipantResponse,
	ConveneCouncilConfig,
	ConveneCouncilDependencies,
	CouncilIssue,
	ExecuteConveneCouncilOptions,
	ParticipantState,
} from "./types";
import { escapeXmlText } from "./xml";

/** Executes the bounded two-participant council loop. */
export async function executeConveneCouncil({
	completeSimple,
	toolCallId,
	params,
	signal,
	ctx,
	currentThinkingLevel,
	loadedSkillRoots,
}: ExecuteConveneCouncilOptions): Promise<AgentToolResult<unknown>> {
	const configResult = await readConveneCouncilConfig();
	if ("disabled" in configResult) {
		return errorResult("convene-council is disabled.");
	}
	if ("issue" in configResult) {
		throw reportToolError(ctx, configResult.issue);
	}

	const runtimeResult = await resolveCouncilRuntime(
		ctx,
		configResult.config,
		parseThinking(currentThinkingLevel),
	);
	if ("issue" in runtimeResult) {
		throw reportToolError(ctx, runtimeResult.issue);
	}

	const baseMessages = await buildBaseCouncilMessages({
		ctx,
		question: params.question,
		toolCallId,
		loadedSkillRoots,
	});
	return runCouncilIterations({
		llm1: createParticipantState(
			"llm1",
			runtimeResult.runtime.llm1,
			baseMessages,
		),
		llm2: createParticipantState(
			"llm2",
			runtimeResult.runtime.llm2,
			baseMessages,
		),
		question: params.question,
		config: configResult.config,
		completeSimple,
		signal,
		ctx,
		remainingIterations: configResult.config.participantIterationLimit,
	});
}

/** Runs council iterations sequentially because every pair depends on prior opinions. */
async function runCouncilIterations(
	options: IterationOptions,
): Promise<AgentToolResult<unknown>> {
	if (options.remainingIterations === 0) {
		return finishWithoutAgreement(options.llm1, options.llm2);
	}
	if (
		needsMutualMissingInfo(options.llm1, options.llm2) &&
		options.remainingIterations < 2
	) {
		return finishWithoutAgreement(options.llm1, options.llm2);
	}

	const pairResult = await runNextParticipantPair(options);
	if ("kind" in pairResult) {
		return handleCouncilIssue(options.ctx, pairResult);
	}

	if (participantsAgreeAfterReview(pairResult.llm1, pairResult.llm2)) {
		return finishAgreedCouncil({
			...options,
			llm1: pairResult.llm1,
			llm2: pairResult.llm2,
		});
	}

	return runCouncilIterations({
		...options,
		llm1: pairResult.llm1,
		llm2: pairResult.llm2,
		remainingIterations:
			options.remainingIterations - pairResult.iterationsConsumed,
	});
}

/** Runs the next completed pair of participant discussion responses. */
async function runNextParticipantPair(
	options: PairOptions,
): Promise<PairResult> {
	if (options.llm1.latest === undefined || options.llm2.latest === undefined) {
		return runInitialPair(options);
	}

	if (needsMutualMissingInfo(options.llm1, options.llm2)) {
		return runMutualMissingInfoPair(options);
	}

	if (
		options.llm1.latest.status === "NEED_INFO" &&
		options.llm1.reviewedOpponent
	) {
		return runMissingInfoPair({
			...options,
			requester: options.llm1,
			responder: options.llm2,
		});
	}

	if (
		options.llm2.latest.status === "NEED_INFO" &&
		options.llm2.reviewedOpponent
	) {
		return runMissingInfoPair({
			...options,
			requester: options.llm2,
			responder: options.llm1,
		});
	}

	return runOpinionExchangePair(options);
}

/** Returns true when both participants have pending reviewed missing-information requests. */
function needsMutualMissingInfo(
	llm1: ParticipantState,
	llm2: ParticipantState,
): boolean {
	return (
		llm1.latest?.status === "NEED_INFO" &&
		llm1.reviewedOpponent &&
		llm2.latest?.status === "NEED_INFO" &&
		llm2.reviewedOpponent
	);
}

/** Runs the first participant iteration where no opponent opinion exists yet. */
async function runInitialPair(options: PairOptions): Promise<PairResult> {
	const llm1Result = await requestParticipantDiscussion({
		participant: options.llm1,
		task: buildInitialOpinionTask(options.question),
		requiredStatus: "NEED_INFO",
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	if ("kind" in llm1Result) {
		return llm1Result;
	}
	const llm1 = applyParticipantResponse(options.llm1, llm1Result, false);

	const llm2Result = await requestParticipantDiscussion({
		participant: options.llm2,
		task: buildInitialOpinionTask(options.question),
		requiredStatus: "NEED_INFO",
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	if ("kind" in llm2Result) {
		return llm2Result;
	}

	return {
		llm1,
		llm2: applyParticipantResponse(options.llm2, llm2Result, false),
		iterationsConsumed: 1,
	};
}

/** Runs the normal exchange where each participant reviews the opponent opinion. */
async function runOpinionExchangePair(
	options: PairOptions,
): Promise<PairResult> {
	const llm1Result = await requestParticipantDiscussion({
		participant: options.llm1,
		task: buildOpinionReviewTask(
			options.question,
			requireLatestOpinion(options.llm2),
		),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	if ("kind" in llm1Result) {
		return llm1Result;
	}
	const llm1 = applyParticipantResponse(options.llm1, llm1Result, true);

	const llm2Result = await requestParticipantDiscussion({
		participant: options.llm2,
		task: buildOpinionReviewTask(options.question, requireLatestOpinion(llm1)),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	if ("kind" in llm2Result) {
		return llm2Result;
	}

	return {
		llm1,
		llm2: applyParticipantResponse(options.llm2, llm2Result, true),
		iterationsConsumed: 1,
	};
}

/** Runs a missing-information pair and returns states in LLM1/LLM2 order. */
async function runMissingInfoPair(
	options: MissingInfoPairOptions,
): Promise<PairResult> {
	const responderResult = await answerMissingInformation(
		options,
		options.responder,
		requireLatestOpinion(options.requester),
	);
	if ("kind" in responderResult) {
		return responderResult;
	}

	const requesterResult = await reviewClarification(
		options,
		options.requester,
		requireLatestOpinion(responderResult.participant),
	);
	if ("kind" in requesterResult) {
		return requesterResult;
	}

	return requesterResult.participant.id === "llm1"
		? {
				llm1: requesterResult.participant,
				llm2: responderResult.participant,
				iterationsConsumed: 1,
			}
		: {
				llm1: responderResult.participant,
				llm2: requesterResult.participant,
				iterationsConsumed: 1,
			};
}

/** Answers both pending missing-information requests before both requesters review clarifications. */
async function runMutualMissingInfoPair(
	options: PairOptions,
): Promise<PairResult> {
	const llm2Response = await answerMissingInformation(
		options,
		options.llm2,
		requireLatestOpinion(options.llm1),
	);
	if ("kind" in llm2Response) {
		return llm2Response;
	}

	const llm1Response = await answerMissingInformation(
		options,
		options.llm1,
		requireLatestOpinion(options.llm2),
	);
	if ("kind" in llm1Response) {
		return llm1Response;
	}

	const llm1Review = await reviewClarification(
		options,
		llm1Response.participant,
		requireLatestOpinion(llm2Response.participant),
	);
	if ("kind" in llm1Review) {
		return llm1Review;
	}

	const llm2Review = await reviewClarification(
		options,
		llm2Response.participant,
		requireLatestOpinion(llm1Response.participant),
	);
	if ("kind" in llm2Review) {
		return llm2Review;
	}

	return {
		llm1: llm1Review.participant,
		llm2: llm2Review.participant,
		iterationsConsumed: 2,
	};
}

/** Requests an opponent response to one missing-information request. */
async function answerMissingInformation(
	options: PairOptions,
	participant: ParticipantState,
	missingInformationRequest: string,
): Promise<ParticipantUpdateResult> {
	const responseResult = await requestParticipantDiscussion({
		participant,
		task: buildMissingInformationResponseTask(
			options.question,
			missingInformationRequest,
		),
		requiredStatus: "DIFF",
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	return "kind" in responseResult
		? responseResult
		: {
				participant: applyParticipantResponse(
					participant,
					responseResult,
					false,
				),
			};
}

/** Requests a requester review of an opponent clarification. */
async function reviewClarification(
	options: PairOptions,
	participant: ParticipantState,
	clarification: string,
): Promise<ParticipantUpdateResult> {
	const reviewResult = await requestParticipantDiscussion({
		participant,
		task: buildClarificationReviewTask(options.question, clarification),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	return "kind" in reviewResult
		? reviewResult
		: {
				participant: applyParticipantResponse(participant, reviewResult, true),
			};
}

/** Applies an accepted participant response to that participant's conversation history. */
function applyParticipantResponse(
	participant: ParticipantState,
	accepted: AcceptedParticipantResponse,
	reviewedOpponent: boolean,
): ParticipantState {
	return {
		...participant,
		history: [
			...participant.history,
			accepted.taskMessage,
			accepted.assistantMessage,
		],
		reviewedOpponent,
		latest: accepted.response,
	};
}

/** Returns true only after both participants agreed after reviewing an opponent opinion. */
function participantsAgreeAfterReview(
	llm1: ParticipantState,
	llm2: ParticipantState,
): boolean {
	return (
		llm1.reviewedOpponent &&
		llm2.reviewedOpponent &&
		llm1.latest?.status === "AGREE" &&
		llm2.latest?.status === "AGREE"
	);
}

/** Returns the latest opinion or fails if the loop invariant is broken. */
function requireLatestOpinion(participant: ParticipantState): string {
	if (participant.latest === undefined) {
		throw new Error(`${participant.id} latest opinion is unavailable`);
	}
	return participant.latest.opinion;
}

/** Requests and returns the final answer from the configured participant. */
async function finishAgreedCouncil(
	options: FinishAgreedOptions,
): Promise<AgentToolResult<unknown>> {
	const finalParticipant =
		options.config.finalAnswerParticipant === "llm1"
			? options.llm1
			: options.llm2;
	const finalResult = await requestFinalAnswer({
		participant: finalParticipant,
		task: buildFinalAnswerTask(
			options.question,
			requireLatestOpinion(options.llm1),
			requireLatestOpinion(options.llm2),
		),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
	});
	if ("kind" in finalResult) {
		return handleCouncilIssue(options.ctx, finalResult);
	}
	return formatToolOutput(finalResult.answer);
}

/** Returns the two latest participant opinions when agreement was not reached. */
function finishWithoutAgreement(
	llm1: ParticipantState,
	llm2: ParticipantState,
): Promise<AgentToolResult<unknown>> | AgentToolResult<unknown> {
	if (llm1.latest === undefined || llm2.latest === undefined) {
		return errorResult("Council did not produce participant opinions.");
	}

	return formatToolOutput(
		`<answer1>${escapeXmlText(llm1.latest.opinion)}</answer1><answer2>${escapeXmlText(llm2.latest.opinion)}</answer2>`,
	);
}

/** Routes logical council outcomes to text and infrastructure failures to Pi tool errors. */
function handleCouncilIssue(
	ctx: ExecuteConveneCouncilOptions["ctx"],
	issue: CouncilIssue,
): AgentToolResult<unknown> {
	if (issue.kind === "tool-error") {
		throw reportToolError(ctx, issue.message);
	}
	return errorResult(issue.message);
}

/** Reports a non-logical execution failure and returns the Error to throw. */
function reportToolError(
	ctx: ExecuteConveneCouncilOptions["ctx"],
	issue: string,
): Error {
	if (ctx.hasUI !== false) {
		ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
	}
	return new Error(issue);
}

/** Creates a standard text result for logical council execution outcomes. */
function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: undefined };
}

type CompleteSimple = NonNullable<ConveneCouncilDependencies["completeSimple"]>;

interface PairOptions {
	readonly llm1: ParticipantState;
	readonly llm2: ParticipantState;
	readonly question: string;
	readonly config: ConveneCouncilConfig;
	readonly completeSimple: CompleteSimple;
	readonly signal: AbortSignal | undefined;
}

type PairResult =
	| {
			readonly llm1: ParticipantState;
			readonly llm2: ParticipantState;
			readonly iterationsConsumed: number;
	  }
	| CouncilIssue;

type ParticipantUpdateResult =
	| { readonly participant: ParticipantState }
	| CouncilIssue;

interface MissingInfoPairOptions extends PairOptions {
	readonly requester: ParticipantState;
	readonly responder: ParticipantState;
}

interface FinishAgreedOptions extends PairOptions {
	readonly ctx: ExecuteConveneCouncilOptions["ctx"];
}

interface IterationOptions extends FinishAgreedOptions {
	readonly remainingIterations: number;
}
