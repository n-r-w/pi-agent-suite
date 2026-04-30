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
	buildFinalAnswerRepairInstruction,
	buildFinalAnswerSystemPrompt,
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
	ParticipantRequestOptions,
	ParticipantRuntime,
	ParticipantState,
} from "./types";

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
	const { participant, task, config, completeSimple, signal } = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue(
			`${participant.id} returned unusable participant output.`,
		);
	}

	const taskMessage = createTaskMessage(
		attempt === 0 ? task : `${task}\n\n${buildParticipantRepairInstruction()}`,
	);
	const context = buildParticipantContext(participant, taskMessage);
	if (!doesInputFitContextWindow(context, participant.runtime.model)) {
		return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	}

	const providerResult = await callProviderWithRetries({
		completeSimple,
		runtime: participant.runtime,
		context,
		config,
		signal,
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
	const { participant, task, config, completeSimple, signal } = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue("Council returned an unusable final answer.");
	}

	const taskMessage = createTaskMessage(
		attempt === 0 ? task : `${task}\n\n${buildFinalAnswerRepairInstruction()}`,
	);
	const context = buildFinalAnswerContext(participant, taskMessage);
	if (!doesInputFitContextWindow(context, participant.runtime.model)) {
		return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	}

	const providerResult = await callProviderWithRetries({
		completeSimple,
		runtime: participant.runtime,
		context,
		config,
		signal,
	});
	if ("kind" in providerResult) {
		return providerResult;
	}

	const answer = getAssistantText(providerResult.message);
	if (isValidFinalAnswer(answer)) {
		return { answer };
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
): Context {
	return {
		systemPrompt: buildFinalAnswerSystemPrompt(),
		messages: [...participant.history, taskMessage],
		tools: [],
	};
}

/** Builds one participant provider context while keeping the final task last. */
function buildParticipantContext(
	participant: ParticipantState,
	taskMessage: Message,
): Context {
	return {
		systemPrompt: buildParticipantSystemPrompt(participant.id),
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
	readonly context: Context;
	readonly config: ConveneCouncilConfig;
	readonly signal: AbortSignal | undefined;
}
