import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	copyToClipboard as defaultCopyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { escapeUTF8 } from "entities";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";
import {
	type AuxiliaryLlmCompletion,
	type AuxiliaryLlmRuntime,
	buildAuxiliaryLlmOptions,
	completeAuxiliaryLlm,
	doesAuxiliaryLlmInputFitContextWindow,
	getAuxiliaryLlmResponseText,
	resolveAuxiliaryLlmRuntime,
} from "../../shared/auxiliary-llm";
import {
	collectLoadedSkillRoots,
	replayContextProjection,
} from "../../shared/context-projection";
import { readPathEnvironment } from "../../shared/environment";
import {
	type CreateFileAutocompleteProvider,
	createFileAutocompleteProvider,
	resolveFdPathFromPathValue,
} from "../../shared/file-autocomplete";
import {
	appendProjectContext,
	type ProjectContextFile,
} from "../../shared/project-context-prompt";
import {
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
import {
	buildRetryConfig,
	createRetryableExternalError,
	type RetryConfig,
	validateRetryConfig,
	withRetry,
} from "../../shared/retry";
import {
	AskAnswerDialog,
	AskLoadingDialog,
	AskQuestionDialog,
} from "./dialogs.ts";

const ASK_LLM_EXTENSION_DIR = "ask-llm";
const ASK_LLM_COMMAND = "ask";
const ISSUE_PREFIX = "[ask-llm]";
const ENABLED_CONFIG_KEY = "enabled";
const SYSTEM_PROMPT_FILE_CONFIG_KEY = "systemPromptFile";
const RETRY_CONFIG_KEY = "retry";
const USER_QUESTION_TAG = "user_question";
const ASK_LLM_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: { anchor: "center" as const },
};

const DEFAULT_SYSTEM_PROMPT_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"system.md",
);

type Thinking = ReasoningLevel;

type ConfigReadResult =
	| { readonly disabled: true }
	| { readonly config: AskLlmConfig }
	| { readonly issue: string };

type ConfigFileReadResult =
	| {
			readonly kind: "found";
			readonly file: {
				readonly directory: string;
				readonly content: string;
			};
	  }
	| { readonly kind: "missing" }
	| { readonly kind: "read-error"; readonly error: unknown };

type PromptReadResult =
	| { readonly prompt: string }
	| { readonly issue: string };

type AskLlmResult =
	| { readonly kind: "success"; readonly answer: string }
	| { readonly kind: "cancelled" }
	| { readonly kind: "issue"; readonly issue: string };

interface AskLlmDependencies {
	readonly completeSimple?: AuxiliaryLlmCompletion;
	readonly copyToClipboard?: (text: string) => Promise<void>;
	readonly resolveFdPath?: () => string | null;
	readonly createAutocompleteProvider?: CreateFileAutocompleteProvider;
}

interface AskLlmConfig {
	readonly model?: { readonly id?: string; readonly thinking?: Thinking };
	readonly systemPromptFile: string;
	readonly retry: RetryConfig;
}

interface AskLlmCommandContext extends ExtensionCommandContext {
	readonly model: Model<Api> | undefined;
}

/** Extension entry point for direct out-of-band model questions. */
export default function askLlm(
	pi: ExtensionAPI,
	dependencies: AskLlmDependencies = {
		completeSimple: defaultCompleteSimple,
		copyToClipboard: defaultCopyToClipboard,
	},
): void {
	if (isAskLlmDisabled()) {
		return;
	}
	assertSystemPromptFileIsAbsolute();

	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	const copyToClipboard =
		dependencies.copyToClipboard ?? defaultCopyToClipboard;
	const resolveFdPath =
		dependencies.resolveFdPath ??
		(() => resolveFdPathFromPathValue(readPathEnvironment()));
	const createProvider =
		dependencies.createAutocompleteProvider ?? createFileAutocompleteProvider;
	let loadedSkillRoots: readonly string[] = [];
	let contextFiles: readonly ProjectContextFile[] = [];

	pi.on("before_agent_start", (event) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
		contextFiles = event.systemPromptOptions?.contextFiles ?? [];
	});

	pi.registerCommand(ASK_LLM_COMMAND, {
		description: "Ask a one-off LLM question without writing it to the session",
		handler: async (args, ctx) => {
			await handleAskCommand(args, ctx as AskLlmCommandContext, {
				completeSimple,
				copyToClipboard,
				resolveFdPath,
				createAutocompleteProvider: createProvider,
				currentThinkingLevel: pi.getThinkingLevel(),
				loadedSkillRoots,
				contextFiles,
			});
		},
	});
}

