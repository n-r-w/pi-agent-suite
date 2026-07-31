import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	Context,
	AssistantMessage as LlmAssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { extractDiagnosticError } from "@earendil-works/pi-ai";
import { escapeUTF8 } from "entities";
import {
	countProjectionTextTokens,
	estimateSerializedInputTokens,
} from "./context-size";
import { isReasoningLevel, type ReasoningLevel } from "./reasoning-levels";
import {
	buildRetryConfig,
	createRetryableExternalError,
	isAbortError,
	withRetry,
} from "./retry";

/** Directory that stores shared prompts for one-tool-result summaries. */
const DEFAULT_PROMPT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

/** Shared system prompt used to define the summary role. */
const DEFAULT_SUMMARY_SYSTEM_PROMPT_FILE = join(
	DEFAULT_PROMPT_DIR,
	"tool-result-summary-system.md",
);

/** Shared user prompt appended after the tool result data. */
const DEFAULT_SUMMARY_USER_PROMPT_FILE = join(
	DEFAULT_PROMPT_DIR,
	"tool-result-summary-user.md",
);

/** Config key that enables summary generation. */
const SUMMARY_ENABLED_CONFIG_KEY = "enabled";

/** Config key for the model used by summary generation. */
const SUMMARY_MODEL_CONFIG_KEY = "model";

/** Config key for the thinking level used by summary generation. */
const SUMMARY_THINKING_CONFIG_KEY = "thinking";

/** Config key for the maximum number of concurrent summary requests. */
const SUMMARY_MAX_CONCURRENCY_CONFIG_KEY = "maxConcurrency";

/** Config key for retry attempts after the first summary request fails. */
const SUMMARY_RETRY_COUNT_CONFIG_KEY = "retryCount";

/** Config key for the pause between summary retry attempts in milliseconds. */
const SUMMARY_RETRY_DELAY_MS_CONFIG_KEY = "retryDelayMs";

/** Config key for the custom summary system prompt path. */
const SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY = "systemPromptFile";

/** Config key for the custom summary user prompt path. */
const SUMMARY_USER_PROMPT_FILE_CONFIG_KEY = "userPromptFile";

/** Default summary request concurrency. */
const DEFAULT_SUMMARY_MAX_CONCURRENCY = 1;

/** Default retry attempts after the first failed summary request. */
const DEFAULT_SUMMARY_RETRY_COUNT = 1;

/** Default pause between summary retry attempts. */
const DEFAULT_SUMMARY_RETRY_DELAY_MS = 5_000;

/** Maximum persisted provider error message length. */
const SUMMARY_DIAGNOSTIC_ERROR_MESSAGE_LIMIT = 2_000;

/** Whitespace collapsed in persisted provider error messages. */
const SUMMARY_DIAGNOSTIC_WHITESPACE_PATTERN = /\s+/g;

/** Diagnostic message for summary inputs that exceed the selected model window. */
const SUMMARY_CONTEXT_TOO_LARGE_ERROR =
	"summary request exceeds model context window";

/** Diagnostic message for requests cancelled before a provider response. */
const SUMMARY_ABORTED_ERROR = "summary request aborted";

/** Diagnostic fallback when a provider returns an error response without details. */
const SUMMARY_PROVIDER_ERROR = "summary provider returned an error";

/** Diagnostic message for responses without visible summary text. */
const SUMMARY_EMPTY_RESPONSE_ERROR = "summary response did not contain text";

/** Config keys accepted by the summary config object. */
const TOOL_RESULT_SUMMARY_CONFIG_KEYS = [
	SUMMARY_ENABLED_CONFIG_KEY,
	SUMMARY_MODEL_CONFIG_KEY,
	SUMMARY_THINKING_CONFIG_KEY,
	SUMMARY_MAX_CONCURRENCY_CONFIG_KEY,
	SUMMARY_RETRY_COUNT_CONFIG_KEY,
	SUMMARY_RETRY_DELAY_MS_CONFIG_KEY,
	SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY,
	SUMMARY_USER_PROMPT_FILE_CONFIG_KEY,
] as const;

/** Runtime thinking values accepted by shared tool-result summarization. */
export type ToolResultSummaryThinking = ReasoningLevel;

