import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { readConveneCouncilConfig } from "./config";
import { ISSUE_PREFIX } from "./constants";
import { buildBaseCouncilMessages, createParticipantState } from "./context";
import { parseThinking } from "./guards";
import {
	type CouncilProgressReporter,
	createCouncilProgressReporter,
	formatParticipantLabel,
} from "./progress";
import {
	buildClarificationReviewTask,
	buildFinalAnswerTask,
	buildInitialOpinionTask,
	buildMissingInformationResponseTask,
	buildNoConsensusResult,
	buildOpinionReviewTask,
} from "./prompts";
import {
	requestFinalAnswer,
	requestInitialOpinion,
	requestMissingInformationResponse,
	requestParticipantDiscussion,
} from "./provider";
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

/** Executes the bounded two-participant council loop. */
export async function executeConveneCouncil({
	completeSimple,
	toolCallId,
	params,
	signal,
	ctx,
	currentThinkingLevel,
	loadedSkillRoots,
	contextFiles,
	onUpdate,
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

	const progress = createCouncilProgressReporter({
		runId: toolCallId,
		question: params.question,
		runtime: runtimeResult.runtime,
		iterationLimit: configResult.config.participantIterationLimit,
		onUpdate,
	});
	progress.setPhase("preparing context");

	const baseMessages = await buildBaseCouncilMessages({
		ctx,
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
		contextFiles,
		progress,
		remainingIterations: configResult.config.participantIterationLimit,
	});
}

/** Runs council iterations sequentially because every pair depends on prior opinions. */
async function runCouncilIterations(
	options: IterationOptions,
): Promise<AgentToolResult<unknown>> {
	if (options.remainingIterations === 0) {
		return finishWithoutAgreement(options);
	}
	if (
		needsMutualMissingInfo(options.llm1, options.llm2) &&
		options.remainingIterations < 2
	) {
		return finishWithoutAgreement(options);
	}

	const iteration = getCurrentIteration(options);
	const pairResult = await runNextParticipantPair({ ...options, iteration });
	if ("kind" in pairResult) {
		return handleCouncilIssue(options.ctx, pairResult, options.progress);
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

/** Calculates the visible iteration number from the remaining iteration budget. */
function getCurrentIteration(options: IterationOptions): number {
	return Math.max(
		1,
		options.config.participantIterationLimit - options.remainingIterations + 1,
	);
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
	options.progress.recordRequest(
		options.llm1.id,
		"initial opinion",
		"A initial opinion",
	);
	options.progress.setPhase("A initial opinion", options.iteration);
	const llm1Promise = requestInitialOpinion({
		participant: options.llm1,
		task: buildInitialOpinionTask(options.question),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});

	options.progress.recordRequest(
		options.llm2.id,
		"initial opinion",
		"B initial opinion",
	);
	options.progress.setPhase("B initial opinion", options.iteration);
	const llm2Promise = requestInitialOpinion({
		participant: options.llm2,
		task: buildInitialOpinionTask(options.question),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});

	const [llm1Result, llm2Result] = await Promise.all([
		llm1Promise,
		llm2Promise,
	]);
	if ("kind" in llm1Result) {
		return llm1Result;
	}
	if ("kind" in llm2Result) {
		return llm2Result;
	}
	options.progress.recordOpinion(options.llm1.id, llm1Result.response.opinion);
	options.progress.recordOpinion(options.llm2.id, llm2Result.response.opinion);

	return {
		llm1: applyParticipantResponse(options.llm1, llm1Result, false),
		llm2: applyParticipantResponse(options.llm2, llm2Result, false),
		iterationsConsumed: 1,
	};
}

/** Runs the normal exchange where each participant reviews the opponent opinion. */
async function runOpinionExchangePair(
	options: PairOptions,
): Promise<PairResult> {
	options.progress.setPhase("A reviews B", options.iteration);
	options.progress.recordRequest(options.llm1.id, "reviews B", "A reviews B");
	const llm1Result = await requestParticipantDiscussion({
		participant: options.llm1,
		task: buildOpinionReviewTask(requireLatestOpinion(options.llm2)),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in llm1Result) {
		return llm1Result;
	}
	if (llm1Result.response.status !== undefined) {
		options.progress.recordResponse(
			options.llm1.id,
			llm1Result.response.status,
			llm1Result.response.opinion,
		);
	}
	const llm1 = applyParticipantResponse(options.llm1, llm1Result, true);

	options.progress.setPhase("B reviews A", options.iteration);
	options.progress.recordRequest(options.llm2.id, "reviews A", "B reviews A");
	const llm2Result = await requestParticipantDiscussion({
		participant: options.llm2,
		task: buildOpinionReviewTask(requireLatestOpinion(llm1)),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in llm2Result) {
		return llm2Result;
	}
	if (llm2Result.response.status !== undefined) {
		options.progress.recordResponse(
			options.llm2.id,
			llm2Result.response.status,
			llm2Result.response.opinion,
		);
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
	const llm2ResponsePromise = answerMissingInformation(
		options,
		options.llm2,
		requireLatestOpinion(options.llm1),
	);
	const llm1ResponsePromise = answerMissingInformation(
		options,
		options.llm1,
		requireLatestOpinion(options.llm2),
	);
	const [llm2Response, llm1Response] = await Promise.all([
		llm2ResponsePromise,
		llm1ResponsePromise,
	]);
	if ("kind" in llm2Response) {
		return llm2Response;
	}
	if ("kind" in llm1Response) {
		return llm1Response;
	}

	const llm1ReviewPromise = reviewClarification(
		options,
		llm1Response.participant,
		requireLatestOpinion(llm2Response.participant),
	);
	const llm2ReviewPromise = reviewClarification(
		options,
		llm2Response.participant,
		requireLatestOpinion(llm1Response.participant),
	);
	const [llm1Review, llm2Review] = await Promise.all([
		llm1ReviewPromise,
		llm2ReviewPromise,
	]);
	if ("kind" in llm1Review) {
		return llm1Review;
	}
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
	const phase = `${formatParticipantLabel(participant.id)} answers missing info`;
	options.progress.setPhase(phase, options.iteration);
	options.progress.recordRequest(participant.id, "answers missing info", phase);
	const responseResult = await requestMissingInformationResponse({
		participant,
		task: buildMissingInformationResponseTask(missingInformationRequest),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in responseResult) {
		return responseResult;
	}
	options.progress.recordClarification(
		participant.id,
		responseResult.response.opinion,
	);
	return {
		participant: applyParticipantResponse(participant, responseResult, false),
	};
}

/** Requests a requester review of an opponent clarification. */
async function reviewClarification(
	options: PairOptions,
	participant: ParticipantState,
	clarification: string,
): Promise<ParticipantUpdateResult> {
	const phase = `${formatParticipantLabel(participant.id)} reviews clarification`;
	options.progress.setPhase(phase, options.iteration);
	options.progress.recordRequest(
		participant.id,
		"reviews clarification",
		phase,
	);
	const reviewResult = await requestParticipantDiscussion({
		participant,
		task: buildClarificationReviewTask(clarification),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in reviewResult) {
		return reviewResult;
	}
	if (reviewResult.response.status !== undefined) {
		options.progress.recordResponse(
			participant.id,
			reviewResult.response.status,
			reviewResult.response.opinion,
		);
	}
	return {
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
	const finalPhase = `final answer from ${formatParticipantLabel(finalParticipant.id)}`;
	options.progress.recordSuccess("agreement reached", "agreed");
	options.progress.recordRequest(
		finalParticipant.id,
		"final answer",
		finalPhase,
	);
	const finalResult = await requestFinalAnswer({
		participant: finalParticipant,
		task: buildFinalAnswerTask(),
		config: options.config,
		completeSimple: options.completeSimple,
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in finalResult) {
		return handleCouncilIssue(options.ctx, finalResult, options.progress);
	}
	options.progress.recordSuccess("final answer accepted", "agreed");
	options.progress.finish("succeeded", "agreed");
	return formatToolOutput(finalResult.answer);
}

/** Returns the two latest participant opinions when agreement was not reached. */
function finishWithoutAgreement(
	options: IterationOptions,
): Promise<AgentToolResult<unknown>> | AgentToolResult<unknown> {
	if (options.llm1.latest === undefined || options.llm2.latest === undefined) {
		options.progress.recordError(
			"council did not produce participant opinions",
			"failed",
		);
		options.progress.finish("failed", "failed");
		return errorResult("Council did not produce participant opinions.");
	}

	options.progress.recordInfo(
		"iteration limit reached",
		"iteration limit reached",
	);
	options.progress.finish("succeeded", "iteration limit reached");
	return formatToolOutput(
		buildNoConsensusResult(
			options.llm1.latest.opinion,
			options.llm2.latest.opinion,
		),
	);
}

/** Routes logical council outcomes to text and infrastructure failures to Pi tool errors. */
function handleCouncilIssue(
	ctx: ExecuteConveneCouncilOptions["ctx"],
	issue: CouncilIssue,
	progress: CouncilProgressReporter,
): AgentToolResult<unknown> {
	if (issue.kind === "tool-error") {
		progress.recordError(issue.message, "failed");
		progress.finish("failed", "failed");
		throw reportToolError(ctx, issue.message);
	}
	progress.recordError(issue.message, "failed");
	progress.finish("failed", "failed");
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

interface BaseCouncilOptions {
	readonly llm1: ParticipantState;
	readonly llm2: ParticipantState;
	readonly question: string;
	readonly config: ConveneCouncilConfig;
	readonly completeSimple: CompleteSimple;
	readonly signal: AbortSignal | undefined;
	readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
	readonly progress: CouncilProgressReporter;
}

interface PairOptions extends BaseCouncilOptions {
	readonly iteration: number;
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

interface FinishAgreedOptions extends BaseCouncilOptions {
	readonly ctx: ExecuteConveneCouncilOptions["ctx"];
}

interface IterationOptions extends FinishAgreedOptions {
	readonly remainingIterations: number;
}
