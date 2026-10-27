import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	type AuxiliaryLlmCompletion,
	type AuxiliaryLlmContext,
	type AuxiliaryLlmRuntime,
	buildAuxiliaryLlmOptions,
	completeAuxiliaryLlm,
	getAuxiliaryLlmResponseText,
	resolveAuxiliaryLlmRuntime,
	withoutSystemMessages,
} from "./auxiliary-llm";
import { isReasoningLevel } from "./reasoning-levels";
import {
	buildRetryConfig,
	createRetryableExternalError,
	isAbortError,
	withRetry,
} from "./retry";
import {
	doesContextFitModel,
	readPromptFile,
	type ToolResultSummaryConfig,
} from "./tool-result-summary";

/** Directory that stores the bundled prompts of the current-task request. */
const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

/** Bundled system prompt that defines the role of the task model. */
const DEFAULT_TASKS_SYSTEM_PROMPT_FILE = join(
	PROMPT_DIR,
	"projection-tasks-system.md",
);

/** Bundled user prompt appended after the session messages. */
const DEFAULT_TASKS_USER_PROMPT_FILE = join(
	PROMPT_DIR,
	"projection-tasks-user.md",
);

/** Issue text for a task prompt file that cannot be read or is empty. */
const TASKS_PROMPT_ISSUE = "task prompt file is unreadable or empty";

/** Issue text for a session that does not fit into the context window of the task model. */
const TASKS_CONTEXT_TOO_LARGE_ISSUE =
	"session does not fit into the context window of the task model";

/** Issue text for a task response without visible text. */
const TASKS_EMPTY_RESPONSE_ISSUE = "task response did not contain text";

/** Issue text for a task response that the provider reported as an error. */
const TASKS_PROVIDER_ISSUE = "task provider returned an error";

/** Inputs of one current-task request. */
export interface ProjectionTasksRequestOptions {
	/** Session as the main agent sees it at this point. */
	readonly messages: readonly AgentMessage[];
	/** Current model and model registry used to resolve the task model and its auth. */
	readonly modelContext: AuxiliaryLlmContext;
	/** Summary settings: task model and prompt files, retry settings, and the fallback summary model. */
	readonly config: ToolResultSummaryConfig;
	/** Current thinking level of the main agent. */
	readonly currentThinking: string | undefined;
	readonly signal: AbortSignal | undefined;
	readonly completeSimple: AuxiliaryLlmCompletion;
	/** Receives each task model response so the caller can publish its usage. */
	readonly recordCost: (message: AssistantMessage) => void;
}

/** Outcome of one current-task request: the task text, a failure with its issue text, or a user abort. */
export type ProjectionTasksResult =
	| { readonly kind: "success"; readonly text: string }
	| { readonly kind: "failure"; readonly issue: string }
	| { readonly kind: "aborted" };

/** Asks the task model for the current tasks and goal of the agent from the whole session. */
export async function requestProjectionTasks({
	messages,
	modelContext,
	config,
	currentThinking,
	signal,
	completeSimple,
	recordCost,
}: ProjectionTasksRequestOptions): Promise<ProjectionTasksResult> {
	if (isSignalAborted(signal)) {
		return { kind: "aborted" };
	}

	// summary.tasks.model replaces summary.model as a whole; its omitted fields fall back to the current model and thinking.
	const modelSettings = config.tasks?.model ?? config.model;
	const resolved = await resolveAuxiliaryLlmRuntime(
		modelContext,
		modelSettings?.id,
		modelSettings?.thinking,
		isReasoningLevel(currentThinking) ? currentThinking : undefined,
	);
	if ("issue" in resolved) {
		return { kind: "failure", issue: resolved.issue };
	}

	const [systemPrompt, userPrompt] = await Promise.all([
		readPromptFile(
			config.tasks?.systemPromptFile ?? DEFAULT_TASKS_SYSTEM_PROMPT_FILE,
		),
		readPromptFile(
			config.tasks?.userPromptFile ?? DEFAULT_TASKS_USER_PROMPT_FILE,
		),
	]);
	if (systemPrompt === undefined || userPrompt === undefined) {
		return { kind: "failure", issue: TASKS_PROMPT_ISSUE };
	}

	const context: Context = {
		systemPrompt,
		messages: [
			...convertToLlm(withoutSystemMessages(messages)),
			{ role: "user", content: userPrompt, timestamp: Date.now() },
		],
		tools: [],
	};
	if (!doesContextFitModel(context, resolved.runtime.model)) {
		return { kind: "failure", issue: TASKS_CONTEXT_TOO_LARGE_ISSUE };
	}

	let lastIssue = TASKS_PROVIDER_ISSUE;
	try {
		const text = await withRetry(
			async () => {
				const attempt = await attemptTasksRequest({
					completeSimple,
					runtime: resolved.runtime,
					context,
					options: buildAuxiliaryLlmOptions(
						resolved.thinking,
						signal,
						resolved.runtime,
					),
					recordCost,
				});
				if (attempt.kind === "success") {
					return attempt.text;
				}
				if (attempt.kind === "aborted") {
					throw new DOMException("task request aborted", "AbortError");
				}
				lastIssue = attempt.issue;
				throw createRetryableExternalError(attempt.issue);
			},
			{
				retry: buildRetryConfig({
					maxRetries: config.retryCount,
					baseDelayMs: config.retryDelayMs,
				}),
				signal,
				factor: 1,
			},
		);
		return { kind: "success", text };
	} catch (error) {
		return isSignalAborted(signal) || isAbortError(error)
			? { kind: "aborted" }
			: { kind: "failure", issue: lastIssue };
	}
}

/** Result of one task request attempt before the retry policy applies. */
type TasksAttemptResult =
	| { readonly kind: "success"; readonly text: string }
	| { readonly kind: "failure"; readonly issue: string }
	| { readonly kind: "aborted" };

/** Sends one task request and classifies its response or thrown error. */
async function attemptTasksRequest({
	completeSimple,
	runtime,
	context,
	options,
	recordCost,
}: {
	readonly completeSimple: AuxiliaryLlmCompletion;
	readonly runtime: AuxiliaryLlmRuntime;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
	readonly recordCost: (message: AssistantMessage) => void;
}): Promise<TasksAttemptResult> {
	try {
		const response = await completeAuxiliaryLlm(
			completeSimple,
			runtime,
			context,
			options,
		);
		recordCost(response);
		return classifyTasksResponse(response, options.signal);
	} catch (error) {
		return isSignalAborted(options.signal) || isAbortError(error)
			? { kind: "aborted" }
			: {
					kind: "failure",
					issue: error instanceof Error ? error.message : String(error),
				};
	}
}

/** Turns one task model response into an attempt result. */
function classifyTasksResponse(
	response: AssistantMessage,
	signal: AbortSignal | undefined,
): TasksAttemptResult {
	if (isSignalAborted(signal) || response.stopReason === "aborted") {
		return { kind: "aborted" };
	}
	if (response.stopReason === "error") {
		return {
			kind: "failure",
			issue: response.errorMessage ?? TASKS_PROVIDER_ISSUE,
		};
	}

	const text = getAuxiliaryLlmResponseText(response);
	return text.length === 0
		? { kind: "failure", issue: TASKS_EMPTY_RESPONSE_ISSUE }
		: { kind: "success", text };
}

/** Reads the current cancellation state, which can change during an asynchronous request. */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Describes a failed task request for the user, naming the issue and the fallback; each extension adds its own prefix. */
export function formatProjectionTasksFailure(issue: string): string {
	return `current tasks request failed (${issue}); summaries are written without current tasks`;
}