/** Configuration shared by context-projection and custom-compaction helper summaries. */
export interface ToolResultSummaryConfig {
	readonly enabled: boolean;
	readonly model?: string;
	readonly thinking?: ToolResultSummaryThinking;
	readonly maxConcurrency: number;
	readonly retryCount: number;
	readonly retryDelayMs: number;
	readonly systemPromptFile?: string;
	readonly userPromptFile?: string;
}

/** Fields accepted after enabled summary defaults are applied. */
interface EnabledSummaryConfigValues {
	readonly maxConcurrency: number;
	readonly retryCount: number;
	readonly retryDelayMs: number;
	readonly model?: string;
	readonly thinking?: ToolResultSummaryThinking;
	readonly systemPromptFile?: string;
	readonly userPromptFile?: string;
}

/** Registry methods needed to resolve helper summary models and auth. */
export interface ToolResultSummaryModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| {
				readonly ok: true;
				readonly apiKey?: string;
				readonly headers?: Record<string, string>;
		  }
		| { readonly ok: false; readonly error: string }
	>;
}

/** Runtime request data for one-tool-result helper summaries. */
export interface ToolResultSummaryRuntimeConfig {
	readonly model: Model<Api>;
	readonly thinking: ToolResultSummaryThinking | undefined;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly options: SimpleStreamOptions;
}

/** Source message paired with a stable identifier for deterministic replacement. */
export interface ToolResultSummarySource {
	readonly id: string;
	readonly message: AgentMessage;
}

/** Tool result that can be summarized independently from the rest of the conversation. */
export interface ToolResultSummaryCandidate {
	readonly id: string;
	readonly text: string;
	readonly message: Extract<AgentMessage, { role: "toolResult" }>;
	readonly toolCallContext: string | undefined;
}

