import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
	type CompactionResult,
	convertToLlm,
	type ExtensionAPI,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import {
	readExtensionConfigFile,
	readExtensionConfigFileSync,
} from "../../shared/agent-suite-storage";

/** Suite directory owned only by this extension. */
const CUSTOM_COMPACTION_EXTENSION_DIR = "custom-compaction";

/** Legacy config file name supported for existing installations. */
const CUSTOM_COMPACTION_LEGACY_CONFIG_FILE = "custom-compaction.json";

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

/** Config keys accepted by this extension. */
const CUSTOM_COMPACTION_CONFIG_KEYS = [
	...PROMPT_FILE_KEYS,
	ENABLED_CONFIG_KEY,
	MODEL_CONFIG_KEY,
	REASONING_CONFIG_KEY,
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

interface CustomCompactionConfig {
	readonly systemPromptFile: string;
	readonly historyPromptFile: string;
	readonly updatePromptFile: string;
	readonly turnPrefixPromptFile: string;
	readonly model?: string;
	readonly reasoning?: Reasoning;
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

	pi.on("session_before_compact", async (event, ctx) => {
		const session = ctx as unknown as CustomCompactionSession;
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
			pi.getThinkingLevel(),
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

		const summary = await generateCompactionSummary(
			event,
			prompts.prompts,
			runtimeConfig.config.model,
			buildCompletionOptions(runtimeConfig.config, auth, event.signal),
		);
		if (summary === undefined) {
			reportIssue(session, "model response did not contain text summary");
			return undefined;
		}

		return {
			compaction: buildCompactionResult(event, summary),
		};
	});
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
async function generateCompactionSummary(
	event: SessionBeforeCompactEvent,
	prompts: CustomCompactionPrompts,
	model: Model<Api>,
	baseOptions: SimpleStreamOptions,
): Promise<string | undefined> {
	if (
		event.preparation.isSplitTurn &&
		event.preparation.turnPrefixMessages.length > 0
	) {
		const [historySummary, turnPrefixSummary] = await Promise.all([
			event.preparation.messagesToSummarize.length > 0
				? executeSummaryRequest(
						model,
						buildHistorySummaryContext(event, prompts),
						buildSummaryCompletionOptions(
							baseOptions,
							event,
							HISTORY_SUMMARY_RESERVE_RATIO,
						),
					)
				: Promise.resolve("No prior history."),
			executeSummaryRequest(
				model,
				buildTurnPrefixSummaryContext(event, prompts),
				buildSummaryCompletionOptions(
					baseOptions,
					event,
					TURN_PREFIX_SUMMARY_RESERVE_RATIO,
				),
			),
		]);
		if (historySummary === undefined || turnPrefixSummary === undefined) {
			return undefined;
		}

		return `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
	}

	return executeSummaryRequest(
		model,
		buildHistorySummaryContext(event, prompts),
		buildSummaryCompletionOptions(
			baseOptions,
			event,
			HISTORY_SUMMARY_RESERVE_RATIO,
		),
	);
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

/** Sends one summary request and extracts a text response. */
async function executeSummaryRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
): Promise<string | undefined> {
	const response = await completeSimple(model, context, options);
	if (response.stopReason === "error") {
		return undefined;
	}

	return extractTextSummary(response.content);
}

/** Applies the output budget for one compaction model call. */
function buildSummaryCompletionOptions(
	baseOptions: SimpleStreamOptions,
	event: SessionBeforeCompactEvent,
	reserveRatio: number,
): SimpleStreamOptions {
	return {
		...baseOptions,
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
function buildCompactionResult(
	event: SessionBeforeCompactEvent,
	summary: string,
): CompactionResult<{
	readonly readFiles: readonly string[];
	readonly modifiedFiles: readonly string[];
}> {
	const fileLists = computeFileListsFromOperations(event.preparation.fileOps);

	return {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
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
