import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	type CompactionResult,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	readExtensionConfigFile,
	readExtensionConfigFileSync,
} from "../../shared/agent-suite-storage";
import { createAuxiliaryLlmSessionId } from "../../shared/auxiliary-llm-session";
import { recordHelperApiCost } from "../../shared/helper-api-cost";
import {
	buildRetryConfig,
	createRetryableExternalError,
	type RetryConfig,
	validateRetryConfig,
	withRetry,
} from "../../shared/retry";
import {
	buildSummarizedToolResultMessage,
	collectToolResultSummaryCandidates,
	doesContextFitModel,
	mapWithConcurrency,
	parseToolResultSummaryConfig,
	resolveToolResultSummaryRuntimeConfig,
	summarizeToolResultCandidateWithRetries,
	type ToolResultSummaryAttemptFailure,
	type ToolResultSummaryCandidate,
	type ToolResultSummaryConfig,
	type ToolResultSummaryRuntimeConfig,
} from "../../shared/tool-result-summary";
import { createToolResultSummaryDiagnosticRecorder } from "../../shared/tool-result-summary-diagnostic";

/** Suite directory owned only by this extension. */
const CUSTOM_COMPACTION_EXTENSION_DIR = "custom-compaction";

/** Legacy config file name supported for existing installations. */
const CUSTOM_COMPACTION_LEGACY_CONFIG_FILE = "custom-compaction.json";

/** Custom entry used as a safe retry boundary after overflow compaction summarized the retained tail. */
const OVERFLOW_RETRY_BOUNDARY_CUSTOM_TYPE =
	"custom-compaction-overflow-retry-boundary";

/** Extension issue prefix used for isolated diagnostics. */
const ISSUE_PREFIX = "[custom-compaction]";

/** Required prompt file fields that define the custom compaction prompt set. */
const PROMPT_FILE_KEYS = [
	"systemPromptFile",
	"historyPromptFile",
	"updatePromptFile",
	"turnPrefixPromptFile",
] as const;

/** Directory that stores extension-local prompt files used when config omits custom prompt paths. */
const DEFAULT_PROMPT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

/** Extension-local prompt files keyed by their config override field. */
const DEFAULT_PROMPT_FILES: Record<PromptFileKey, string> = {
	systemPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-system.md"),
	historyPromptFile: join(DEFAULT_PROMPT_DIR, "compaction.md"),
	updatePromptFile: join(DEFAULT_PROMPT_DIR, "compaction-update.md"),
	turnPrefixPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-turn-prefix.md"),
};

/** Optional config field that selects a model by provider/model ID. */
const MODEL_CONFIG_KEY = "model";

/** Config key that disables or enables custom compaction. */
const ENABLED_CONFIG_KEY = "enabled";

/** Optional config field that selects reasoning effort for the compaction call. */
const REASONING_CONFIG_KEY = "reasoning";

/** Config key that controls retry behavior for compaction model calls. */
const RETRY_CONFIG_KEY = "retry";

/** Config key for helper summaries used to shrink large tool results before compaction. */
const SUMMARY_CONFIG_KEY = "summary";

/** Minimum tool-result size summarized before oversized compaction requests. */
const TOOL_RESULT_SUMMARY_MIN_TOKENS = 4_000;

/** Config keys accepted by this extension. */
const CUSTOM_COMPACTION_CONFIG_KEYS = [
	...PROMPT_FILE_KEYS,
	ENABLED_CONFIG_KEY,
	MODEL_CONFIG_KEY,
	REASONING_CONFIG_KEY,
	RETRY_CONFIG_KEY,
	SUMMARY_CONFIG_KEY,
] as const;

/** Reasoning values accepted by pi configuration for custom compaction. */
const REASONING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

/** History summaries receive most of the reserved compaction output budget. */
const HISTORY_SUMMARY_RESERVE_RATIO = 0.8;

/** Split-turn prefix summaries receive a smaller budget than full history summaries. */
const TURN_PREFIX_SUMMARY_RESERVE_RATIO = 0.5;

type PromptFileKey = (typeof PROMPT_FILE_KEYS)[number];
type Reasoning = (typeof REASONING_VALUES)[number];

type ConfigReadResult =
	| { readonly kind: "disabled" }
	| { readonly kind: "valid"; readonly config: CustomCompactionConfig }
	| { readonly kind: "invalid"; readonly issue: string };

type PromptReadResult =
	| { readonly kind: "valid"; readonly prompts: CustomCompactionPrompts }
	| { readonly kind: "invalid"; readonly issue: string };

type PromptFileReadResult =
	| {
			readonly kind: "valid";
			readonly key: PromptFileKey;
			readonly content: string;
	  }
	| { readonly kind: "invalid"; readonly issue: string };

type RuntimeConfigResult =
	| {
			readonly kind: "valid";
			readonly config: CustomCompactionRuntimeConfig;
	  }
	| { readonly kind: "invalid"; readonly issue: string };

