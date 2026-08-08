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
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
	assertThinkingLevelSupported,
	splitModelId,
} from "../../shared/model-settings";
import {
	isReasoningLevel,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
import { resolveModelSettingsWithAliasesSync } from "../model-aliases/config";
import {
	type AdaptiveCompactionProgressEvent,
	type AdaptiveCompactionRequest,
	adaptiveCompactHistory,
} from "./adaptive-compaction";
import {
	type CompactionSourceProjectionProgressEvent,
	projectCompactionSource,
} from "./compaction-source-projection";

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
	"fileCandidatesPromptFile",
	"reductionSystemPromptFile",
	"reductionPromptFile",
] as const;

/** Bundled prompt files used by adaptive compaction. */
const DEFAULT_PROMPT_FILES = {
	systemPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-system.md"),
	historyPromptFile: join(DEFAULT_PROMPT_DIR, "compaction.md"),
	updatePromptFile: join(DEFAULT_PROMPT_DIR, "compaction-update.md"),
	fileCandidatesPromptFile: join(
		DEFAULT_PROMPT_DIR,
		"compaction-file-candidates.md",
	),
	reductionSystemPromptFile: join(
		DEFAULT_PROMPT_DIR,
		"compaction-reduction-system.md",
	),
	reductionPromptFile: join(DEFAULT_PROMPT_DIR, "compaction-reduction.md"),
} as const;

/** Prefix for user-visible custom-compaction diagnostics. */
const ISSUE_PREFIX = "[custom-compaction]";

/** TUI-only session entry that preserves the terminal compaction outcome. */
const CUSTOM_COMPACTION_OUTCOME_ENTRY = "custom-compaction-outcome";

/** Maximum persisted outcome length accepted by the TUI renderer. */
const OUTCOME_MESSAGE_LIMIT = 2_000;

/** Extra local margin kept beyond provider request framing estimates. */
const ADAPTIVE_SAFETY_MARGIN_TOKENS = 256;

/** Final-prompt macro replaced by the rendered file-candidate fragment. */
const FILE_CANDIDATES_MACRO = "{{fileCandidates}}";

/** File-fragment macros replaced by deterministic operation paths. */
const READ_FILES_MACRO = "{{readFiles}}";
const MODIFIED_FILES_MACRO = "{{modifiedFiles}}";
const FILE_LIST_MACRO_PATTERN = /\{\{(?:readFiles|modifiedFiles)\}\}/gu;

/** Prompt text required by final and intermediate summarization requests. */
interface CustomCompactionPrompts {
	readonly systemPrompt: string;
	readonly historyPrompt: string;
	readonly updatePrompt: string;
	readonly fileCandidatesPrompt: string;
	readonly reductionSystemPrompt: string;
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
	readonly headers?: Record<string, string | null>;
}

/** Complete request dependencies resolved before adaptive work starts. */
interface ResolvedCompactionRequest {
	readonly config: CustomCompactionConfig;
	readonly prompts: CustomCompactionPrompts;
	readonly runtime: CustomCompactionRuntime;
	readonly auth: ModelAuth;
}

/** Projected current context and Pi's fixed retained suffix used for budgeting. */
interface ProjectedCompactionContexts {
	readonly currentProjectedMainMessages: readonly AgentMessage[];
	readonly projectedRetainedMessages: readonly AgentMessage[];
	readonly projectedToolResultSummaries: ReadonlyMap<string, string>;
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
					readonly headers?: Record<string, string | null>;
			  }
			| { readonly ok: false; readonly error: string }
		>;
	};
}

/** Deterministic file lists available to final prompt rendering and result details. */
interface CompactionFileLists {
	readonly readFiles: readonly string[];
	readonly modifiedFiles: readonly string[];
}

/** Attempt statistics used to explain adaptive work and native fallback. */
interface CompactionProgressStats {
	adaptive: boolean;
	sourceProjectionCandidates: number;
	projectedToolResults: number;
	preliminaryRanges: number;
	historyBlocks: number;
	oversizedBlocks: number;
	fragments: number;
	normalizations: number;
	merges: number;
	modelRequests: number;
	retries: number;
}

/** Progress emitted by source projection or the adaptive compaction engine. */
type CompactionProgressEvent =
	| AdaptiveCompactionProgressEvent
	| CompactionSourceProjectionProgressEvent;

/** Reports engine progress and retains statistics when an attempt fails. */
interface CompactionProgressReporter {
	readonly stats: CompactionProgressStats;
	readonly outcomeMessage: string | undefined;
	report(event: CompactionProgressEvent): Promise<void>;
	reportFailure(error: unknown): Promise<void>;
}