/** Completion function used by helper summary requests. */
export type ToolResultSummaryCompleteSimple = <T extends Api>(
	model: Model<T>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<LlmAssistantMessage>;

/** Failure classes persisted for failed tool-result summary attempts. */
export type ToolResultSummaryFailureKind =
	| "context-too-large"
	| "aborted"
	| "provider-error"
	| "empty-response"
	| "exception";

/** Safe diagnostic fields produced by one failed tool-result summary attempt. */
export interface ToolResultSummaryAttemptFailure {
	readonly failureKind: ToolResultSummaryFailureKind;
	readonly errorMessage: string;
	readonly errorName?: string;
	readonly errorCode?: string | number;
}

/** Result returned by one summary attempt before retry policy is applied. */
type SummaryAttemptResult =
	| { readonly kind: "success"; readonly summary: string }
	| {
			readonly kind: "retryable" | "fatal";
			readonly failure: ToolResultSummaryAttemptFailure;
	  };

/** Parses optional summary config while allowing callers to choose the default enabled state. */
export function parseToolResultSummaryConfig(
	config: unknown,
	options: { readonly defaultEnabled: boolean },
): ToolResultSummaryConfig | undefined {
	if (config === undefined) {
		return createDefaultToolResultSummaryConfig(options.defaultEnabled);
	}
	if (!isRecord(config)) {
		return undefined;
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!TOOL_RESULT_SUMMARY_CONFIG_KEYS.includes(
				key as (typeof TOOL_RESULT_SUMMARY_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return undefined;
	}

	const enabled = config[SUMMARY_ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return undefined;
	}
	if (enabled === false || (enabled === undefined && !options.defaultEnabled)) {
		return createDefaultToolResultSummaryConfig(false);
	}

	const model = config[SUMMARY_MODEL_CONFIG_KEY];
	const thinking = config[SUMMARY_THINKING_CONFIG_KEY];
	const maxConcurrency =
		config[SUMMARY_MAX_CONCURRENCY_CONFIG_KEY] ??
		DEFAULT_SUMMARY_MAX_CONCURRENCY;
	const retryCount =
		config[SUMMARY_RETRY_COUNT_CONFIG_KEY] ?? DEFAULT_SUMMARY_RETRY_COUNT;
	const retryDelayMs =
		config[SUMMARY_RETRY_DELAY_MS_CONFIG_KEY] ?? DEFAULT_SUMMARY_RETRY_DELAY_MS;
	const systemPromptFile = config[SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY];
	const userPromptFile = config[SUMMARY_USER_PROMPT_FILE_CONFIG_KEY];
	const values = parseEnabledSummaryConfigValues({
		model,
		thinking,
		maxConcurrency,
		retryCount,
		retryDelayMs,
		systemPromptFile,
		userPromptFile,
	});
	if (values === undefined) {
		return undefined;
	}

	return {
		enabled: true,
		...values,
	};
}

/** Builds default summary config for callers that omit the summary object. */
export function createDefaultToolResultSummaryConfig(
	enabled: boolean,
): ToolResultSummaryConfig {
	return {
		enabled,
		maxConcurrency: DEFAULT_SUMMARY_MAX_CONCURRENCY,
		retryCount: DEFAULT_SUMMARY_RETRY_COUNT,
		retryDelayMs: DEFAULT_SUMMARY_RETRY_DELAY_MS,
	};
}

/** Selects the model, thinking level, auth, and prompts used for one-tool-result summaries. */
export async function resolveToolResultSummaryRuntimeConfig({
	currentModel,
	modelRegistry,
	config,
	currentThinking,
	signal,
}: {
	readonly currentModel: Model<Api> | undefined;
	readonly modelRegistry: ToolResultSummaryModelRegistry;
	readonly config: ToolResultSummaryConfig;
	readonly currentThinking: string | undefined;
	readonly signal: AbortSignal | undefined;
}): Promise<ToolResultSummaryRuntimeConfig | undefined> {
	const model = selectSummaryModel(currentModel, modelRegistry, config);
	if (model === undefined) {
		return undefined;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return undefined;
	}

	const prompts = await readSummaryPrompts(config);
	if (prompts === undefined) {
		return undefined;
	}

	const thinking =
		config.thinking ?? parseToolResultSummaryThinking(currentThinking);
	const requestOptions: SimpleStreamOptions = {};
	if (signal !== undefined) {
		requestOptions.signal = signal;
	}
	if (auth.apiKey !== undefined) {
		requestOptions.apiKey = auth.apiKey;
	}
	if (auth.headers !== undefined) {
		requestOptions.headers = auth.headers;
	}
	if (thinking !== undefined && thinking !== "off") {
		requestOptions.reasoning = thinking;
	}

	return { model, thinking, ...prompts, options: requestOptions };
}

/** Collects successful text tool results that are large enough for helper summarization. */
export function collectToolResultSummaryCandidates(
	sources: readonly ToolResultSummarySource[],
	minToolResultTokens: number,
): ToolResultSummaryCandidate[] {
	const toolCallContextById = collectToolCallContextById(
		sources.map((source) => source.message),
	);
	const candidates: ToolResultSummaryCandidate[] = [];
	for (const { id, message } of sources) {
		if (message.role !== "toolResult") {
			continue;
		}
		const text = getToolResultText(message);
		if (text === undefined) {
			continue;
		}
		if (countProjectionTextTokens(text) < minToolResultTokens) {
			continue;
		}

		candidates.push({
			id,
			text,
			message,
			toolCallContext: toolCallContextById.get(message.toolCallId),
		});
	}

	return candidates;
}

/** Retries transient summary failures before giving up on a generated summary. */
export async function summarizeToolResultCandidateWithRetries({
	candidate,
	runtimeConfig,
	sessionId,
	completeSimple,
	config,
	recordCost,
	onRequest,
	onAttemptFailure,
	onRetryAttempt,
	onRetryScheduled,
}: {
	readonly candidate: ToolResultSummaryCandidate;
	readonly runtimeConfig: ToolResultSummaryRuntimeConfig;
	readonly sessionId: string;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly config: ToolResultSummaryConfig;
	readonly recordCost: (message: LlmAssistantMessage) => void;
	readonly onRequest?: () => void | Promise<void>;
	readonly onAttemptFailure: (
		candidate: ToolResultSummaryCandidate,
		failure: ToolResultSummaryAttemptFailure,
		attempt: number,
		totalAttempts: number,
	) => void;
	readonly onRetryAttempt?: () => void;
	readonly onRetryScheduled?: (
		nextAttempt: number,
		totalAttempts: number,
	) => void | Promise<void>;
}): Promise<string | undefined> {
	const totalAttempts = config.retryCount + 1;
	let attempt = 0;
	try {
		return await withRetry(
			async () => {
				attempt += 1;
				if (attempt > 1) {
					onRetryAttempt?.();
				}

				const result = await summarizeToolResultCandidate({
					candidate,
					runtimeConfig,
					sessionId,
					completeSimple,
					recordCost,
					...(onRequest === undefined ? {} : { onRequest }),
				});
				if (result.kind === "success") {
					return result.summary;
				}

				onAttemptFailure(candidate, result.failure, attempt, totalAttempts);
				if (result.kind === "fatal") {
					throw new DOMException("summary request aborted", "AbortError");
				}

				throw createRetryableExternalError(
					"summary provider returned an error",
				);
			},
			{
				retry: buildRetryConfig(
					{
						maxRetries: config.retryCount,
						baseDelayMs: config.retryDelayMs,
					},
					{ maxRetries: config.retryCount, baseDelayMs: config.retryDelayMs },
				),
				signal: runtimeConfig.options.signal,
				factor: 1,
				onFailedAttempt: async ({ attemptNumber, retriesLeft }) => {
					if (retriesLeft > 0) {
						await onRetryScheduled?.(attemptNumber + 1, totalAttempts);
					}
				},
			},
		);
	} catch {
		return undefined;
	}
}

/** Checks request input locally to avoid provider calls that cannot fit the model window. */
export function doesContextFitModel(
	context: Context,
	model: Model<Api>,
): boolean {
	return (
		estimateSerializedInputTokens(context, model.id, model.provider) <=
		model.contextWindow
	);
}

/** Builds a tool-result message whose content contains the generated helper summary. */
export function buildSummarizedToolResultMessage(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	summary: string,
): Extract<AgentMessage, { role: "toolResult" }> {
	return {
		...message,
		content: [
			{
				type: "text",
				text: `Tool result summary:\n${summary}`,
			},
		],
	};
}

/** Maps values through an async worker pool with deterministic result ordering. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	maxConcurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
	const results: Array<R | undefined> = new Array(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(maxConcurrency, items.length);
	const runNext = async (): Promise<void> => {
		const index = nextIndex;
		nextIndex += 1;
		const item = items[index];
		if (item === undefined) {
			return;
		}

		results[index] = await mapper(item);
		return runNext();
	};

	const workers = Array.from({ length: workerCount }, () => runNext());
	await Promise.all(workers);
	return results;
}

/** Parses enabled summary fields after defaults are applied. */
function parseEnabledSummaryConfigValues({
	model,
	thinking,
	maxConcurrency,
	retryCount,
	retryDelayMs,
	systemPromptFile,
	userPromptFile,
}: {
	readonly model: unknown;
	readonly thinking: unknown;
	readonly maxConcurrency: unknown;
	readonly retryCount: unknown;
	readonly retryDelayMs: unknown;
	readonly systemPromptFile: unknown;
	readonly userPromptFile: unknown;
}): EnabledSummaryConfigValues | undefined {
	if (
		!isOptionalModelId(model) ||
		!isOptionalSummaryThinking(thinking) ||
		!isPositiveInteger(maxConcurrency) ||
		!isNonNegativeInteger(retryCount) ||
		!isNonNegativeInteger(retryDelayMs) ||
		!isOptionalNonEmptyString(systemPromptFile) ||
		!isOptionalNonEmptyString(userPromptFile)
	) {
		return undefined;
	}
	if (typeof systemPromptFile === "string" && !isAbsolute(systemPromptFile)) {
		throw new Error("summary.systemPromptFile must be an absolute path");
	}
	if (typeof userPromptFile === "string" && !isAbsolute(userPromptFile)) {
		throw new Error("summary.userPromptFile must be an absolute path");
	}

	return {
		maxConcurrency,
		retryCount,
		retryDelayMs,
		...(typeof model === "string" ? { model } : {}),
		...(isSummaryThinking(thinking) ? { thinking } : {}),
		...(typeof systemPromptFile === "string" ? { systemPromptFile } : {}),
		...(typeof userPromptFile === "string" ? { userPromptFile } : {}),
	};
}

/** Selects the configured summary model, or the active model when omitted. */
function selectSummaryModel(
	currentModel: Model<Api> | undefined,
	modelRegistry: ToolResultSummaryModelRegistry,
	config: ToolResultSummaryConfig,
): Model<Api> | undefined {
	if (config.model === undefined) {
		return currentModel;
	}

	const separatorIndex = config.model.indexOf("/");
	const provider = config.model.slice(0, separatorIndex);
	const modelId = config.model.slice(separatorIndex + 1);
	return modelRegistry.find(provider, modelId);
}

/** Reads configured summary prompts or shared defaults. */
async function readSummaryPrompts(
	config: ToolResultSummaryConfig,
): Promise<
	{ readonly systemPrompt: string; readonly userPrompt: string } | undefined
> {
	const [systemPrompt, userPrompt] = await Promise.all([
		readPromptFile(
			config.systemPromptFile ?? DEFAULT_SUMMARY_SYSTEM_PROMPT_FILE,
		),
		readPromptFile(config.userPromptFile ?? DEFAULT_SUMMARY_USER_PROMPT_FILE),
	]);
	if (systemPrompt === undefined || userPrompt === undefined) {
		return undefined;
	}

	return { systemPrompt, userPrompt };
}

/** Reads one prompt file and rejects empty content. */
async function readPromptFile(path: string): Promise<string | undefined> {
	try {
		const prompt = (await readFile(path, "utf8")).trim();
		return prompt.length === 0 ? undefined : prompt;
	} catch {
		return undefined;
	}
}

/** Collects model-visible tool-call context for summary prompts. */
function collectToolCallContextById(
	messages: readonly AgentMessage[],
): Map<string, string> {
	const contextById = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") {
				continue;
			}

			contextById.set(
				block.id,
				JSON.stringify({ name: block.name, arguments: block.arguments }),
			);
		}
	}

	return contextById;
}