type ModelSelectionResult =
	| { readonly kind: "valid"; readonly model: Model<Api> }
	| { readonly kind: "invalid"; readonly issue: string };

interface ModelAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

interface CustomCompactionConfig {
	readonly systemPromptFile: string;
	readonly historyPromptFile: string;
	readonly updatePromptFile: string;
	readonly turnPrefixPromptFile: string;
	readonly model?: string;
	readonly reasoning?: Reasoning;
	readonly retry: RetryConfig;
	readonly summary: ToolResultSummaryConfig;
}

interface CustomCompactionRuntimeConfig {
	readonly model: Model<Api>;
	readonly reasoning: Reasoning | undefined;
}

interface CustomCompactionPrompts {
	readonly systemPrompt: string;
	readonly historyPrompt: string;
	readonly updatePrompt: string;
	readonly turnPrefixPrompt: string;
}

interface ResolvedCompactionRequest {
	readonly config: CustomCompactionConfig;
	readonly prompts: CustomCompactionPrompts;
	readonly runtimeConfig: CustomCompactionRuntimeConfig;
	readonly auth: ModelAuth;
}

interface ToolResultCompressionProgressReporter {
	notifyStart(): void;
	notifyCandidate(toolName: string, position: number): void;
	notifyRetry(nextAttempt: number, totalAttempts: number): void;
	notifyUnavailable(): void;
	notifyCompleted(compressedCount: number): void;
}

interface CustomCompactionSession {
	readonly hasUI?: boolean;
	readonly ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| {
					readonly ok: true;
					readonly apiKey?: string;
					readonly headers?: Record<string, string>;
			  }
			| { readonly ok: false; readonly error: string }
		>;
	};
}

interface TextBlockRecord extends Record<string, unknown> {
	readonly type?: unknown;
	readonly text?: unknown;
}

/** Extension entry point for custom compaction handling. */
export default function customCompaction(pi: ExtensionAPI): void {
	assertConfiguredPromptPathsAreAbsolute();

	pi.on("session_before_compact", (event, ctx) =>
		handleSessionBeforeCompact(pi, event, ctx),
	);
}

/** Handles one custom compaction request from Pi session lifecycle. */
async function handleSessionBeforeCompact(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<{ readonly compaction: CompactionResult } | undefined> {
	const session = ctx as unknown as CustomCompactionSession;
	const request = await resolveCompactionRequest(
		session,
		pi.getThinkingLevel(),
	);
	if (request === undefined) {
		return undefined;
	}

	const compactionPlan = createOverflowRetryCompactionPlan(event);
	const recordCost = (message: AssistantMessage): void => {
		recordHelperApiCost(pi, "custom-compaction", message);
	};
	const summaryEvent = await prepareCompactionSummaryEvent({
		pi,
		event: compactionPlan.event,
		prompts: request.prompts,
		model: request.runtimeConfig.model,
		summaryConfig: request.config.summary,
		session,
		currentThinking: request.runtimeConfig.reasoning ?? pi.getThinkingLevel(),
		signal: event.signal,
		recordCost,
	});
	if (summaryEvent === undefined) {
		reportIssue(
			session,
			"compaction summary input exceeds model context window",
		);
		return undefined;
	}

	const summary = await generateCompactionSummary({
		event: summaryEvent,
		prompts: request.prompts,
		model: request.runtimeConfig.model,
		baseOptions: buildCompletionOptions(
			request.runtimeConfig,
			request.auth,
			event.signal,
		),
		retry: request.config.retry,
		recordCost,
	});
	if (summary === undefined) {
		reportIssue(session, "model response did not contain text summary");
		return undefined;
	}

	const firstKeptEntryId = compactionPlan.needsRetryBoundary
		? appendOverflowRetryBoundary(pi, ctx)
		: compactionPlan.event.preparation.firstKeptEntryId;
	return {
		compaction: buildCompactionResult(
			compactionPlan.event,
			summary,
			firstKeptEntryId,
		),
	};
}

/** Resolves config, prompts, model runtime, and auth for one compaction request. */
async function resolveCompactionRequest(
	session: CustomCompactionSession,
	thinkingLevel: string,
): Promise<ResolvedCompactionRequest | undefined> {
	const config = await readCustomCompactionConfig();
	if (config.kind === "disabled") {
		return undefined;
	}
	if (config.kind === "invalid") {
		reportIssue(session, config.issue);
		return undefined;
	}

	const prompts = await readPromptFiles(config.config);
	if (prompts.kind === "invalid") {
		reportIssue(session, prompts.issue);
		return undefined;
	}

	const runtimeConfig = resolveCustomCompactionRuntimeConfig(
		session,
		config.config,
		thinkingLevel,
	);
	if (runtimeConfig.kind === "invalid") {
		reportIssue(session, runtimeConfig.issue);
		return undefined;
	}

	const auth = await session.modelRegistry.getApiKeyAndHeaders(
		runtimeConfig.config.model,
	);
	if (!auth.ok) {
		reportIssue(session, `failed to resolve model auth: ${auth.error}`);
		return undefined;
	}

	return {
		config: config.config,
		prompts: prompts.prompts,
		runtimeConfig: runtimeConfig.config,
		auth,
	};
}

/** Fails startup when enabled config uses prompt paths that depend on config-relative or home expansion. */
function assertConfiguredPromptPathsAreAbsolute(): void {
	const configFile = readExtensionConfigFileSync({
		extensionDir: CUSTOM_COMPACTION_EXTENSION_DIR,
		legacyConfigFileName: CUSTOM_COMPACTION_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind !== "found") {
		return;
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);
		if (!isRecord(config) || config[ENABLED_CONFIG_KEY] === false) {
			return;
		}
		for (const key of PROMPT_FILE_KEYS) {
			const value = config[key];
			if (typeof value === "string" && !isAbsolute(value)) {
				throw new Error(`${ISSUE_PREFIX} ${key} must be an absolute path`);
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(ISSUE_PREFIX)) {
			throw error;
		}
	}
}

/** Reads and validates the extension config with suite-first storage lookup. */
async function readCustomCompactionConfig(): Promise<ConfigReadResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: CUSTOM_COMPACTION_EXTENSION_DIR,
		legacyConfigFileName: CUSTOM_COMPACTION_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return {
			kind: "valid",
			config: buildCustomCompactionConfig({}),
		};
	}
	if (configFile.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${configFile.location.displayPath}: ${formatError(configFile.error)}`,
		};
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);

		return parseCustomCompactionConfig(config, configFile.file.displayPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse ${configFile.file.displayPath}: ${formatError(error)}`,
		};
	}
}