/** Validated payload stored for one permanent TUI-only compaction outcome. */
interface CompactionOutcomeEntryData {
	readonly kind: "success" | "fallback";
	readonly message: string;
}

/** Registers adaptive compaction for Pi's pre-compaction lifecycle event. */
export default function customCompaction(pi: ExtensionAPI): void {
	assertConfiguredPromptPathsAreAbsolute();
	pi.registerEntryRenderer(
		CUSTOM_COMPACTION_OUTCOME_ENTRY,
		(entry, _options, theme) => {
			const outcome = parseOutcomeEntryData(entry.data);
			const text =
				outcome === undefined
					? theme.fg("warning", `${ISSUE_PREFIX} invalid outcome entry`)
					: theme.fg(
							outcome.kind === "success" ? "success" : "warning",
							`${ISSUE_PREFIX} ${outcome.message}`,
						);
			return new Text(text, 0, 0);
		},
	);
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
		pi,
		session,
		pi.getThinkingLevel(),
	);
	if (resolved === undefined) {
		return undefined;
	}
	if (ctx.model === undefined) {
		await reportUnavailableMainModel(pi, session);
		return undefined;
	}

	const files = computeFileLists(event.preparation.fileOps);
	const progress = createProgressReporter(session);
	try {
		const projectedContexts = await resolveProjectedContexts(
			pi,
			event,
			ctx,
			progress,
		);
		const baseCompletionOptions = buildCompletionOptions(
			resolved.runtime,
			resolved.auth,
		);
		const summary = await adaptiveCompactHistory({
			preparation: event.preparation,
			summarySystemPrompt: resolved.prompts.systemPrompt,
			reductionSystemPrompt: resolved.prompts.reductionSystemPrompt,
			finalPrompt: buildFinalPrompt(resolved.prompts, event, files),
			reductionPrompt: resolved.prompts.reductionPrompt,
			summarizationModel: resolved.runtime.model,
			mainModel: ctx.model,
			...projectedContexts,
			mainSystemPrompt: ctx.getSystemPrompt(),
			activeTools: collectActiveTools(pi),
			mainModelReserveTokens: event.preparation.settings.reserveTokens,
			safetyMarginTokens: ADAPTIVE_SAFETY_MARGIN_TOKENS,
			retry: resolved.config.retry,
			signal: event.signal,
			createRequestId: createAuxiliaryLlmSessionId,
			onProgress: progress.report,
			complete: (request) =>
				executeCompletion(
					pi,
					resolved.runtime.model,
					baseCompletionOptions,
					request,
				),
		});

		persistOutcome(pi, session, "success", progress.outcomeMessage);
		return {
			compaction: buildCompactionResult(event, summary, files),
		};
	} catch (error) {
		await progress.reportFailure(error);
		persistOutcome(pi, session, "fallback", progress.outcomeMessage);
		return undefined;
	}
}

/** Reports the pre-request fallback used when Pi has no active main model. */
async function reportUnavailableMainModel(
	pi: ExtensionAPI,
	session: CustomCompactionSession,
): Promise<void> {
	const message = await reportStandardFallback(
		session,
		"current main model is unavailable",
	);
	persistOutcome(pi, session, "fallback", message);
}

/** Replays existing projection for the current context and fixed retained suffix. */
async function resolveProjectedContexts(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	progress: CompactionProgressReporter,
): Promise<ProjectedCompactionContexts> {
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
	const projectedToolResultSummaries = await projectCompactionSource({
		pi,
		event,
		ctx,
		currentProjectedMainMessages,
		currentThinking: pi.getThinkingLevel(),
		completeSimple,
		onProgress: progress.report,
	});
	event.signal.throwIfAborted();
	return {
		currentProjectedMainMessages,
		projectedRetainedMessages,
		projectedToolResultSummaries,
	};
}

