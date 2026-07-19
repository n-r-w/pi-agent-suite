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
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";
import { createAuxiliaryLlmSessionId } from "../../shared/auxiliary-llm-session";
import {
	replayContextProjection,
	replayRetainedContextProjection,
} from "../../shared/context-projection";
import {
	type CustomCompactionConfig,
	readCustomCompactionConfig,
} from "../../shared/custom-compaction-config";
import { recordHelperApiCost } from "../../shared/helper-api-cost";
import {
	isReasoningLevel,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
import {
	type AdaptiveCompactionProgressEvent,
	type AdaptiveCompactionRequest,
	adaptiveCompactHistory,
} from "./adaptive-compaction";

/** Suite directory owned by custom-compaction configuration. */
const CUSTOM_COMPACTION_EXTENSION_DIR = "custom-compaction";

/** Extension-local prompt directory. */
const DEFAULT_PROMPT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

/** Prompt fields that users may override with absolute files. */
const CONFIGURABLE_PROMPT_KEYS = [
	"systemPromptFile",
	"historyPromptFile",
	"updatePromptFile",
] as const;

/** Bundled prompt files used by adaptive compaction. */
const DEFAULT_PROMPT_FILES = {
	systemPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-system.md"),
	historyPromptFile: join(DEFAULT_PROMPT_DIR, "compaction.md"),
	updatePromptFile: join(DEFAULT_PROMPT_DIR, "compaction-update.md"),
	reductionPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-reduction.md"),
} as const;

/** Prefix for user-visible custom-compaction diagnostics. */
const ISSUE_PREFIX = "[custom-compaction]";

/** Extra local margin kept beyond provider request framing estimates. */
const ADAPTIVE_SAFETY_MARGIN_TOKENS = 256;

/** Prompt text required by final and intermediate summarization requests. */
interface CustomCompactionPrompts {
	readonly systemPrompt: string;
	readonly historyPrompt: string;
	readonly updatePrompt: string;
	readonly reductionPrompt: string;
}

/** Model and reasoning selected for all requests in one compaction attempt. */
interface CustomCompactionRuntime {
	readonly model: Model<Api>;
	readonly reasoning: ReasoningLevel | undefined;
}

/** Authentication material resolved for the selected summarization model. */
interface ModelAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

/** Complete request dependencies resolved before adaptive work starts. */
interface ResolvedCompactionRequest {
	readonly config: CustomCompactionConfig;
	readonly prompts: CustomCompactionPrompts;
	readonly runtime: CustomCompactionRuntime;
	readonly auth: ModelAuth;
}

/** Minimal UI and model registry contract consumed from Pi context. */
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

/** Registers adaptive compaction for Pi's pre-compaction lifecycle event. */
export default function customCompaction(pi: ExtensionAPI): void {
	assertConfiguredPromptPathsAreAbsolute();
	pi.on("session_before_compact", (event, ctx) =>
		handleSessionBeforeCompact(pi, event, ctx),
	);
}

/** Runs one fixed-boundary adaptive compaction attempt. */
async function handleSessionBeforeCompact(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<{ readonly compaction: CompactionResult } | undefined> {
	const session = ctx as unknown as CustomCompactionSession;
	const resolved = await resolveCompactionRequest(
		session,
		pi.getThinkingLevel(),
	);
	if (resolved === undefined) {
		return undefined;
	}
	if (ctx.model === undefined) {
		reportIssue(session, "current main model is unavailable");
		return undefined;
	}

	try {
		const [currentProjectedMainMessages, projectedRetainedMessages] =
			await Promise.all([
				replayContextProjection({
					branchEntries: event.branchEntries,
					cwd: ctx.cwd,
				}),
				replayRetainedContextProjection({
					branchEntries: event.branchEntries,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					cwd: ctx.cwd,
				}),
			]);
		const baseCompletionOptions = buildCompletionOptions(
			resolved.runtime,
			resolved.auth,
		);
		const summary = await adaptiveCompactHistory({
			preparation: event.preparation,
			summarySystemPrompt: resolved.prompts.systemPrompt,
			finalPrompt: buildFinalPrompt(resolved.prompts, event),
			reductionPrompt: resolved.prompts.reductionPrompt,
			summarizationModel: resolved.runtime.model,
			mainModel: ctx.model,
			currentProjectedMainMessages,
			projectedRetainedMessages,
			mainSystemPrompt: ctx.getSystemPrompt(),
			activeTools: collectActiveTools(pi),
			mainModelReserveTokens: event.preparation.settings.reserveTokens,
			safetyMarginTokens: ADAPTIVE_SAFETY_MARGIN_TOKENS,
			retry: resolved.config.retry,
			signal: event.signal,
			createRequestId: createAuxiliaryLlmSessionId,
			onProgress: (progress) => reportProgress(session, progress),
			complete: (request) =>
				executeCompletion(
					pi,
					resolved.runtime.model,
					baseCompletionOptions,
					request,
				),
		});

		return { compaction: buildCompactionResult(event, summary) };
	} catch (error) {
		reportIssue(session, formatError(error));
		return undefined;
	}
}

/** Resolves validated config, prompts, model, reasoning, and authentication. */
async function resolveCompactionRequest(
	session: CustomCompactionSession,
	currentThinkingLevel: unknown,
): Promise<ResolvedCompactionRequest | undefined> {
	const configResult = await readCustomCompactionConfig();
	if (configResult.kind === "disabled") {
		return undefined;
	}
	if (configResult.kind === "invalid") {
		reportIssue(session, configResult.issue);
		return undefined;
	}

	const prompts = await readPromptFiles(configResult.config);
	if (typeof prompts === "string") {
		reportIssue(session, prompts);
		return undefined;
	}

	const runtime = resolveRuntime(
		session,
		configResult.config,
		currentThinkingLevel,
	);
	if (typeof runtime === "string") {
		reportIssue(session, runtime);
		return undefined;
	}

	const auth = await session.modelRegistry.getApiKeyAndHeaders(runtime.model);
	if (!auth.ok) {
		reportIssue(session, `failed to resolve model auth: ${auth.error}`);
		return undefined;
	}

	return {
		config: configResult.config,
		prompts,
		runtime,
		auth,
	};
}

/** Resolves bundled and configured prompt files without partial acceptance. */
async function readPromptFiles(
	config: CustomCompactionConfig,
): Promise<CustomCompactionPrompts | string> {
	const paths = {
		systemPromptFile:
			config.systemPromptFile ?? DEFAULT_PROMPT_FILES.systemPromptFile,
		historyPromptFile:
			config.historyPromptFile ?? DEFAULT_PROMPT_FILES.historyPromptFile,
		updatePromptFile:
			config.updatePromptFile ?? DEFAULT_PROMPT_FILES.updatePromptFile,
		reductionPromptFile: DEFAULT_PROMPT_FILES.reductionPromptFile,
	};
	const entries = await Promise.all(
		Object.entries(paths).map(async ([key, path]) => {
			try {
				const content = (await readFile(path, "utf8")).trim();
				return content.length === 0
					? { key, issue: `${key} must not be empty` }
					: { key, content };
			} catch (error) {
				return { key, issue: `failed to read ${key}: ${formatError(error)}` };
			}
		}),
	);
	const invalid = entries.find(
		(entry): entry is { readonly key: string; readonly issue: string } =>
			"issue" in entry,
	);
	if (invalid !== undefined) {
		return invalid.issue;
	}
	const contentByKey = Object.fromEntries(
		entries.map((entry) => [entry.key, entry.content]),
	);
	return {
		systemPrompt: contentByKey["systemPromptFile"] ?? "",
		historyPrompt: contentByKey["historyPromptFile"] ?? "",
		updatePrompt: contentByKey["updatePromptFile"] ?? "",
		reductionPrompt: contentByKey["reductionPromptFile"] ?? "",
	};
}

/** Selects the configured summarization model or the current main model. */
function resolveRuntime(
	session: CustomCompactionSession,
	config: CustomCompactionConfig,
	currentThinkingLevel: unknown,
): CustomCompactionRuntime | string {
	let model = session.model;
	if (config.model !== undefined) {
		const modelId = splitModelId(config.model);
		if (modelId === undefined) {
			return "model must use provider/model";
		}
		model = session.modelRegistry.find(modelId.provider, modelId.modelId);
		if (model === undefined) {
			return `model ${config.model} was not found`;
		}
	}
	if (model === undefined) {
		return "current model is unavailable";
	}

	return {
		model,
		reasoning:
			config.reasoning ??
			(isReasoningLevel(currentThinkingLevel)
				? currentThinkingLevel
				: undefined),
	};
}

/** Calls the selected model and records cost for every completed response. */
async function executeCompletion(
	pi: ExtensionAPI,
	model: Model<Api>,
	baseOptions: SimpleStreamOptions,
	request: AdaptiveCompactionRequest,
): Promise<AssistantMessage> {
	const response = await completeSimple(model, request.context, {
		...baseOptions,
		signal: request.signal,
		sessionId: request.requestId,
		maxTokens: request.maxTokens,
	});
	recordHelperApiCost(pi, "custom-compaction", response);
	return response;
}

/** Builds model options shared by all logical requests in an attempt. */
function buildCompletionOptions(
	runtime: CustomCompactionRuntime,
	auth: ModelAuth,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {};
	if (auth.apiKey !== undefined) {
		options.apiKey = auth.apiKey;
	}
	if (auth.headers !== undefined) {
		options.headers = auth.headers;
	}
	if (runtime.reasoning !== undefined && runtime.reasoning !== "off") {
		options.reasoning = runtime.reasoning;
	}
	return options;
}

/** Adds manual compaction focus only to the final summarization prompt. */
function buildFinalPrompt(
	prompts: CustomCompactionPrompts,
	event: SessionBeforeCompactEvent,
): string {
	const prompt =
		event.preparation.previousSummary === undefined
			? prompts.historyPrompt
			: prompts.updatePrompt;
	const customInstructions = event.customInstructions?.trim();
	return customInstructions === undefined || customInstructions.length === 0
		? prompt
		: `${prompt}\n\nAdditional focus: ${customInstructions}`;
}

/** Returns only active public tool schemas for prospective main-request sizing. */
function collectActiveTools(pi: ExtensionAPI): NonNullable<Context["tools"]> {
	const activeNames = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
}

/** Builds the durable Pi result with its original boundary and file operations. */
function buildCompactionResult(
	event: SessionBeforeCompactEvent,
	summary: string,
): CompactionResult<{
	readonly readFiles: readonly string[];
	readonly modifiedFiles: readonly string[];
}> {
	const files = computeFileLists(event.preparation.fileOps);
	return {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: files,
	};
}

/** Converts Pi file-operation sets into deterministic non-overlapping lists. */
function computeFileLists(fileOps: {
	readonly read: Set<string>;
	readonly written: Set<string>;
	readonly edited: Set<string>;
}): { readonly readFiles: string[]; readonly modifiedFiles: string[] } {
	const modifiedFiles = [
		...new Set([...fileOps.written, ...fileOps.edited]),
	].sort();
	const modified = new Set(modifiedFiles);
	const readFiles = [...fileOps.read]
		.filter((path) => !modified.has(path))
		.sort();
	return { readFiles, modifiedFiles };
}

/** Rejects configured relative prompt paths during extension loading. */
function assertConfiguredPromptPathsAreAbsolute(): void {
	const configFile = readSuiteConfigFileSync(CUSTOM_COMPACTION_EXTENSION_DIR);
	if (configFile.kind !== "found") {
		return;
	}
	try {
		const config: unknown = JSON.parse(configFile.file.content);
		if (!isRecord(config) || config["enabled"] === false) {
			return;
		}
		for (const key of CONFIGURABLE_PROMPT_KEYS) {
			const path = config[key];
			if (typeof path === "string" && !isAbsolute(path)) {
				throw new Error(`${ISSUE_PREFIX} ${key} must be an absolute path`);
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(ISSUE_PREFIX)) {
			throw error;
		}
	}
}

/** Splits a validated provider/model identifier at its first slash. */
function splitModelId(
	value: string,
): { readonly provider: string; readonly modelId: string } | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator >= value.length - 1) {
		return undefined;
	}
	return {
		provider: value.slice(0, separator),
		modelId: value.slice(separator + 1),
	};
}

/** Maps typed engine progress to informational Pi UI notifications. */
async function reportProgress(
	session: CustomCompactionSession,
	event: AdaptiveCompactionProgressEvent,
): Promise<void> {
	if (session.hasUI === false) {
		return;
	}
	let message: string;
	switch (event.type) {
		case "start":
			message = "adaptive compaction started";
			break;
		case "operation":
			message = `adaptive compaction operation: ${event.operation}`;
			break;
		case "retry":
			message = `retrying ${event.operation}: attempt ${event.nextAttempt}/${event.totalAttempts}`;
			break;
		case "complete":
			message = `adaptive compaction completed: ${event.completedRequests} model requests`;
			break;
	}
	session.ui.notify(`${ISSUE_PREFIX} ${message}`, "info");
	if (event.type === "start") {
		// Pi can repaint the published start state before synchronous token planning begins.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

/** Reports an exact warning only when Pi has an interactive UI. */
function reportIssue(session: CustomCompactionSession, issue: string): void {
	if (session.hasUI === false) {
		return;
	}
	session.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Returns whether unknown JSON is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats unknown failures for concise user-visible diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