/** Parses config JSON into a typed custom compaction contract. */
function parseCustomCompactionConfig(
	config: unknown,
	configDisplayPath: string,
): ConfigReadResult {
	const validationResult = validateCustomCompactionConfig(
		config,
		configDisplayPath,
	);
	if ("issue" in validationResult) {
		return { kind: "invalid", issue: validationResult.issue };
	}

	if (validationResult.config[ENABLED_CONFIG_KEY] === false) {
		return { kind: "disabled" };
	}

	return {
		kind: "valid",
		config: buildCustomCompactionConfig(validationResult.config),
	};
}

/** Validates raw custom compaction config before any path resolution. */
function validateCustomCompactionConfig(
	config: unknown,
	configDisplayPath: string,
): { readonly config: Record<string, unknown> } | { readonly issue: string } {
	if (!isRecord(config)) {
		return {
			issue: `${configDisplayPath} must contain a JSON object`,
		};
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!(CUSTOM_COMPACTION_CONFIG_KEYS as readonly string[]).includes(key),
	);
	if (unsupportedKey !== undefined) {
		return {
			issue: `unsupported key "${unsupportedKey}" in ${configDisplayPath}`,
		};
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { issue: `${ENABLED_CONFIG_KEY} must be a boolean` };
	}
	if (enabled === false) {
		return { config };
	}

	const promptFileIssue = validatePromptFileConfig(config);
	if (promptFileIssue !== undefined) {
		return { issue: promptFileIssue };
	}

	const model = config[MODEL_CONFIG_KEY];
	if (model !== undefined && !isModelId(model)) {
		return { issue: `${MODEL_CONFIG_KEY} must use provider/model` };
	}

	const reasoning = config[REASONING_CONFIG_KEY];
	if (reasoning !== undefined && !isReasoning(reasoning)) {
		return {
			issue: `${REASONING_CONFIG_KEY} must be one of ${REASONING_VALUES.join(", ")}`,
		};
	}

	const retryIssue = validateRetryConfig(config[RETRY_CONFIG_KEY], "retry");
	if (retryIssue !== undefined) {
		return { issue: retryIssue };
	}

	try {
		const summary = parseToolResultSummaryConfig(config[SUMMARY_CONFIG_KEY], {
			defaultEnabled: true,
		});
		if (summary === undefined) {
			return {
				issue: `${SUMMARY_CONFIG_KEY} must match context-projection summary config`,
			};
		}
	} catch (error) {
		return { issue: formatError(error) };
	}

	return { config };
}

/** Validates all prompt path config fields. */
function validatePromptFileConfig(
	config: Record<string, unknown>,
): string | undefined {
	for (const key of PROMPT_FILE_KEYS) {
		const value = config[key];
		if (
			value !== undefined &&
			(typeof value !== "string" || value.trim().length === 0)
		) {
			return `${key} must be a non-empty string`;
		}
		if (typeof value === "string" && !isAbsolute(value)) {
			return `${key} must be an absolute path`;
		}
	}

	return undefined;
}