/** Resolves validated config, prompts, model, reasoning, and authentication. */
async function resolveCompactionRequest(
	pi: ExtensionAPI,
	session: CustomCompactionSession,
	currentThinkingLevel: unknown,
): Promise<ResolvedCompactionRequest | undefined> {
	const configResult = await readCustomCompactionConfig();
	if (configResult.kind === "disabled") {
		return undefined;
	}
	if (configResult.kind === "invalid") {
		await reportAndPersistFallback(pi, session, configResult.issue);
		return undefined;
	}

	const prompts = await readPromptFiles(configResult.config);
	if (typeof prompts === "string") {
		await reportAndPersistFallback(pi, session, prompts);
		return undefined;
	}

	const runtime = resolveRuntime(
		session,
		configResult.config,
		currentThinkingLevel,
	);
	if (typeof runtime === "string") {
		await reportAndPersistFallback(pi, session, runtime);
		return undefined;
	}

	const auth = await session.modelRegistry.getApiKeyAndHeaders(runtime.model);
	if (!auth.ok) {
		await reportAndPersistFallback(
			pi,
			session,
			`failed to resolve model auth: ${auth.error}`,
		);
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
		fileCandidatesPromptFile:
			config.fileCandidatesPromptFile ??
			DEFAULT_PROMPT_FILES.fileCandidatesPromptFile,
		reductionSystemPromptFile:
			config.reductionSystemPromptFile ??
			DEFAULT_PROMPT_FILES.reductionSystemPromptFile,
		reductionPromptFile:
			config.reductionPromptFile ?? DEFAULT_PROMPT_FILES.reductionPromptFile,
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
		fileCandidatesPrompt: contentByKey["fileCandidatesPromptFile"] ?? "",
		reductionSystemPrompt: contentByKey["reductionSystemPromptFile"] ?? "",
		reductionPrompt: contentByKey["reductionPromptFile"] ?? "",
	};
}

