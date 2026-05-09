import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import { readConveneCouncilConfig } from "./config";
import { ISSUE_PREFIX } from "./constants";
import {
	buildExternalCouncilContextPackage,
	createParticipantState,
} from "./context";
import { parseThinking } from "./guards";
import {
	type CouncilProgressReporter,
	type CouncilRunDetails,
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
	buildParticipantSystemPrompt,
} from "./prompts";
import {
	requestFinalAnswer,
	requestInitialOpinion,
	requestMissingInformationResponse,
	requestParticipantDiscussion,
} from "./provider";
import { resolveCouncilRuntime } from "./runtime";
import { createParticipantSessions } from "./session";
import { resolveCouncilToolArgsForNames } from "./startup";
import { formatToolOutput } from "./tool-output";
import type {
	AcceptedParticipantResponse,
	ChildStartupPlan,
	ConveneCouncilConfig,
	CouncilIssue,
	CouncilRuntime,
	ExecuteConveneCouncilOptions,
	ParticipantId,
	ParticipantRunner,
	ParticipantRunnerFactory,
	ParticipantState,
} from "./types";

/** Executes the bounded two-participant council loop. */
export async function executeConveneCouncil({
	createParticipantRunner,
	resolveStartupPlan,
	toolCallId,
	params,
	signal,
	ctx,
	currentThinkingLevel,
	contextFiles,
	availableTools,
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

	const startupPlan = resolveStartupPlan();
	if ("issue" in startupPlan) {
		throw reportToolError(ctx, startupPlan.issue);
	}

	const toolArgs = resolveCouncilToolArgsForNames(
		configResult.config,
		availableTools.map((tool) => tool.name),
	);
	if ("issue" in toolArgs) {
		throw reportToolError(ctx, toolArgs.issue);
	}

	const progress = createCouncilProgressReporter({
		runId: toolCallId,
		question: params.question,
		runtime: runtimeResult.runtime,
		iterationLimit: configResult.config.participantIterationLimit,
		onUpdate,
	});
	progress.setPhase("preparing context");

	const externalContextPackage = await buildExternalCouncilContextPackage({
		ctx,
		toolCallId,
	});
	return runCouncilWithOwnedParticipants({
		externalContextPackage,
		config: configResult.config,
		contextFiles,
		createParticipantRunner,
		ctx,
		progress,
		question: params.question,
		runtime: runtimeResult.runtime,
		signal,
		startupPlan,
		toolArgs: toolArgs.args,
		tools: selectParticipantTools(toolArgs.args, availableTools),
	});
}

/** Creates temporary participant sessions, runs the council, and cleans every owned resource. */
async function runCouncilWithOwnedParticipants(
	options: OwnedParticipantsOptions,
): Promise<AgentToolResult<unknown>> {
	const contextFilePath = await writeCouncilContextFile(
		options.externalContextPackage,
	);
	let participantSessions:
		| Awaited<ReturnType<typeof createParticipantSessions>>
		| undefined;
	const runners: ParticipantRunner[] = [];
	try {
		participantSessions = await createParticipantSessions({
			cwd: options.ctx.cwd,
		});
		const llm1Runner = await createOwnedParticipantRunner(
			options,
			participantSessions,
			"llm1",
		);
		runners.push(llm1Runner);
		const llm2Runner = await createOwnedParticipantRunner(
			options,
			participantSessions,
			"llm2",
		);
		runners.push(llm2Runner);
		return await runCouncilIterations({
			llm1: createParticipantState("llm1", options.runtime.llm1, llm1Runner),
			llm2: createParticipantState("llm2", options.runtime.llm2, llm2Runner),
			question: options.question,
			config: options.config,
			signal: options.signal,
			ctx: options.ctx,
			contextFiles: options.contextFiles,
			externalContextPackage: contextFilePath,
			progress: options.progress,
			remainingIterations: options.config.participantIterationLimit,
		});
	} finally {
		await Promise.allSettled(runners.map((runner) => runner.dispose()));
		await participantSessions?.cleanup();
		await removeCouncilContextFile(contextFilePath);
	}
}

/** Creates one participant runner from owned session paths and shared council options. */
async function createOwnedParticipantRunner(
	options: OwnedParticipantsOptions,
	participantSessions: ParticipantSessions,
	participantId: "llm1" | "llm2",
): Promise<ParticipantRunner> {
	return options.createParticipantRunner({
		participantId,
		runtime: options.runtime[participantId],
		sessionFile: participantSessions.sessions[participantId].sessionFile,
		sessionDir: participantSessions.sessions[participantId].sessionDir,
		systemPrompt: buildParticipantSystemPrompt(
			options.contextFiles,
			options.tools.map((tool) => tool.name),
		),
		config: options.config,
		startupPlan: options.startupPlan,
		toolArgs: options.toolArgs,
		tools: options.tools,
		ctx: options.ctx,
		signal: options.signal,
		onSessionEvent: (event) =>
			options.progress.recordSessionEvent(participantId, event),
	});
}

/** Writes one run-scoped context file outside the repository. */
async function writeCouncilContextFile(content: string): Promise<string> {
	const path = join(tmpdir(), `pi-convene-council-context-${randomUUID()}.xml`);
	await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return path;
}

/** Deletes the run-scoped context file after every terminal outcome. */
async function removeCouncilContextFile(path: string): Promise<void> {
	await rm(path, { force: true });
}

/** Selects the concrete tool schemas sent to child participants from resolved CLI tool args. */
function selectParticipantTools(
	toolArgs: readonly string[],
	availableTools: ExecuteConveneCouncilOptions["availableTools"],
): readonly Tool[] {
	const toolsFlagIndex = toolArgs.indexOf("--tools");
	const toolsValue =
		toolsFlagIndex === -1 ? undefined : toolArgs[toolsFlagIndex + 1];
	if (toolsValue === undefined) {
		return [];
	}
	const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
	return toolsValue
		.split(",")
		.filter((toolName) => toolName.length > 0)
		.flatMap((toolName): Tool[] => {
			const tool = toolsByName.get(toolName);
			return tool === undefined
				? []
				: [
						{
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						},
					];
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
		return handleCouncilIssue(pairResult, options.progress);
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

/** Records an initial opinion as soon as its participant request succeeds. */
async function recordInitialOpinionWhenResolved(
	promise: Promise<AcceptedParticipantResponse | CouncilIssue>,
	participantId: ParticipantId,
	progress: CouncilProgressReporter,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	const result = await promise;
	if (!("kind" in result)) {
		progress.recordOpinion(participantId, result.response.opinion);
	}
	return result;
}

/** Runs the first participant iteration where no opponent opinion exists yet. */
async function runInitialPair(options: PairOptions): Promise<PairResult> {
	options.progress.setPhase("A and B initial opinions", options.iteration);
	options.progress.recordRequest(options.llm1.id, "initial opinion");
	const llm1Promise = recordInitialOpinionWhenResolved(
		requestInitialOpinion({
			participant: options.llm1,
			task: buildInitialOpinionTask(
				options.question,
				options.externalContextPackage,
			),
			config: options.config,
			signal: options.signal,
			contextFiles: options.contextFiles,
			progress: options.progress,
		}),
		options.llm1.id,
		options.progress,
	);

	options.progress.recordRequest(options.llm2.id, "initial opinion");
	const llm2Promise = recordInitialOpinionWhenResolved(
		requestInitialOpinion({
			participant: options.llm2,
			task: buildInitialOpinionTask(
				options.question,
				options.externalContextPackage,
			),
			config: options.config,
			signal: options.signal,
			contextFiles: options.contextFiles,
			progress: options.progress,
		}),
		options.llm2.id,
		options.progress,
	);

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
		{
			requestPhase: `${formatParticipantLabel(
				options.responder.id,
			)} answers missing info`,
		},
	);
	if ("kind" in responderResult) {
		return responderResult;
	}

	const requesterResult = await reviewClarification(
		options,
		options.requester,
		requireLatestOpinion(responderResult.participant),
		{
			requestPhase: `${formatParticipantLabel(
				options.requester.id,
			)} reviews clarification`,
		},
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
	options.progress.setPhase("A and B answer missing info", options.iteration);
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

	options.progress.setPhase("A and B review clarifications", options.iteration);
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
	requestOptions: { readonly requestPhase?: string } = {},
): Promise<ParticipantUpdateResult> {
	options.progress.recordRequest(
		participant.id,
		"answers missing info",
		requestOptions.requestPhase,
	);
	const responseResult = await requestMissingInformationResponse({
		participant,
		task: buildMissingInformationResponseTask(missingInformationRequest),
		config: options.config,
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
	requestOptions: { readonly requestPhase?: string } = {},
): Promise<ParticipantUpdateResult> {
	options.progress.recordRequest(
		participant.id,
		"reviews clarification",
		requestOptions.requestPhase,
	);
	const reviewResult = await requestParticipantDiscussion({
		participant,
		task: buildClarificationReviewTask(clarification),
		config: options.config,
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
		signal: options.signal,
		contextFiles: options.contextFiles,
		progress: options.progress,
	});
	if ("kind" in finalResult) {
		return handleCouncilIssue(finalResult, options.progress);
	}
	options.progress.recordParticipantSuccess(
		finalParticipant.id,
		"final answer accepted",
		"agreed",
	);
	const details = options.progress.finish("succeeded", "agreed");
	return withCouncilProgressDetails(
		await formatToolOutput(finalResult.answer),
		details,
	);
}

/** Returns the two latest participant opinions when agreement was not reached. */
async function finishWithoutAgreement(
	options: IterationOptions,
): Promise<AgentToolResult<unknown>> {
	if (options.llm1.latest === undefined || options.llm2.latest === undefined) {
		options.progress.recordError(
			"council did not produce participant opinions",
			"failed",
		);
		const details = options.progress.finish("failed", "failed");
		return errorResult(
			"Council did not produce participant opinions.",
			details,
		);
	}

	options.progress.recordInfo(
		"iteration limit reached",
		"iteration limit reached",
	);
	const details = options.progress.finish(
		"succeeded",
		"iteration limit reached",
	);
	return withCouncilProgressDetails(
		await formatToolOutput(
			buildNoConsensusResult(
				options.llm1.latest.opinion,
				options.llm2.latest.opinion,
			),
		),
		details,
	);
}

/** Routes council outcomes to model-facing text and persisted TUI details. */
function handleCouncilIssue(
	issue: CouncilIssue,
	progress: CouncilProgressReporter,
): AgentToolResult<unknown> {
	if (issue.kind === "tool-error") {
		const phase = issue.status === "aborted" ? "aborted" : "failed";
		progress.recordError(issue.message, phase);
		const details = progress.finish(issue.status, phase);
		return errorResult(issue.message, details);
	}
	progress.recordError(issue.message, "failed");
	const details = progress.finish("failed", "failed");
	return errorResult(issue.message, details);
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
function errorResult(
	message: string,
	details?: CouncilRunDetails,
): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

/** Attaches persisted UI progress while preserving the model-facing content. */
function withCouncilProgressDetails(
	result: AgentToolResult<unknown>,
	details: CouncilRunDetails,
): AgentToolResult<unknown> {
	return {
		...result,
		details:
			result.details === undefined
				? details
				: { ...details, outputDetails: result.details },
	};
}

type ParticipantSessions = Awaited<
	ReturnType<typeof createParticipantSessions>
>;

interface OwnedParticipantsOptions {
	readonly externalContextPackage: string;
	readonly config: ConveneCouncilConfig;
	readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
	readonly createParticipantRunner: ParticipantRunnerFactory;
	readonly ctx: ExecuteConveneCouncilOptions["ctx"];
	readonly progress: CouncilProgressReporter;
	readonly question: string;
	readonly runtime: CouncilRuntime;
	readonly signal: AbortSignal | undefined;
	readonly startupPlan: ChildStartupPlan;
	readonly toolArgs: readonly string[];
	readonly tools: readonly Tool[];
}

interface BaseCouncilOptions {
	readonly llm1: ParticipantState;
	readonly llm2: ParticipantState;
	readonly question: string;
	readonly externalContextPackage: string;
	readonly config: ConveneCouncilConfig;
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