/** Builds the typed custom compaction config after raw input validation. */
function buildCustomCompactionConfig(
	config: Record<string, unknown>,
): CustomCompactionConfig {
	const systemPromptFile = config[PROMPT_FILE_KEYS[0]];
	const historyPromptFile = config[PROMPT_FILE_KEYS[1]];
	const updatePromptFile = config[PROMPT_FILE_KEYS[2]];
	const turnPrefixPromptFile = config[PROMPT_FILE_KEYS[3]];
	const model = config[MODEL_CONFIG_KEY];
	const reasoning = config[REASONING_CONFIG_KEY];

	return {
		systemPromptFile:
			typeof systemPromptFile === "string"
				? systemPromptFile
				: DEFAULT_PROMPT_FILES.systemPromptFile,
		historyPromptFile:
			typeof historyPromptFile === "string"
				? historyPromptFile
				: DEFAULT_PROMPT_FILES.historyPromptFile,
		updatePromptFile:
			typeof updatePromptFile === "string"
				? updatePromptFile
				: DEFAULT_PROMPT_FILES.updatePromptFile,
		turnPrefixPromptFile:
			typeof turnPrefixPromptFile === "string"
				? turnPrefixPromptFile
				: DEFAULT_PROMPT_FILES.turnPrefixPromptFile,
		...(typeof model === "string" ? { model } : {}),
		...(isReasoning(reasoning) ? { reasoning } : {}),
		retry: buildRetryConfig(config[RETRY_CONFIG_KEY]),
		summary: parseToolResultSummaryConfig(config[SUMMARY_CONFIG_KEY], {
			defaultEnabled: true,
		}) as ToolResultSummaryConfig,
	};
}

/** Reads the prompt files required for custom compaction. */
async function readPromptFiles(
	config: CustomCompactionConfig,
): Promise<PromptReadResult> {
	const results = await Promise.all(
		PROMPT_FILE_KEYS.map((key) => readPromptFile(key, config[key])),
	);
	const invalidResult = results.find(isInvalidPromptFileReadResult);
	if (invalidResult !== undefined) {
		return invalidResult;
	}

	const validResults = results.filter(isValidPromptFileReadResult);
	const prompts = Object.fromEntries(
		validResults.map((result) => [result.key, result.content]),
	) as Record<PromptFileKey, string>;

	return {
		kind: "valid",
		prompts: {
			systemPrompt: prompts.systemPromptFile,
			historyPrompt: prompts.historyPromptFile,
			updatePrompt: prompts.updatePromptFile,
			turnPrefixPrompt: prompts.turnPrefixPromptFile,
		},
	};
}

/** Reads one prompt file and validates that it can contribute to compaction. */
async function readPromptFile(
	key: PromptFileKey,
	path: string,
): Promise<PromptFileReadResult> {
	try {
		const content = await readFile(path, "utf8");
		if (content.trim().length === 0) {
			return {
				kind: "invalid",
				issue: `${key} must point to a non-empty prompt file`,
			};
		}

		return { kind: "valid", key, content };
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to read ${key}: ${formatError(error)}`,
		};
	}
}

/** Returns true when a prompt file read result contains a validation issue. */
function isInvalidPromptFileReadResult(
	result: PromptFileReadResult,
): result is Extract<PromptFileReadResult, { readonly kind: "invalid" }> {
	return result.kind === "invalid";
}

/** Returns true when a prompt file read result contains usable prompt content. */
function isValidPromptFileReadResult(
	result: PromptFileReadResult,
): result is Extract<PromptFileReadResult, { readonly kind: "valid" }> {
	return result.kind === "valid";
}

/** Resolves config values that depend on the active pi session. */
function resolveCustomCompactionRuntimeConfig(
	session: CustomCompactionSession,
	config: CustomCompactionConfig,
	currentThinkingLevel: unknown,
): RuntimeConfigResult {
	const model = selectConfiguredOrCurrentModel(session, config);
	if (model.kind === "invalid") {
		return model;
	}

	return {
		kind: "valid",
		config: {
			model: model.model,
			reasoning: selectConfiguredOrCurrentReasoning(
				config,
				currentThinkingLevel,
			),
		},
	};
}

/** Selects the configured model or the current session model. */
function selectConfiguredOrCurrentModel(
	session: CustomCompactionSession,
	config: CustomCompactionConfig,
): ModelSelectionResult {
	if (config.model === undefined) {
		if (session.model === undefined) {
			return { kind: "invalid", issue: "current model is unavailable" };
		}

		return { kind: "valid", model: session.model };
	}

	const modelParts = splitModelId(config.model);
	if (modelParts === undefined) {
		return {
			kind: "invalid",
			issue: `${MODEL_CONFIG_KEY} must use provider/model`,
		};
	}

	const model = session.modelRegistry.find(
		modelParts.provider,
		modelParts.modelId,
	);
	if (model === undefined) {
		return { kind: "invalid", issue: `model ${config.model} was not found` };
	}

	return { kind: "valid", model };
}

/** Selects the configured reasoning value or the current thinking level. */
function selectConfiguredOrCurrentReasoning(
	config: CustomCompactionConfig,
	currentThinkingLevel: unknown,
): Reasoning | undefined {
	return config.reasoning ?? parseReasoning(currentThinkingLevel);
}

/** Generates the history summary and optional split-turn prefix summary. */
async function generateCompactionSummary({
	event,
	prompts,
	model,
	baseOptions,
	retry,
	recordCost,
}: {
	readonly event: SessionBeforeCompactEvent;
	readonly prompts: CustomCompactionPrompts;
	readonly model: Model<Api>;
	readonly baseOptions: SimpleStreamOptions;
	readonly retry: RetryConfig;
	readonly recordCost: (message: AssistantMessage) => void;
}): Promise<string | undefined> {
	if (
		event.preparation.isSplitTurn &&
		event.preparation.turnPrefixMessages.length > 0
	) {
		const [historySummary, turnPrefixSummary] = await Promise.all([
			event.preparation.messagesToSummarize.length > 0
				? executeSummaryRequest({
						model,
						context: buildHistorySummaryContext(event, prompts),
						options: buildSummaryCompletionOptions(
							baseOptions,
							event,
							HISTORY_SUMMARY_RESERVE_RATIO,
							createAuxiliaryLlmSessionId(),
						),
						retry,
						recordCost,
					})
				: Promise.resolve("No prior history."),
			executeSummaryRequest({
				model,
				context: buildTurnPrefixSummaryContext(event, prompts),
				options: buildSummaryCompletionOptions(
					baseOptions,
					event,
					TURN_PREFIX_SUMMARY_RESERVE_RATIO,
					createAuxiliaryLlmSessionId(),
				),
				retry,
				recordCost,
			}),
		]);
		if (historySummary === undefined || turnPrefixSummary === undefined) {
			return undefined;
		}

		return `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
	}

	return executeSummaryRequest({
		model,
		context: buildHistorySummaryContext(event, prompts),
		options: buildSummaryCompletionOptions(
			baseOptions,
			event,
			HISTORY_SUMMARY_RESERVE_RATIO,
			createAuxiliaryLlmSessionId(),
		),
		retry,
		recordCost,
	});
}