/** Handles /ask without sending the question or answer through session APIs. */
async function handleAskCommand(
	args: string,
	ctx: AskLlmCommandContext,
	options: {
		readonly completeSimple: NonNullable<AskLlmDependencies["completeSimple"]>;
		readonly copyToClipboard: NonNullable<
			AskLlmDependencies["copyToClipboard"]
		>;
		readonly resolveFdPath: () => string | null;
		readonly createAutocompleteProvider: CreateFileAutocompleteProvider;
		readonly currentThinkingLevel: unknown;
		readonly loadedSkillRoots: readonly string[];
		readonly contextFiles: readonly ProjectContextFile[];
	},
): Promise<void> {
	if (!ctx.hasUI) {
		reportIssue(ctx, "ask-llm requires interactive mode");
		return;
	}

	const question = await resolveQuestion(args, ctx, {
		resolveFdPath: options.resolveFdPath,
		createAutocompleteProvider: options.createAutocompleteProvider,
	});
	if (question === undefined) {
		ctx.ui.notify("Ask cancelled", "info");
		return;
	}

	const result = await runWithLoader(ctx, question, options);
	if (result.kind === "cancelled") {
		ctx.ui.notify("Ask cancelled", "info");
		return;
	}
	if (result.kind === "issue") {
		reportIssue(ctx, result.issue);
		return;
	}

	await showAnswer(question, result.answer, ctx, options.copyToClipboard);
}

/** Resolves the one-off user question from command args or an editor dialog. */
async function resolveQuestion(
	args: string,
	ctx: AskLlmCommandContext,
	options: {
		readonly resolveFdPath: () => string | null;
		readonly createAutocompleteProvider: CreateFileAutocompleteProvider;
	},
): Promise<string | undefined> {
	const inlineQuestion = args.trim();
	if (inlineQuestion.length > 0) {
		return inlineQuestion;
	}

	const autocompleteProvider = options.createAutocompleteProvider(
		ctx.cwd,
		options.resolveFdPath(),
	);
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) =>
			new AskQuestionDialog({
				tui,
				theme,
				...(autocompleteProvider === undefined ? {} : { autocompleteProvider }),
				onDone: done,
			}),
		ASK_LLM_OVERLAY_OPTIONS,
	);
}

/** Shows cancellable progress while the model call is running. */
async function runWithLoader(
	ctx: AskLlmCommandContext,
	question: string,
	options: {
		readonly completeSimple: NonNullable<AskLlmDependencies["completeSimple"]>;
		readonly currentThinkingLevel: unknown;
		readonly loadedSkillRoots: readonly string[];
		readonly contextFiles: readonly ProjectContextFile[];
	},
): Promise<AskLlmResult> {
	return ctx.ui.custom<AskLlmResult>((_tui, theme, _keybindings, done) => {
		const loader = new AskLoadingDialog(theme);
		loader.onAbort = () => done({ kind: "cancelled" });

		executeAskLlm({
			completeSimple: options.completeSimple,
			question,
			ctx,
			currentThinkingLevel: options.currentThinkingLevel,
			loadedSkillRoots: options.loadedSkillRoots,
			contextFiles: options.contextFiles,
			signal: loader.signal,
		})
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done({ kind: "cancelled" });
					return;
				}
				done({ kind: "issue", issue: formatError(error) });
			});

		return loader;
	}, ASK_LLM_OVERLAY_OPTIONS);
}

