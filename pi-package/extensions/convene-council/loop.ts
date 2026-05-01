import type {
	AgentMessage,
	AgentToolResult,
} from "@mariozechner/pi-agent-core";
import type { Context, Tool } from "@mariozechner/pi-ai";
import { generateSummary } from "@mariozechner/pi-coding-agent";
import { escapeUTF8 } from "entities";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { readConveneCouncilConfig } from "./config";
import { COUNCIL_CONTEXT_TOO_LARGE_ERROR, ISSUE_PREFIX } from "./constants";
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
import { resolveContextSummaryRuntime, resolveCouncilRuntime } from "./runtime";
import { createParticipantSessions } from "./session";
import { resolveCouncilToolArgsForNames } from "./startup";
import {
	createSummarySourceMessage,
	validateSummaryInputSize,
} from "./summary-preflight";
import { formatToolOutput } from "./tool-output";
import type {
	AcceptedParticipantResponse,
	ChildStartupPlan,
	ContextSummaryGenerator,
	ConveneCouncilConfig,
	CouncilIssue,
	CouncilRuntime,
	ExecuteConveneCouncilOptions,
	ParticipantRunner,
	ParticipantRunnerFactory,
	ParticipantRuntime,
	ParticipantState,
} from "./types";

/** Executes the bounded two-participant council loop. */
export async function executeConveneCouncil({
	createParticipantRunner,
	generateContextSummary,
	resolveStartupPlan,
	toolCallId,
	params,
	signal,
	ctx,
	currentThinkingLevel,
	loadedSkillRoots,
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
		loadedSkillRoots,
	});
	return runCouncilWithOwnedParticipants({
		externalContextPackage,
		...(generateContextSummary === undefined ? {} : { generateContextSummary }),
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
async function runCouncilWithOwnedParticipants(options: {
	readonly externalContextPackage: string;
	readonly generateContextSummary?:
		| ExecuteConveneCouncilOptions["generateContextSummary"]
		| undefined;
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
}): Promise<AgentToolResult<unknown>> {
	const preparedContext = await prepareExternalContextForFirstPrompt(options);
	if ("issue" in preparedContext) {
		throw reportToolError(options.ctx, preparedContext.issue);
	}

	const participantSessions = await createParticipantSessions({
		cwd: options.ctx.cwd,
	});
	const runners: ParticipantRunner[] = [];
	try {
		const toolNames = options.tools.map((tool) => tool.name);
		const llm1Runner = await options.createParticipantRunner({
			participantId: "llm1",
			runtime: options.runtime.llm1,
			sessionFile: participantSessions.sessions.llm1.sessionFile,
			sessionDir: participantSessions.sessions.llm1.sessionDir,
			systemPrompt: buildParticipantSystemPrompt(
				options.contextFiles,
				toolNames,
			),
			config: options.config,
			startupPlan: options.startupPlan,
			toolArgs: options.toolArgs,
			tools: options.tools,
			ctx: options.ctx,
			signal: options.signal,
			onSessionEvent: (event) =>
				options.progress.recordSessionEvent("llm1", event),
		});
		runners.push(llm1Runner);
		const llm2Runner = await options.createParticipantRunner({
			participantId: "llm2",
			runtime: options.runtime.llm2,
			sessionFile: participantSessions.sessions.llm2.sessionFile,
			sessionDir: participantSessions.sessions.llm2.sessionDir,
			systemPrompt: buildParticipantSystemPrompt(
				options.contextFiles,
				toolNames,
			),
			config: options.config,
			startupPlan: options.startupPlan,
			toolArgs: options.toolArgs,
			tools: options.tools,
			ctx: options.ctx,
			signal: options.signal,
			onSessionEvent: (event) =>
				options.progress.recordSessionEvent("llm2", event),
		});
		runners.push(llm2Runner);
		return await runCouncilIterations({
			llm1: createParticipantState("llm1", options.runtime.llm1, llm1Runner),
			llm2: createParticipantState("llm2", options.runtime.llm2, llm2Runner),
			question: options.question,
			config: options.config,
			signal: options.signal,
			ctx: options.ctx,
			contextFiles: options.contextFiles,
			externalContextPackage: preparedContext.contextPackage,
			progress: options.progress,
			remainingIterations: options.config.participantIterationLimit,
		});
	} finally {
		await Promise.allSettled(runners.map((runner) => runner.dispose()));
		await participantSessions.cleanup();
	}
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
	const selectedNames = new Set(
		toolsValue.split(",").filter((toolName) => toolName.length > 0),
	);
	return availableTools
		.filter((tool) => selectedNames.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
}

/** Prepares the external context package so both first participant requests fit their budgets. */
async function prepareExternalContextForFirstPrompt(options: {
	readonly externalContextPackage: string;
	readonly generateContextSummary?: ContextSummaryGenerator | undefined;
	readonly config: ConveneCouncilConfig;
	readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
	readonly ctx: ExecuteConveneCouncilOptions["ctx"];
	readonly question: string;
	readonly runtime: CouncilRuntime;
	readonly signal: AbortSignal | undefined;
	readonly tools: readonly Tool[];
}): Promise<{ readonly contextPackage: string } | { readonly issue: string }> {
	if (firstParticipantRequestsFit(options, options.externalContextPackage)) {
		return { contextPackage: options.externalContextPackage };
	}

	const summaryRuntime = resolveContextSummaryRuntime(
		options.ctx,
		options.config,
		options.runtime.llm1.thinking,
	);
	if ("issue" in summaryRuntime) {
		return summaryRuntime;
	}

	const reserveTokens = calculateSummaryReserveTokens(options);
	if (reserveTokens <= 0) {
		return { issue: COUNCIL_CONTEXT_TOO_LARGE_ERROR };
	}

	const summaryInputIssue = validateSummaryInputSize({
		contextPackage: options.externalContextPackage,
		runtime: summaryRuntime.runtime,
		reserveTokens,
	});
	if (summaryInputIssue !== undefined) {
		return { issue: summaryInputIssue };
	}

	const summaryGenerator =
		options.generateContextSummary ?? defaultContextSummary;
	const summary = await summaryGenerator({
		contextPackage: options.externalContextPackage,
		runtime: summaryRuntime.runtime,
		reserveTokens,
		signal: options.signal,
		ctx: options.ctx,
	});
	const summarizedContextPackage = `<context>\n<summary>\n${escapeUTF8(summary)}\n</summary>\n</context>`;
	return firstParticipantRequestsFit(options, summarizedContextPackage)
		? { contextPackage: summarizedContextPackage }
		: { issue: COUNCIL_CONTEXT_TOO_LARGE_ERROR };
}

/** Returns true when both participant first requests fit the configured budget. */
function firstParticipantRequestsFit(
	options: {
		readonly config: ConveneCouncilConfig;
		readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
		readonly question: string;
		readonly runtime: CouncilRuntime;
		readonly tools: readonly Tool[];
	},
	contextPackage: string,
): boolean {
	return [options.runtime.llm1, options.runtime.llm2].every((runtime) => {
		const estimate = estimateFirstParticipantRequestTokens({
			contextFiles: options.contextFiles,
			contextPackage,
			question: options.question,
			runtime,
			tools: options.tools,
		});
		return estimate <= getParticipantTokenLimit(runtime, options.config);
	});
}

/** Estimates the model-visible first request for one participant. */
function estimateFirstParticipantRequestTokens(options: {
	readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
	readonly contextPackage: string;
	readonly question: string;
	readonly runtime: ParticipantRuntime;
	readonly tools: readonly Tool[];
}): number {
	const context: Context = {
		systemPrompt: buildParticipantSystemPrompt(
			options.contextFiles,
			options.tools.map((tool) => tool.name),
		),
		messages: [
			{
				role: "user",
				content: buildInitialOpinionTask(
					options.question,
					options.contextPackage,
				),
				timestamp: Date.now(),
			},
		],
		tools: [...options.tools],
	};
	return estimateSerializedInputTokens(
		context,
		options.runtime.model.id,
		options.runtime.model.provider,
	);
}

/** Returns the configured first-request token budget for one participant. */
function getParticipantTokenLimit(
	runtime: ParticipantRuntime,
	config: ConveneCouncilConfig,
): number {
	return Math.floor(
		runtime.model.contextWindow * config.contextWindowUsageLimit,
	);
}

/** Computes the summary output reserve from the stricter participant budget. */
function calculateSummaryReserveTokens(options: {
	readonly config: ConveneCouncilConfig;
	readonly contextFiles: ExecuteConveneCouncilOptions["contextFiles"];
	readonly question: string;
	readonly runtime: CouncilRuntime;
	readonly tools: readonly Tool[];
}): number {
	const emptyContextPackage = "<context>\n</context>";
	return Math.min(
		...([options.runtime.llm1, options.runtime.llm2] as const).map(
			(runtime) =>
				getParticipantTokenLimit(runtime, options.config) -
				estimateFirstParticipantRequestTokens({
					contextFiles: options.contextFiles,
					contextPackage: emptyContextPackage,
					question: options.question,
					runtime,
					tools: options.tools,
				}),
		),
	);
}

/** Uses Pi compaction summarization for the rendered external context package. */
async function defaultContextSummary(
	request: Parameters<ContextSummaryGenerator>[0],
): Promise<string> {
	const auth = await request.ctx.modelRegistry.getApiKeyAndHeaders(
		request.runtime.model,
	);
	if (!auth.ok) {
		throw new Error(`context summary model auth unavailable: ${auth.error}`);
	}
	return generateSummary(
		[createSummarySourceMessage(request.contextPackage) as AgentMessage],
		request.runtime.model,
		request.reserveTokens,
		auth.apiKey ?? "",
		auth.headers,
		request.signal,
		undefined,
		undefined,
		request.runtime.thinking,
	);
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
		task: buildInitialOpinionTask(
			options.question,
			options.externalContextPackage,
		),
		config: options.config,
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
		task: buildInitialOpinionTask(
			options.question,
			options.externalContextPackage,
		),
		config: options.config,
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