/** Creates user-visible progress notifications for large tool-result compression. */
function createToolResultCompressionProgressReporter(
	session: CustomCompactionSession,
	total: number,
): ToolResultCompressionProgressReporter {
	return {
		notifyStart(): void {
			notifyCompressionProgress(
				session,
				`compressing large tool results before compaction: 0/${total}`,
			);
		},
		notifyCandidate(toolName, position): void {
			notifyCompressionProgress(
				session,
				`compressing ${toolName} tool result before compaction: ${position}/${total}`,
			);
		},
		notifyRetry(nextAttempt, totalAttempts): void {
			notifyCompressionProgress(
				session,
				`retrying tool result summary ${nextAttempt}/${totalAttempts}`,
			);
		},
		notifyUnavailable(): void {
			notifyCompressionProgress(
				session,
				"tool result summary unavailable during compaction compression",
				"warning",
			);
		},
		notifyCompleted(compressedCount): void {
			notifyCompressionProgress(
				session,
				`compressed ${compressedCount}/${total} large tool results before compaction`,
			);
		},
	};
}

/** Emits one custom-compaction compression notification when interactive UI is available. */
function notifyCompressionProgress(
	session: CustomCompactionSession,
	message: string,
	type: "info" | "warning" = "info",
): void {
	if (session.hasUI === false) {
		return;
	}

	session.ui.notify(`${ISSUE_PREFIX} ${message}`, type);
}

/** Prepares compaction input and summarizes large tool results only when the original request is oversized. */
async function prepareCompactionSummaryEvent({
	pi,
	event,
	prompts,
	model,
	summaryConfig,
	session,
	currentThinking,
	signal,
	recordCost,
}: {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly event: SessionBeforeCompactEvent;
	readonly prompts: CustomCompactionPrompts;
	readonly model: Model<Api>;
	readonly summaryConfig: ToolResultSummaryConfig;
	readonly session: CustomCompactionSession;
	readonly currentThinking: string | undefined;
	readonly signal: AbortSignal;
	readonly recordCost: (message: AssistantMessage) => void;
}): Promise<SessionBeforeCompactEvent | undefined> {
	if (doesCompactionSummaryEventFitModel(event, prompts, model)) {
		return event;
	}
	if (!summaryConfig.enabled) {
		return undefined;
	}

	const runtimeConfig = await resolveToolResultSummaryRuntimeConfig({
		currentModel: model,
		modelRegistry: session.modelRegistry,
		config: summaryConfig,
		currentThinking,
		signal,
	});
	if (runtimeConfig === undefined) {
		return undefined;
	}

	const sources = createCompactionToolResultSources(event);
	const candidates = collectToolResultSummaryCandidates(
		sources,
		TOOL_RESULT_SUMMARY_MIN_TOKENS,
	);
	if (candidates.length === 0) {
		return undefined;
	}

	const progress = createToolResultCompressionProgressReporter(
		session,
		candidates.length,
	);
	progress.notifyStart();
	const recordAttemptFailure = createToolResultSummaryDiagnosticRecorder(
		pi,
		"custom-compaction",
		runtimeConfig.model,
	);
	const summaries = await mapWithConcurrency(
		candidates,
		summaryConfig.maxConcurrency,
		async (candidate) =>
			summarizeCompactionToolResultCandidate({
				candidate,
				position: candidates.indexOf(candidate) + 1,
				runtimeConfig,
				summaryConfig,
				progress,
				recordAttemptFailure,
				recordCost,
			}),
	);
	const replacementById = createCompactionSummaryReplacements(
		candidates,
		summaries,
	);
	if (replacementById.size === 0) {
		progress.notifyCompleted(0);
		return undefined;
	}
	progress.notifyCompleted(replacementById.size);

	const reducedEvent = replaceCompactionToolResults(event, replacementById);
	return doesCompactionSummaryEventFitModel(reducedEvent, prompts, model)
		? reducedEvent
		: undefined;
}