/** Executes one direct model call with config, prompt, model, and auth validation. */
async function executeAskLlm({
	completeSimple,
	question,
	ctx,
	currentThinkingLevel,
	loadedSkillRoots,
	contextFiles,
	signal,
}: {
	readonly completeSimple: NonNullable<AskLlmDependencies["completeSimple"]>;
	readonly question: string;
	readonly ctx: AskLlmCommandContext;
	readonly currentThinkingLevel: unknown;
	readonly loadedSkillRoots: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
	readonly signal: AbortSignal | undefined;
}): Promise<AskLlmResult> {
	const configResult = await readAskLlmConfig();
	if ("disabled" in configResult) {
		return { kind: "issue", issue: "ask-llm is disabled" };
	}
	if ("issue" in configResult) {
		return { kind: "issue", issue: configResult.issue };
	}

	const promptResult = await readSystemPrompt(
		configResult.config.systemPromptFile,
	);
	if ("issue" in promptResult) {
		return { kind: "issue", issue: promptResult.issue };
	}

	const runtimeResult = await resolveAuxiliaryLlmRuntime(
		ctx,
		configResult.config.model?.id,
	);
	if ("issue" in runtimeResult) {
		return { kind: "issue", issue: runtimeResult.issue };
	}

	const context = await buildContext({
		ctx,
		systemPrompt: promptResult.prompt,
		question,
		loadedSkillRoots,
		contextFiles,
	});
	if (
		!doesAuxiliaryLlmInputFitContextWindow(context, runtimeResult.runtime.model)
	) {
		return {
			kind: "issue",
			issue: "ask-llm input exceeds model context window",
		};
	}

	const response = await executeAskLlmModelWithRetry({
		completeSimple,
		runtime: runtimeResult.runtime,
		context,
		options: buildAuxiliaryLlmOptions(
			configResult.config.model?.thinking ??
				parseThinking(currentThinkingLevel),
			signal,
			runtimeResult.runtime,
		),
		retry: configResult.config.retry,
	});
	if ("issue" in response) {
		return { kind: "issue", issue: response.issue };
	}
	if (signal?.aborted === true || response.stopReason === "aborted") {
		return { kind: "cancelled" };
	}
	if (response.stopReason === "error") {
		return {
			kind: "issue",
			issue: response.errorMessage ?? "model provider returned an error",
		};
	}

	const answer = getAuxiliaryLlmResponseText(response);
	if (answer.length === 0) {
		return { kind: "issue", issue: "model response did not contain text" };
	}

	return { kind: "success", answer };
}

/** Builds a model context from the current branch without storing the ask command turn. */
async function buildContext({
	ctx,
	systemPrompt,
	question,
	loadedSkillRoots,
	contextFiles,
}: {
	readonly ctx: AskLlmCommandContext;
	readonly systemPrompt: string;
	readonly question: string;
	readonly loadedSkillRoots: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
}): Promise<Context> {
	const projectedMessages = await replayContextProjection({
		branchEntries: ctx.sessionManager.getBranch(),
		cwd: ctx.cwd,
		loadedSkillRoots,
	});
	const messages = convertToLlm(projectedMessages);
	messages.push({
		role: "user",
		content: formatUserQuestion(question),
		timestamp: Date.now(),
	});

	return {
		systemPrompt: appendProjectContext(systemPrompt, contextFiles),
		messages,
		tools: [],
	};
}

/** Wraps the question as data so the system prompt can name the exact input boundary. */
function formatUserQuestion(question: string): string {
	return `<${USER_QUESTION_TAG}>\n${escapeUTF8(question)}\n</${USER_QUESTION_TAG}>`;
}

/** Reads ask-llm config from suite storage only. */
async function readAskLlmConfigFile(): Promise<ConfigFileReadResult> {
	const location = getSuiteConfigLocation(ASK_LLM_EXTENSION_DIR);
	try {
		return {
			kind: "found",
			file: {
				directory: location.directory,
				content: await readFile(location.path, "utf8"),
			},
		};
	} catch (error) {
		return isFileNotFoundError(error)
			? { kind: "missing" }
			: { kind: "read-error", error };
	}
}