/** Summarizes one projected tool result and classifies failures for retry handling. */
async function summarizeToolResultCandidate({
	candidate,
	runtimeConfig,
	sessionId,
	completeSimple,
	recordCost,
	onRequest,
}: {
	readonly candidate: ToolResultSummaryCandidate;
	readonly runtimeConfig: ToolResultSummaryRuntimeConfig;
	readonly sessionId: string;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly recordCost: (message: LlmAssistantMessage) => void;
	readonly onRequest?: () => void | Promise<void>;
}): Promise<SummaryAttemptResult> {
	const context = buildSummaryContext(candidate, runtimeConfig);
	if (!doesContextFitModel(context, runtimeConfig.model)) {
		return {
			kind: "fatal",
			failure: createSummaryAttemptFailure(
				"context-too-large",
				SUMMARY_CONTEXT_TOO_LARGE_ERROR,
			),
		};
	}
	if (runtimeConfig.options.signal?.aborted === true) {
		return {
			kind: "fatal",
			failure: createSummaryAttemptFailure("aborted", SUMMARY_ABORTED_ERROR),
		};
	}

	try {
		await onRequest?.();
		const response = await completeSimple(runtimeConfig.model, context, {
			...runtimeConfig.options,
			sessionId,
		});
		recordCost(response);
		if (response.stopReason === "error") {
			return {
				kind: "retryable",
				failure: createSummaryAttemptFailure(
					"provider-error",
					response.errorMessage ?? SUMMARY_PROVIDER_ERROR,
				),
			};
		}

		const summary = extractSummaryText(response.content);
		return summary === undefined
			? {
					kind: "retryable",
					failure: createSummaryAttemptFailure(
						"empty-response",
						SUMMARY_EMPTY_RESPONSE_ERROR,
					),
				}
			: { kind: "success", summary };
	} catch (error) {
		const aborted =
			isAbortError(error) ||
			isSummaryRequestSignalAborted(runtimeConfig.options.signal);
		return {
			kind: aborted ? "fatal" : "retryable",
			failure: createExceptionSummaryAttemptFailure(error, aborted),
		};
	}
}