/** Summarizes one compaction tool result while reporting request progress. */
async function summarizeCompactionToolResultCandidate({
	candidate,
	position,
	runtimeConfig,
	summaryConfig,
	progress,
	recordAttemptFailure,
	recordCost,
}: {
	readonly candidate: ToolResultSummaryCandidate;
	readonly position: number;
	readonly runtimeConfig: ToolResultSummaryRuntimeConfig;
	readonly summaryConfig: ToolResultSummaryConfig;
	readonly progress: ToolResultCompressionProgressReporter;
	readonly recordAttemptFailure: (
		candidate: ToolResultSummaryCandidate,
		failure: ToolResultSummaryAttemptFailure,
		attempt: number,
		totalAttempts: number,
	) => void;
	readonly recordCost: (message: AssistantMessage) => void;
}): Promise<string | undefined> {
	progress.notifyCandidate(candidate.message.toolName, position);
	const summary = await summarizeToolResultCandidateWithRetries({
		candidate,
		runtimeConfig,
		sessionId: createAuxiliaryLlmSessionId(),
		completeSimple,
		config: summaryConfig,
		recordCost,
		onAttemptFailure: recordAttemptFailure,
		onRetryScheduled: (nextAttempt, totalAttempts) => {
			progress.notifyRetry(nextAttempt, totalAttempts);
		},
	});
	if (summary === undefined) {
		progress.notifyUnavailable();
	}
	return summary;
}

/** Maps successful helper summaries back to their original compaction message identifiers. */
function createCompactionSummaryReplacements(
	candidates: readonly ToolResultSummaryCandidate[],
	summaries: readonly (string | undefined)[],
): Map<string, AgentMessage> {
	const replacementById = new Map<string, AgentMessage>();
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const summary = summaries[index];
		if (candidate === undefined || summary === undefined) {
			continue;
		}

		replacementById.set(
			candidate.id,
			buildSummarizedToolResultMessage(candidate.message, summary),
		);
	}
	return replacementById;
}

/** Checks all summary requests that may be sent for a compaction event. */
function doesCompactionSummaryEventFitModel(
	event: SessionBeforeCompactEvent,
	prompts: CustomCompactionPrompts,
	model: Model<Api>,
): boolean {
	return buildCompactionSummaryContexts(event, prompts).every((context) =>
		doesContextFitModel(context, model),
	);
}

/** Builds only the contexts that the compaction flow will send to the model. */
function buildCompactionSummaryContexts(
	event: SessionBeforeCompactEvent,
	prompts: CustomCompactionPrompts,
): Context[] {
	if (
		event.preparation.isSplitTurn &&
		event.preparation.turnPrefixMessages.length > 0
	) {
		const contexts = [buildTurnPrefixSummaryContext(event, prompts)];
		if (event.preparation.messagesToSummarize.length > 0) {
			contexts.unshift(buildHistorySummaryContext(event, prompts));
		}
		return contexts;
	}

	return [buildHistorySummaryContext(event, prompts)];
}

/** Creates stable source IDs for both compaction message groups. */
function createCompactionToolResultSources(
	event: SessionBeforeCompactEvent,
): Array<{ readonly id: string; readonly message: AgentMessage }> {
	return [
		...event.preparation.messagesToSummarize.map((message, index) => ({
			id: `history:${index}`,
			message: message as AgentMessage,
		})),
		...event.preparation.turnPrefixMessages.map((message, index) => ({
			id: `turn-prefix:${index}`,
			message: message as AgentMessage,
		})),
	];
}

/** Replaces only helper-summarized tool results and preserves all other compaction messages. */
function replaceCompactionToolResults(
	event: SessionBeforeCompactEvent,
	replacementById: ReadonlyMap<string, AgentMessage>,
): SessionBeforeCompactEvent {
	return {
		...event,
		preparation: {
			...event.preparation,
			messagesToSummarize: replaceMessageGroup(
				event.preparation.messagesToSummarize,
				"history",
				replacementById,
			),
			turnPrefixMessages: replaceMessageGroup(
				event.preparation.turnPrefixMessages,
				"turn-prefix",
				replacementById,
			),
		},
	};
}

