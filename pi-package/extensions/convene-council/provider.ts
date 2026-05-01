import type {
	Context,
	Message,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { COUNCIL_CONTEXT_TOO_LARGE_ERROR } from "./constants";
import { formatError } from "./guards";
import {
	getAssistantText,
	isValidFinalAnswer,
	parseParticipantResponse,
} from "./parser";
import {
	buildFinalAnswerSystemPrompt,
	buildInitialParticipantSystemPrompt,
	buildParticipantRepairInstruction,
	buildParticipantSystemPrompt,
	createTaskMessage,
} from "./prompts";
import type {
	AcceptedParticipantResponse,
	ConveneCouncilConfig,
	ConveneCouncilDependencies,
	CouncilIssue,
	FinalAnswerRequestOptions,
	InitialOpinionRequestOptions,
	MissingInformationResponseRequestOptions,
	ParticipantRequestOptions,
	ParticipantRuntime,
	ParticipantState,
	PlainParticipantRequestOptions,
	ProjectContextFile,
} from "./types";

/** Requests one first-turn free-form participant opinion with response-defect retries. */
export function requestInitialOpinion(
	options: InitialOpinionRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestPlainParticipantResponse(
		options,
		0,
		`${options.participant.id} returned an unusable initial opinion.`,
	);
}

/** Requests one free-form missing-information clarification with response-defect retries. */
export function requestMissingInformationResponse(
	options: MissingInformationResponseRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestPlainParticipantResponse(
		options,
		0,
		`${options.participant.id} returned an unusable clarification.`,
	);
}

/** Executes one free-form participant attempt and recurses only when repair is allowed. */
async function requestPlainParticipantResponse(
	options: PlainParticipantRequestOptions,
	attempt: number,
	failureMessage: string,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	const {
		participant,
		task,
		config,
		completeSimple,
		signal,
		contextFiles,
		progress,
	} = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue(failureMessage);
	}

	const taskMessage = createTaskMessage(task);
	const context = buildPlainParticipantContext(
		participant,
		taskMessage,
		contextFiles,
	);
	if (!doesInputFitContextWindow(context, participant.runtime.model)) {
		return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	}

	const providerResult = await callProviderWithRetries({
		completeSimple,
		runtime: participant.runtime,
		participantId: participant.id,
		context,
		config,
		signal,
		progress,
	});
	if ("kind" in providerResult) {
		return providerResult;
	}

	const opinion = getAssistantText(providerResult.message);
	if (opinion.length > 0) {
		return {
			response: { opinion },
			assistantMessage: providerResult.message,
			taskMessage,
		};
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestPlainParticipantResponse(options, attempt + 1, failureMessage);
}

/** Requests one structured participant discussion response with response-defect repair retries. */
export function requestParticipantDiscussion(
	options: ParticipantRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestParticipantDiscussionAttempt(options, 0);
}

/** Executes one participant response-defect attempt and recurses only when repair is allowed. */
async function requestParticipantDiscussionAttempt(
	options: ParticipantRequestOptions,
	attempt: number,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	const {
		participant,
		task,
		config,
		completeSimple,
		signal,
		contextFiles,
		progress,
	} = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue(
			`${participant.id} returned unusable participant output.`,
		);
	}

	const taskMessage = createTaskMessage(
		attempt === 0 ? task : `${task}\n\n${buildParticipantRepairInstruction()}`,
	);
	const context = buildParticipantContext(
		participant,
		taskMessage,
		contextFiles,
	);
	if (!doesInputFitContextWindow(context, participant.runtime.model)) {
		return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	}

	const providerResult = await callProviderWithRetries({
		completeSimple,
		runtime: participant.runtime,
		participantId: participant.id,
		context,
		config,
		signal,
		progress,
	});
	if ("kind" in providerResult) {
		return providerResult;
	}

	const parsed = parseParticipantResponse(providerResult.message);
	if (
		"response" in parsed &&
		(options.requiredStatus === undefined ||
			parsed.response.status === options.requiredStatus)
	) {
		return {
			response: parsed.response,
			assistantMessage: providerResult.message,
			taskMessage,
		};
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestParticipantDiscussionAttempt(options, attempt + 1);
}

/** Requests one final answer and rejects empty or tagged final output. */
export function requestFinalAnswer(
	options: FinalAnswerRequestOptions,
): Promise<{ readonly answer: string } | CouncilIssue> {
	return requestFinalAnswerAttempt(options, 0);
}

/** Executes one final-answer defect attempt and recurses only when repair is allowed. */
async function requestFinalAnswerAttempt(
	options: FinalAnswerRequestOptions,
	attempt: number,
): Promise<{ readonly answer: string } | CouncilIssue> {
	const {
		participant,
		task,
		config,
		completeSimple,
		signal,
		contextFiles,
		progress,
	} = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue("Council returned an unusable final answer.");
	}

	const taskMessage = createTaskMessage(task);
	const context = buildFinalAnswerContext(
		participant,
		taskMessage,
		contextFiles,
	);
	if (!doesInputFitContextWindow(context, participant.runtime.model)) {
		return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	}

	const providerResult = await callProviderWithRetries({
		completeSimple,
		runtime: participant.runtime,
		participantId: participant.id,
		context,
		config,
		signal,
		progress,
	});
	if ("kind" in providerResult) {
		return providerResult;
	}

	const answer = getAssistantText(providerResult.message);
	if (isValidFinalAnswer(answer)) {
		return { answer };
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestFinalAnswerAttempt(options, attempt + 1);
}

/** Calls the model provider and retries thrown request failures. */
function callProviderWithRetries(
	options: ProviderRequestOptions,
): Promise<
	| { readonly message: Awaited<ReturnType<typeof options.completeSimple>> }
	| CouncilIssue
> {
	return callProviderAttempt(options, 0);
}

/** Executes one provider call attempt and recurses only after a failed retryable request. */
async function callProviderAttempt(
	options: ProviderRequestOptions,
	attempt: number,
): Promise<
	| { readonly message: Awaited<ReturnType<typeof options.completeSimple>> }
	| CouncilIssue
> {
	if (isSignalAborted(options.signal)) {
		return toolErrorIssue("provider request aborted");
	}

	try {
		return {
			message: await options.completeSimple(
				options.runtime.model,
				options.context,
				buildParticipantOptions(options.runtime, options.signal),
			),
		};
	} catch (error) {
		if (isSignalAborted(options.signal)) {
			return toolErrorIssue(`provider request failed: ${formatError(error)}`);
		}
		if (attempt >= options.config.providerRequestRetries) {
			return toolErrorIssue(`provider request failed: ${formatError(error)}`);
		}

		options.progress?.recordProviderRetry(
			options.participantId,
			attempt + 1,
			options.config.providerRequestRetries,
		);
		await waitForRetryDelay(
			options.config.providerRetryDelayMs,
			options.signal,
		);
		if (isSignalAborted(options.signal)) {
			return toolErrorIssue(`provider request failed: ${formatError(error)}`);
		}
		return callProviderAttempt(options, attempt + 1);
	}
}

/** Returns true when cancellation has been requested before another provider attempt. */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Waits between provider retry attempts and respects parent cancellation. */
async function waitForRetryDelay(
	delayMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (delayMs === 0 || signal?.aborted === true) {
		return;
	}
	await new Promise<void>((resolve) => {
		const finish = (): void => {
			if (signal !== undefined) {
				signal.removeEventListener("abort", onAbort);
			}
			resolve();
		};
		const onAbort = (): void => {
			clearTimeout(timeout);
			finish();
		};
		const timeout = setTimeout(finish, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Builds one final-answer provider context without participant XML output rules. */
function buildFinalAnswerContext(
	participant: ParticipantState,
	taskMessage: Message,
	contextFiles: readonly ProjectContextFile[],
): Context {
	return {
		systemPrompt: buildFinalAnswerSystemPrompt(contextFiles),
		messages: [...participant.history, taskMessage],
		tools: [],
	};
}

/** Builds one free-form participant context without structured output rules. */
function buildPlainParticipantContext(
	participant: ParticipantState,
	taskMessage: Message,
	contextFiles: readonly ProjectContextFile[],
): Context {
	return {
		systemPrompt: buildInitialParticipantSystemPrompt(contextFiles),
		messages: [...participant.history, taskMessage],
		tools: [],
	};
}

/** Builds one participant provider context while keeping the final task last. */
function buildParticipantContext(
	participant: ParticipantState,
	taskMessage: Message,
	contextFiles: readonly ProjectContextFile[],
): Context {
	return {
		systemPrompt: buildParticipantSystemPrompt(contextFiles),
		messages: [...participant.history, taskMessage],
		tools: [],
	};
}

/** Builds provider options for one participant request. */
function buildParticipantOptions(
	runtime: ParticipantRuntime,
	signal: AbortSignal | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {};
	if (signal !== undefined) {
		options.signal = signal;
	}
	if (runtime.apiKey !== undefined) {
		options.apiKey = runtime.apiKey;
	}
	if (runtime.headers !== undefined) {
		options.headers = runtime.headers;
	}
	if (runtime.thinking !== undefined && runtime.thinking !== "off") {
		options.reasoning = runtime.thinking;
	}
	return options;
}

/** Returns true when the estimated model input fits the resolved model window. */
function doesInputFitContextWindow(
	context: Context,
	runtimeModel: ParticipantRuntime["model"],
): boolean {
	return (
		estimateSerializedInputTokens(
			context,
			runtimeModel.id,
			runtimeModel.provider,
		) <= runtimeModel.contextWindow
	);
}

/** Builds one logical issue that should be returned as a normal text result. */
function logicalIssue(message: string): CouncilIssue {
	return { kind: "logical", message };
}

/** Builds one infrastructure issue that should be surfaced as a Pi tool error. */
function toolErrorIssue(message: string): CouncilIssue {
	return { kind: "tool-error", message };
}

interface ProviderRequestOptions {
	readonly completeSimple: NonNullable<
		ConveneCouncilDependencies["completeSimple"]
	>;
	readonly runtime: ParticipantRuntime;
	readonly participantId: ParticipantState["id"];
	readonly context: Context;
	readonly config: ConveneCouncilConfig;
	readonly signal: AbortSignal | undefined;
	readonly progress: ParticipantRequestOptions["progress"];
}