/** Selects the configured summarization model or the current main model. */
function resolveRuntime(
	session: CustomCompactionSession,
	config: CustomCompactionConfig,
	currentThinkingLevel: unknown,
): CustomCompactionRuntime | string {
	const resolvedSettings = resolveModelSettingsWithAliasesSync({
		...(config.model === undefined ? {} : { id: config.model }),
		...(config.reasoning === undefined ? {} : { thinking: config.reasoning }),
	});
	if ("issue" in resolvedSettings) {
		return resolvedSettings.issue;
	}

	let model = session.model;
	if (resolvedSettings.settings.id !== undefined) {
		const { provider, id } = splitModelId(resolvedSettings.settings.id);
		model = session.modelRegistry.find(provider, id);
		if (model === undefined) {
			return `model ${resolvedSettings.settings.id} was not found`;
		}
	}
	if (model === undefined) {
		return "current model is unavailable";
	}

	const reasoning =
		resolvedSettings.settings.thinking ??
		(isReasoningLevel(currentThinkingLevel) ? currentThinkingLevel : undefined);
	if (reasoning !== undefined) {
		try {
			assertThinkingLevelSupported(model, reasoning);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	return { model, reasoning };
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

/** Renders file-operation candidates and manual focus into the selected final prompt. */
function buildFinalPrompt(
	prompts: CustomCompactionPrompts,
	event: SessionBeforeCompactEvent,
	files: CompactionFileLists,
): string {
	const template =
		event.preparation.previousSummary === undefined
			? prompts.historyPrompt
			: prompts.updatePrompt;
	const fileCandidates = renderFileCandidatesPrompt(
		prompts.fileCandidatesPrompt,
		files,
	);
	const prompt = template.replaceAll(FILE_CANDIDATES_MACRO, fileCandidates);
	const customInstructions = event.customInstructions?.trim();
	return customInstructions === undefined || customInstructions.length === 0
		? prompt
		: `${prompt}\n\nAdditional focus: ${customInstructions}`;
}

/** Returns no file guidance when Pi reported no file operations. */
function renderFileCandidatesPrompt(
	template: string,
	files: CompactionFileLists,
): string {
	if (files.readFiles.length === 0 && files.modifiedFiles.length === 0) {
		return "";
	}
	const readFiles = files.readFiles.join("\n");
	const modifiedFiles = files.modifiedFiles.join("\n");
	return template.replace(FILE_LIST_MACRO_PATTERN, (macro) => {
		if (macro === READ_FILES_MACRO) {
			return readFiles;
		}
		return macro === MODIFIED_FILES_MACRO ? modifiedFiles : macro;
	});
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
	files: CompactionFileLists,
): CompactionResult<CompactionFileLists> {
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
}): CompactionFileLists {
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

/** Creates one progress reporter that survives failed adaptive attempts. */
function createProgressReporter(
	session: CustomCompactionSession,
): CompactionProgressReporter {
	let outcomeMessage: string | undefined;
	const stats: CompactionProgressStats = {
		adaptive: false,
		sourceProjectionCandidates: 0,
		projectedToolResults: 0,
		preliminaryRanges: 0,
		historyBlocks: 0,
		oversizedBlocks: 0,
		fragments: 0,
		normalizations: 0,
		merges: 0,
		modelRequests: 0,
		retries: 0,
	};
	return {
		stats,
		get outcomeMessage(): string | undefined {
			return outcomeMessage;
		},
		async report(event): Promise<void> {
			recordProgress(stats, event);
			if (event.type === "complete") {
				outcomeMessage = formatCompletionMessage(stats);
			}
			await reportProgress(session, event, stats);
		},
		async reportFailure(error): Promise<void> {
			outcomeMessage = await reportStandardFallback(
				session,
				formatError(error),
				stats,
			);
		},
	};
}

/** Updates cumulative attempt statistics from one typed engine event. */
function recordProgress(
	stats: CompactionProgressStats,
	event: CompactionProgressEvent,
): void {
	if (event.type === "source-projection-request") {
		stats.modelRequests += 1;
		return;
	}
	if (event.type === "source-projection") {
		if (event.completed === 0) {
			stats.sourceProjectionCandidates += event.total;
		}
		if (event.projected !== undefined) {
			stats.projectedToolResults += event.projected;
		}
		return;
	}
	if (event.type === "source-projection-retry") {
		stats.retries += 1;
		return;
	}
	if (event.type === "split") {
		stats.adaptive = true;
		stats.oversizedBlocks += 1;
		stats.fragments += event.fragments;
		return;
	}
	if (event.type === "retry") {
		stats.retries += 1;
		return;
	}
	if (event.type !== "operation") {
		return;
	}

	stats.modelRequests += 1;
	if (event.operation === "final") {
		return;
	}
	stats.adaptive = true;
	switch (event.operation) {
		case "preliminary":
			stats.preliminaryRanges += 1;
			stats.historyBlocks += event.sourceBlocks ?? 0;
			break;
		case "normalization":
			stats.normalizations += 1;
			break;
		case "merge":
			stats.merges += 1;
			break;
		case "fragment":
			break;
	}
}

/** Maps typed engine progress to concrete informational Pi UI messages. */
async function reportProgress(
	session: CustomCompactionSession,
	event: CompactionProgressEvent,
	stats: CompactionProgressStats,
): Promise<void> {
	if (session.hasUI === false || event.type === "source-projection-request") {
		return;
	}
	const message = formatProgressMessage(event, stats);
	session.ui.notify(`${ISSUE_PREFIX} ${message}`, "info");
	if (
		event.type === "start" ||
		event.type === "planning" ||
		event.type === "complete" ||
		(event.type === "source-projection" && event.completed === 0)
	) {
		// Pi repaints start, planning, and outcome states before the next work phase or lifecycle completion replaces them.
		await yieldToEventLoop();
	}
}

/** Formats one progress event without exposing conversation or provider content. */
function formatProgressMessage(
	event: CompactionProgressEvent,
	stats: CompactionProgressStats,
): string {
	switch (event.type) {
		case "source-projection-request":
			return "creating compaction-source projection";
		case "source-projection":
			if (event.projected !== undefined) {
				return `compaction-source projection completed: ${event.projected}/${event.total} tool results projected`;
			}
			return `projecting compaction source: ${event.completed}/${event.total} tool results`;
		case "source-projection-retry":
			return `retrying compaction-source projection: attempt ${event.nextAttempt}/${event.totalAttempts}`;
		case "start":
			return "adaptive compaction started";
		case "planning":
			return "planning compaction budgets...";
		case "split":
			return `splitting oversized history block into ${event.fragments} fragments`;
		case "operation":
			return formatOperationMessage(event);
		case "retry":
			return `retrying ${formatOperationLabel(event.operation)}: attempt ${event.nextAttempt}/${event.totalAttempts}`;
		case "complete":
			return formatCompletionMessage(stats);
	}
}

/** Formats the current logical model operation with useful range details. */
function formatOperationMessage(
	event: Extract<
		AdaptiveCompactionProgressEvent,
		{ readonly type: "operation" }
	>,
): string {
	switch (event.operation) {
		case "final":
			return "creating final summary...";
		case "preliminary":
			return `summarizing ${event.sourceBlocks ?? 0} oldest history blocks...`;
		case "fragment":
			return `summarizing fragment ${event.fragmentIndex ?? 0}/${event.totalFragments ?? 0}...`;
		case "normalization":
			return "normalizing oversized previous summary...";
		case "merge":
			return "merging 2 adjacent summary nodes";
	}
}

/** Formats an operation name for retry messages. */
function formatOperationLabel(operation: string): string {
	switch (operation) {
		case "final":
			return "final summary";
		case "preliminary":
			return "history range summary";
		case "fragment":
			return "fragment summary";
		case "normalization":
			return "previous summary normalization";
		case "merge":
			return "summary merge";
		default:
			return operation;
	}
}

/** Summarizes the successful strategy, reduction work, retries, and preserved files. */
function formatCompletionMessage(stats: CompactionProgressStats): string {
	return `compaction completed: ${stats.adaptive ? "adaptive" : "direct"} summary, ${formatAttemptDetails(stats).join(", ")}`;
}

/** Returns cumulative work details shared by success and failure messages. */
function formatAttemptDetails(stats: CompactionProgressStats): string[] {
	const details: string[] = [];
	if (stats.sourceProjectionCandidates > 0) {
		details.push(
			`${stats.projectedToolResults}/${stats.sourceProjectionCandidates} tool results projected`,
		);
	}
	if (stats.preliminaryRanges > 0) {
		details.push(
			`${formatCount(stats.historyBlocks, "history block")} reduced in ${formatCount(stats.preliminaryRanges, "range")}`,
		);
	}
	if (stats.oversizedBlocks > 0) {
		details.push(
			`${formatCount(stats.oversizedBlocks, "block")} split into ${formatCount(stats.fragments, "fragment")}`,
		);
	}
	if (stats.normalizations > 0) {
		details.push("previous summary normalized");
	}
	if (stats.merges > 0) {
		details.push(formatCount(stats.merges, "merge"));
	}
	details.push(formatCount(stats.modelRequests, "model request"));
	if (stats.retries > 0) {
		details.push(formatCount(stats.retries, "retry", "retries"));
	}
	return details;
}

/** Reports a visible failure and the imminent standard-compaction fallback. */
async function reportStandardFallback(
	session: CustomCompactionSession,
	issue: string,
	stats?: CompactionProgressStats,
): Promise<string | undefined> {
	if (session.hasUI === false) {
		return undefined;
	}
	const progress =
		stats === undefined || stats.modelRequests === 0
			? "before model requests"
			: `after ${joinWithAnd(formatAttemptDetails(stats))}`;
	const message = `adaptive compaction failed ${progress}: ${issue}; using standard compaction`;
	session.ui.notify(`${ISSUE_PREFIX} ${message}`, "warning");
	await yieldToEventLoop();
	return message;
}

/** Reports and persists a fallback that occurs before engine progress starts. */
async function reportAndPersistFallback(
	pi: ExtensionAPI,
	session: CustomCompactionSession,
	issue: string,
): Promise<void> {
	const message = await reportStandardFallback(session, issue);
	persistOutcome(pi, session, "fallback", message);
}

/** Persists one terminal TUI outcome without changing compaction behavior on failure. */
function persistOutcome(
	pi: ExtensionAPI,
	session: CustomCompactionSession,
	kind: CompactionOutcomeEntryData["kind"],
	message: string | undefined,
): void {
	if (session.hasUI === false || message === undefined) {
		return;
	}
	const normalizedMessage = message.replace(/\s+/g, " ").trim();
	if (normalizedMessage.length === 0) {
		return;
	}
	try {
		pi.appendEntry(CUSTOM_COMPACTION_OUTCOME_ENTRY, {
			kind,
			message: normalizedMessage.slice(0, OUTCOME_MESSAGE_LIMIT),
		});
	} catch (error) {
		session.ui.notify(
			`${ISSUE_PREFIX} failed to persist compaction outcome: ${formatError(error)}`,
			"warning",
		);
	}
}

/** Validates persisted entry data before rendering untrusted session content. */
function parseOutcomeEntryData(
	value: unknown,
): CompactionOutcomeEntryData | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const kind = value["kind"];
	const message = value["message"];
	if (
		(kind !== "success" && kind !== "fallback") ||
		typeof message !== "string" ||
		message.length === 0 ||
		message.length > OUTCOME_MESSAGE_LIMIT
	) {
		return undefined;
	}
	return { kind, message };
}

/** Formats an integer with a singular or plural noun. */
function formatCount(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** Joins detail clauses with an explicit final conjunction. */
function joinWithAnd(parts: readonly string[]): string {
	if (parts.length <= 1) {
		return parts[0] ?? "0 model requests";
	}
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Gives Pi one macrotask turn to repaint a published notification. */
async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Returns whether unknown JSON is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats unknown failures for concise user-visible diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