/** Replaces messages by the same stable IDs used when summary candidates were collected. */
function replaceMessageGroup<T>(
	messages: readonly T[],
	prefix: "history" | "turn-prefix",
	replacementById: ReadonlyMap<string, AgentMessage>,
): T[] {
	return messages.map((message, index) => {
		const replacement = replacementById.get(`${prefix}:${index}`);
		return replacement === undefined ? message : (replacement as T);
	});
}

/** Builds a summary request for normal history or previous-summary updates. */
function buildHistorySummaryContext(
	event: SessionBeforeCompactEvent,
	prompts: CustomCompactionPrompts,
): Context {
	const prompt =
		event.preparation.previousSummary === undefined
			? prompts.historyPrompt
			: prompts.updatePrompt;

	return buildSummaryContext(
		event.preparation.messagesToSummarize,
		event.preparation.previousSummary,
		prompts.systemPrompt,
		prompt,
	);
}

/** Builds a summary request for the discarded prefix of a split turn. */
function buildTurnPrefixSummaryContext(
	event: SessionBeforeCompactEvent,
	prompts: CustomCompactionPrompts,
): Context {
	return buildSummaryContext(
		event.preparation.turnPrefixMessages,
		undefined,
		prompts.systemPrompt,
		prompts.turnPrefixPrompt,
	);
}

/** Wraps serialized conversation text and summary instructions in one user message. */
function buildSummaryContext(
	messagesToSummarize: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
	previousSummary: string | undefined,
	systemPrompt: string,
	userPrompt: string,
): Context {
	const conversationText = serializeConversation(
		convertToLlm([...messagesToSummarize]),
	);
	const sections = [
		`<conversation>\n${conversationText}\n</conversation>`,
		previousSummary === undefined
			? undefined
			: `<previous-summary>\n${previousSummary}\n</previous-summary>`,
		userPrompt,
	].filter((section): section is string => section !== undefined);

	return {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: sections.join("\n\n") }],
				timestamp: Date.now(),
			},
		],
	};
}

interface ExecuteSummaryRequestOptions {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
	readonly retry: RetryConfig;
	readonly recordCost: (message: AssistantMessage) => void;
}

/** Sends one summary request and extracts a text response. */
async function executeSummaryRequest({
	model,
	context,
	options,
	retry,
	recordCost,
}: ExecuteSummaryRequestOptions): Promise<string | undefined> {
	if (!doesContextFitModel(context, model)) {
		return undefined;
	}

	try {
		const response = await withRetry(
			async () => {
				const answer = await completeSimple(model, context, options);
				recordCost(answer);
				if (answer.stopReason === "error") {
					throw createRetryableExternalError(
						answer.errorMessage ?? "compaction provider returned an error",
					);
				}

				return answer;
			},
			{ retry, signal: options.signal },
		);

		return extractTextSummary(response.content);
	} catch {
		return undefined;
	}
}

/** Applies the output budget for one compaction model call. */
function buildSummaryCompletionOptions(
	baseOptions: SimpleStreamOptions,
	event: SessionBeforeCompactEvent,
	reserveRatio: number,
	sessionId: string,
): SimpleStreamOptions {
	return {
		...baseOptions,
		sessionId,
		maxTokens: Math.floor(
			event.preparation.settings.reserveTokens * reserveRatio,
		),
	};
}

/** Builds model completion options without assigning undefined to exact optional fields. */
function buildCompletionOptions(
	config: CustomCompactionRuntimeConfig,
	auth: { readonly apiKey?: string; readonly headers?: Record<string, string> },
	signal: AbortSignal,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { signal };
	if (auth.apiKey !== undefined) {
		options.apiKey = auth.apiKey;
	}
	if (auth.headers !== undefined) {
		options.headers = auth.headers;
	}

	if (config.reasoning !== undefined && config.reasoning !== "off") {
		options.reasoning = config.reasoning;
	}

	return options;
}

/** Builds the compaction result expected by pi session compaction. */
type CompactionInputMessage =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

interface OverflowRetryCompactionPlan {
	readonly event: SessionBeforeCompactEvent;
	readonly needsRetryBoundary: boolean;
}

/** Prepares compaction inputs so overflow retry can continue from a non-assistant boundary. */
function createOverflowRetryCompactionPlan(
	event: SessionBeforeCompactEvent,
): OverflowRetryCompactionPlan {
	if (!isOverflowRetryCompaction(event)) {
		return { event, needsRetryBoundary: false };
	}

	const retainedMessages = collectRetainedMessages(event);
	if (!endsWithAssistantError(retainedMessages)) {
		return { event, needsRetryBoundary: false };
	}

	return {
		event: {
			...event,
			preparation: {
				...event.preparation,
				messagesToSummarize: [
					...event.preparation.messagesToSummarize,
					...retainedMessages,
				],
			},
		},
		needsRetryBoundary: true,
	};
}