/** Reads current cancellation state after an asynchronous provider call. */
function isSummaryRequestSignalAborted(
	signal: AbortSignal | undefined,
): boolean {
	return signal?.aborted === true;
}

/** Creates safe diagnostic fields for a failure that did not throw. */
function createSummaryAttemptFailure(
	failureKind: ToolResultSummaryFailureKind,
	errorMessage: string,
): ToolResultSummaryAttemptFailure {
	return {
		failureKind,
		errorMessage: normalizeSummaryDiagnosticErrorMessage(errorMessage),
	};
}

/** Extracts safe diagnostic fields from a thrown provider value without persisting its stack. */
function createExceptionSummaryAttemptFailure(
	error: unknown,
	aborted: boolean,
): ToolResultSummaryAttemptFailure {
	const diagnostic = extractDiagnosticError(error);
	return {
		failureKind: aborted ? "aborted" : "exception",
		errorMessage: normalizeSummaryDiagnosticErrorMessage(diagnostic.message),
		...(diagnostic.name === undefined ? {} : { errorName: diagnostic.name }),
		...(diagnostic.code === undefined ? {} : { errorCode: diagnostic.code }),
	};
}

/** Bounds and flattens provider error messages before session persistence. */
function normalizeSummaryDiagnosticErrorMessage(message: string): string {
	const normalized = message
		.replace(SUMMARY_DIAGNOSTIC_WHITESPACE_PATTERN, " ")
		.trim()
		.slice(0, SUMMARY_DIAGNOSTIC_ERROR_MESSAGE_LIMIT);
	return normalized.length === 0 ? SUMMARY_PROVIDER_ERROR : normalized;
}