/** Synchronously reads ask-llm config from suite storage only. */
function readAskLlmConfigFileSync(): ConfigFileReadResult {
	const location = getSuiteConfigLocation(ASK_LLM_EXTENSION_DIR);
	try {
		return {
			kind: "found",
			file: {
				directory: location.directory,
				content: readFileSync(location.path, "utf8"),
			},
		};
	} catch (error) {
		return isFileNotFoundError(error)
			? { kind: "missing" }
			: { kind: "read-error", error };
	}
}

/** Reads config from suite storage while defaulting missing config to enabled. */
async function readAskLlmConfig(): Promise<ConfigReadResult> {
	const configFile = await readAskLlmConfigFile();
	if (configFile.kind === "missing") {
		return { config: buildConfig({}, "") };
	}
	if (configFile.kind === "read-error") {
		return { issue: `failed to read config: ${formatError(configFile.error)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(configFile.file.content);
	} catch (error) {
		return { issue: `failed to parse config: ${formatError(error)}` };
	}

	const validation = validateConfig(parsed);
	if ("issue" in validation || "disabled" in validation) {
		return validation;
	}

	return { config: buildConfig(validation.config, configFile.file.directory) };
}

/** Returns true only when config explicitly disables ask-llm. */
function isAskLlmDisabled(): boolean {
	const configFile = readAskLlmConfigFileSync();
	if (configFile.kind !== "found") {
		return false;
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);
		return isRecord(config) && config[ENABLED_CONFIG_KEY] === false;
	} catch {
		return false;
	}
}

/** Fails startup when enabled config uses a non-absolute custom system prompt path. */
function assertSystemPromptFileIsAbsolute(): void {
	const configFile = readAskLlmConfigFileSync();
	if (configFile.kind !== "found") {
		return;
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);
		if (!isRecord(config) || config[ENABLED_CONFIG_KEY] === false) {
			return;
		}
		const systemPromptFile = config[SYSTEM_PROMPT_FILE_CONFIG_KEY];
		if (typeof systemPromptFile === "string" && !isAbsolute(systemPromptFile)) {
			throw new Error(
				`${ISSUE_PREFIX} ${SYSTEM_PROMPT_FILE_CONFIG_KEY} must be an absolute path`,
			);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(ISSUE_PREFIX)) {
			throw error;
		}
	}
}

/** Validates raw config before the command trusts any runtime value. */
function validateConfig(
	value: unknown,
):
	| { readonly config: Record<string, unknown> }
	| { readonly disabled: true }
	| { readonly issue: string } {
	if (!isRecord(value)) {
		return { issue: "config must be an object" };
	}
	if (
		!hasOnlyKeys(value, [
			ENABLED_CONFIG_KEY,
			"model",
			SYSTEM_PROMPT_FILE_CONFIG_KEY,
			RETRY_CONFIG_KEY,
		])
	) {
		return { issue: "config contains unsupported keys" };
	}

	const enabled = value[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { issue: `${ENABLED_CONFIG_KEY} must be a boolean` };
	}
	if (enabled === false) {
		return { disabled: true };
	}

	const modelIssue = validateModelConfig(value["model"]);
	if (modelIssue !== undefined) {
		return { issue: modelIssue };
	}

	const retryIssue = validateRetryConfig(
		value[RETRY_CONFIG_KEY],
		RETRY_CONFIG_KEY,
	);
	if (retryIssue !== undefined) {
		return { issue: retryIssue };
	}

	const systemPromptFile = value[SYSTEM_PROMPT_FILE_CONFIG_KEY];
	if (
		systemPromptFile !== undefined &&
		(typeof systemPromptFile !== "string" || systemPromptFile.length === 0)
	) {
		return {
			issue: `${SYSTEM_PROMPT_FILE_CONFIG_KEY} must be a non-empty string`,
		};
	}
	if (typeof systemPromptFile === "string" && !isAbsolute(systemPromptFile)) {
		return {
			issue: `${SYSTEM_PROMPT_FILE_CONFIG_KEY} must be an absolute path`,
		};
	}

	return { config: value };
}

/** Validates optional model config object and accepted thinking values. */
function validateModelConfig(model: unknown): string | undefined {
	if (model === undefined) {
		return undefined;
	}
	if (!isRecord(model)) {
		return "model must be an object";
	}
	if (!hasOnlyKeys(model, ["id", "thinking"])) {
		return "model contains unsupported keys";
	}

	const { id, thinking } = model;
	if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
		return "model.id must be a non-empty string";
	}
	if (typeof id === "string" && !hasProviderModelShape(id)) {
		return "model.id must use provider/model";
	}
	if (thinking !== undefined && !isThinking(thinking)) {
		return `model.thinking must be one of ${REASONING_LEVELS.join(", ")}`;
	}

	return undefined;
}

/** Builds the typed config after raw validation succeeds. */
function buildConfig(
	config: Record<string, unknown>,
	_configDir: string,
): AskLlmConfig {
	const rawModel = config["model"];
	const model = isRecord(rawModel)
		? {
				...(typeof rawModel["id"] === "string" ? { id: rawModel["id"] } : {}),
				...(isThinking(rawModel["thinking"])
					? { thinking: rawModel["thinking"] }
					: {}),
			}
		: undefined;
	const systemPromptFile = config[SYSTEM_PROMPT_FILE_CONFIG_KEY];
	return {
		...(model !== undefined ? { model } : {}),
		systemPromptFile:
			typeof systemPromptFile === "string"
				? systemPromptFile
				: DEFAULT_SYSTEM_PROMPT_FILE,
		retry: buildRetryConfig(config[RETRY_CONFIG_KEY]),
	};
}

/** Reads the selected system prompt and rejects empty files. */
async function readSystemPrompt(path: string): Promise<PromptReadResult> {
	try {
		const prompt = await readFile(path, "utf8");
		if (prompt.trim().length === 0) {
			return { issue: "system prompt must not be empty" };
		}
		return { prompt: prompt.trim() };
	} catch (error) {
		return { issue: `failed to read system prompt: ${formatError(error)}` };
	}
}

async function executeAskLlmModelWithRetry({
	completeSimple,
	runtime,
	context,
	options,
	retry,
}: {
	readonly completeSimple: NonNullable<AskLlmDependencies["completeSimple"]>;
	readonly runtime: AuxiliaryLlmRuntime;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
	readonly retry: RetryConfig;
}): Promise<AssistantMessage | { readonly issue: string }> {
	try {
		return await withRetry(
			async () => {
				const answer = await completeAuxiliaryLlm(
					completeSimple,
					runtime,
					context,
					options,
				);
				if (answer.stopReason === "error") {
					throw createRetryableExternalError(
						answer.errorMessage ?? "model provider returned an error",
					);
				}
				return answer;
			},
			{ retry, signal: options.signal },
		);
	} catch (error) {
		return { issue: `Ask LLM request failed: ${formatError(error)}` };
	}
}

/** Shows the question and answer in focused UI without appending them to the session. */
async function showAnswer(
	question: string,
	answer: string,
	ctx: AskLlmCommandContext,
	copyToClipboard: NonNullable<AskLlmDependencies["copyToClipboard"]>,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new AskAnswerDialog({
				tui,
				theme,
				question,
				answer,
				onCopyAnswer: async () => {
					try {
						await copyToClipboard(answer);
						ctx.ui.notify("Answer copied to clipboard", "info");
					} catch (error) {
						reportIssue(
							ctx,
							`failed to copy answer to clipboard: ${formatError(error)}`,
						);
					}
				},
				onDone: () => done(undefined),
			}),
		ASK_LLM_OVERLAY_OPTIONS,
	);
}

/** Reports an ask-llm issue only through UI warnings. */
function reportIssue(ctx: AskLlmCommandContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Returns true when a model ID contains provider and model parts separated by slash. */
function hasProviderModelShape(modelId: string): boolean {
	const separatorIndex = modelId.indexOf("/");
	return separatorIndex > 0 && separatorIndex < modelId.length - 1;
}

/** Returns true when an object contains only supported keys. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a runtime value is an accepted thinking value. */
function isThinking(value: unknown): value is Thinking {
	return isReasoningLevel(value);
}

/** Parses an unknown active thinking level into a model reasoning value. */
function parseThinking(value: unknown): Thinking | undefined {
	return isThinking(value) ? value : undefined;
}

/** Formats unknown failures for scoped user-visible diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