/** Detects the runtime-only overflow retry metadata that is absent from older type declarations. */
function isOverflowRetryCompaction(event: SessionBeforeCompactEvent): boolean {
	const eventWithRuntimeFields = event as SessionBeforeCompactEvent & {
		readonly reason?: unknown;
		readonly willRetry?: unknown;
	};
	return (
		eventWithRuntimeFields.reason === "overflow" &&
		eventWithRuntimeFields.willRetry === true
	);
}

/** Collects model-visible retained messages that would be dropped when a retry boundary is inserted. */
function collectRetainedMessages(
	event: SessionBeforeCompactEvent,
): CompactionInputMessage[] {
	const retainedMessages: CompactionInputMessage[] = [];
	let foundFirstKeptEntry = false;
	for (const entry of event.branchEntries) {
		if (entry.id === event.preparation.firstKeptEntryId) {
			foundFirstKeptEntry = true;
		}
		if (!foundFirstKeptEntry || entry.type !== "message") {
			continue;
		}
		retainedMessages.push(entry.message as CompactionInputMessage);
	}
	return retainedMessages;
}

/** Returns true when retrying from the retained context would hit pi core's assistant-role guard. */
function endsWithAssistantError(
	messages: readonly CompactionInputMessage[],
): boolean {
	const lastMessage = messages.at(-1);
	return (
		lastMessage?.role === "assistant" && lastMessage.stopReason === "error"
	);
}

/** Appends a non-message session entry that becomes the kept boundary for overflow retry recovery. */
function appendOverflowRetryBoundary(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager">,
): string {
	pi.appendEntry(OVERFLOW_RETRY_BOUNDARY_CUSTOM_TYPE, {
		reason: "overflow-retry-after-assistant-error",
	});
	const leafId = ctx.sessionManager.getLeafId();
	if (leafId === null) {
		throw new Error(
			"custom-compaction failed to create overflow retry boundary entry",
		);
	}
	return leafId;
}

function buildCompactionResult(
	event: SessionBeforeCompactEvent,
	summary: string,
	firstKeptEntryId: string,
): CompactionResult<{
	readonly readFiles: readonly string[];
	readonly modifiedFiles: readonly string[];
}> {
	const fileLists = computeFileListsFromOperations(event.preparation.fileOps);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: {
			readFiles: fileLists.readFiles,
			modifiedFiles: fileLists.modifiedFiles,
		},
	};
}

/** Converts compaction file operation sets into stable read and modified file lists. */
function computeFileListsFromOperations(fileOps: {
	readonly read: Set<string>;
	readonly written: Set<string>;
	readonly edited: Set<string>;
}): { readonly readFiles: string[]; readonly modifiedFiles: string[] } {
	const modifiedFiles = [
		...new Set([...fileOps.written, ...fileOps.edited]),
	].sort();
	const modifiedFileSet = new Set(modifiedFiles);
	const readFiles = [...fileOps.read]
		.filter((filePath) => !modifiedFileSet.has(filePath))
		.sort();

	return { readFiles, modifiedFiles };
}

/** Extracts the first non-empty text block from a model response. */
function extractTextSummary(content: readonly unknown[]): string | undefined {
	for (const block of content) {
		if (!isTextBlockRecord(block)) {
			continue;
		}

		const text = block.text;
		if (
			block.type === "text" &&
			typeof text === "string" &&
			text.trim().length > 0
		) {
			return text;
		}
	}

	return undefined;
}

/** Reports invalid custom-compaction state without affecting other extensions. */
function reportIssue(session: CustomCompactionSession, issue: string): void {
	if (session.hasUI === false) {
		return;
	}

	session.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a model response content block can contain text. */
function isTextBlockRecord(value: unknown): value is TextBlockRecord {
	return isRecord(value);
}

/** Returns true when a runtime value is an accepted reasoning value. */
function isReasoning(value: unknown): value is Reasoning {
	return (
		typeof value === "string" &&
		(REASONING_VALUES as readonly string[]).includes(value)
	);
}

/** Parses unknown current thinking level into a configured reasoning value. */
function parseReasoning(value: unknown): Reasoning | undefined {
	return isReasoning(value) ? value : undefined;
}

/** Splits a model ID where only the first slash separates provider from provider-owned model ID. */
function splitModelId(
	value: string,
): { readonly provider: string; readonly modelId: string } | undefined {
	const separatorIndex = value.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return undefined;
	}

	return {
		provider: value.slice(0, separatorIndex),
		modelId: value.slice(separatorIndex + 1),
	};
}

/** Returns true when a model ID uses provider/model with both segments present. */
function isModelId(value: unknown): value is string {
	return typeof value === "string" && splitModelId(value) !== undefined;
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