/** Builds the isolated summary request context for one tool result. */
function buildSummaryContext(
	candidate: ToolResultSummaryCandidate,
	runtimeConfig: ToolResultSummaryRuntimeConfig,
): Context {
	const toolCallContext = escapeUTF8(
		candidate.toolCallContext ??
			JSON.stringify({
				name: candidate.message.toolName,
				toolCallId: candidate.message.toolCallId,
			}),
	);
	return {
		systemPrompt: runtimeConfig.systemPrompt,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: [
							"<tool_call>",
							toolCallContext,
							"</tool_call>",
							"",
							"<tool_result>",
							escapeUTF8(candidate.text),
							"</tool_result>",
							"",
							runtimeConfig.userPrompt,
						].join("\n"),
					},
				],
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

/** Returns text from a summary response when the model produced visible text. */
function extractSummaryText(content: Message["content"]): string | undefined {
	if (!Array.isArray(content)) {
		return undefined;
	}

	const summary = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return summary.length === 0 ? undefined : summary;
}

/** Returns combined text for a successful text-only tool result. */
function getToolResultText(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string | undefined {
	if (message.isError || !Array.isArray(message.content)) {
		return undefined;
	}
	if (!message.content.every((block) => block.type === "text")) {
		return undefined;
	}

	return message.content.map((block) => block.text).join("");
}

/** Returns a supported thinking level from dynamic pi state. */
function parseToolResultSummaryThinking(
	value: unknown,
): ToolResultSummaryThinking | undefined {
	return isSummaryThinking(value) ? value : undefined;
}

/** Checks whether a runtime value is a valid summary thinking level. */
function isSummaryThinking(value: unknown): value is ToolResultSummaryThinking {
	return isReasoningLevel(value);
}

/** Checks whether an optional runtime value is a valid summary thinking setting. */
function isOptionalSummaryThinking(
	value: unknown,
): value is ToolResultSummaryThinking | undefined {
	return value === undefined || value === null || isSummaryThinking(value);
}

/** Checks whether an optional runtime value is a provider/model identifier. */
function isOptionalModelId(value: unknown): value is string | undefined {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}

	const separatorIndex = value.indexOf("/");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
}

/** Checks whether an optional runtime value is a usable string. */
function isOptionalNonEmptyString(value: unknown): value is string | undefined {
	return value === undefined || value === null || isNonEmptyString(value);
}

/** Checks whether a runtime value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Checks whether a runtime value is a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Checks whether a runtime value is a positive integer. */
function isPositiveInteger(value: unknown): value is number {
	return isNonNegativeInteger(value) && value > 0;
}

/** Checks whether a runtime value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
