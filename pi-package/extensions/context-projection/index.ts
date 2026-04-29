import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type Context,
	completeSimple as defaultCompleteSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
	CONTEXT_PROJECTION_CUSTOM_TYPE,
	type ContextProjectionConfig,
	type ContextProjectionConfigResult,
	type ContextProjectionSummaryConfig,
	collectLoadedSkillRoots,
	collectProjectedPlaceholders,
	estimateProjectedSavedTokens,
	estimateSavedTokens,
	type MappedContextEntry,
	mapEventMessagesToBranchEntries,
	type ProjectedEntryState,
	type ProjectionDecision,
	projectContextMessages,
	publishRuntimeProjectedPlaceholders,
	readContextProjectionConfig,
} from "../../shared/context-projection";
import {
	countProjectionTextTokens,
	estimateSerializedInputTokens,
} from "../../shared/context-size";

/** Directory that stores the bundled context projection prompts. */
const DEFAULT_PROMPT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

/** Bundled system prompt used to define the summary role. */
const DEFAULT_SUMMARY_SYSTEM_PROMPT_FILE = join(
	DEFAULT_PROMPT_DIR,
	"tool-result-summary-system.md",
);

/** Bundled user prompt appended after the tool result data. */
const DEFAULT_SUMMARY_USER_PROMPT_FILE = join(
	DEFAULT_PROMPT_DIR,
	"tool-result-summary-user.md",
);

/** Footer status key owned by this extension. */
const CONTEXT_PROJECTION_STATUS_KEY = "context-projection";

/** Footer status text for an invalid projection config. */
const INVALID_STATUS_TEXT = "CP!";

/** Footer text for enabled projection when provider context is not reduced. */
const READY_STATUS_TEXT = "~0";

/** Threshold where compact token labels switch from exact counts to thousands. */
const TOKEN_COMPACT_THRESHOLD = 1_000;

interface HandleContextProjectionOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">;
	readonly event: ContextEvent;
	readonly ctx: ExtensionContext;
	readonly projectedPlaceholdersByEntryId: Map<string, string>;
	readonly publishedStatusText: string | undefined;
	readonly loadedSkillRoots: readonly string[];
	readonly completeSimple: CompleteSimple;
}

interface HandleContextProjectionResult {
	readonly contextResult: { readonly messages?: AgentMessage[] } | undefined;
	readonly statusText: string | undefined;
}

interface ContextProjectionChangeResultOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly ctx: ExtensionContext;
	readonly config: Extract<ContextProjectionConfigResult, { kind: "valid" }>;
	readonly projectedPlaceholdersByEntryId: Map<string, string>;
	readonly publishedStatusText: string | undefined;
	readonly decision: ProjectionDecision;
}

type CompleteSimple = typeof defaultCompleteSimple;

interface ContextProjectionDependencies {
	readonly completeSimple?: CompleteSimple;
}

interface SummaryRuntimeConfig {
	readonly model: Model<Api>;
	readonly thinking: ContextProjectionSummaryConfig["thinking"] | undefined;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly options: SimpleStreamOptions;
}

interface ProjectionSummaryCandidate {
	readonly entryId: string;
	readonly text: string;
	readonly message: Extract<AgentMessage, { role: "toolResult" }>;
	readonly toolCallContext: string | undefined;
}

type SummaryAttemptResult =
	| { readonly kind: "success"; readonly summary: string }
	| { readonly kind: "retryable" }
	| { readonly kind: "fatal" };

interface ProjectionDecisionOptions {
	readonly pi: Pick<ExtensionAPI, "getThinkingLevel">;
	readonly ctx: ExtensionContext;
	readonly config: ContextProjectionConfig;
	readonly mappedContext: readonly MappedContextEntry[];
	readonly projectedPlaceholdersByEntryId: Map<string, string>;
	readonly loadedSkillRoots: readonly string[];
	readonly discoverNewEntries: boolean;
	readonly completeSimple: CompleteSimple;
}

interface ProjectionProgressReporter {
	readonly total: number;
	processed: number;
	advance(): void;
	notifyCurrent(): void;
	notifyRetry(nextAttempt: number, totalAttempts: number): void;
	notifySummaryUnavailable(): void;
	notifySummaryNotSmaller(): void;
}

interface SummaryReplacementOptions {
	readonly pi: Pick<ExtensionAPI, "getThinkingLevel">;
	readonly ctx: ExtensionContext;
	readonly config: ContextProjectionConfig;
	readonly mappedContext: readonly MappedContextEntry[];
	readonly newProjectedEntries: readonly ProjectedEntryState[];
	readonly completeSimple: CompleteSimple;
	readonly progress: ProjectionProgressReporter;
}

/** Extension entry point for provider-context projection of old tool results. */
export default function contextProjection(
	pi: ExtensionAPI,
	dependencies: ContextProjectionDependencies = {},
): void {
	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	let projectedPlaceholdersByEntryId = new Map<string, string>();
	let publishedStatusText: string | undefined;
	let loadedSkillRoots: readonly string[] = [];

	const reconstructProjectionState = (ctx: {
		readonly cwd: string;
		readonly sessionManager: { getBranch(): SessionEntry[] };
	}): void => {
		projectedPlaceholdersByEntryId = collectProjectedPlaceholders(
			ctx.sessionManager.getBranch(),
		);
		publishRuntimeProjectedPlaceholders(
			ctx.cwd,
			projectedPlaceholdersByEntryId,
		);
	};

	const publishCurrentStatus = async (ctx: ExtensionContext): Promise<void> => {
		const config = await readContextProjectionConfig();
		assertNoFatalConfigIssue(config);
		publishedStatusText = publishProjectionStatus(
			ctx,
			config,
			estimateCurrentProjectedSavedTokens(
				ctx,
				config,
				projectedPlaceholdersByEntryId,
				loadedSkillRoots,
			),
			publishedStatusText,
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructProjectionState(ctx);
		await publishCurrentStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructProjectionState(ctx);
		await publishCurrentStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
	});

	pi.on("context", async (event, ctx) => {
		const result = await handleContextProjection({
			pi,
			event,
			ctx,
			projectedPlaceholdersByEntryId,
			publishedStatusText,
			loadedSkillRoots,
			completeSimple,
		});
		publishedStatusText = result.statusText;
		return result.contextResult;
	});
}

/** Handles one context event by projecting eligible tool results when the active config and usage permit it. */
async function handleContextProjection({
	pi,
	event,
	ctx,
	projectedPlaceholdersByEntryId,
	publishedStatusText,
	loadedSkillRoots,
	completeSimple,
}: HandleContextProjectionOptions): Promise<HandleContextProjectionResult> {
	const config = await readContextProjectionConfig();
	assertNoFatalConfigIssue(config);
	if (config.kind !== "valid") {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
		);
	}

	const currentProjectedSavedTokens = estimateCurrentProjectedSavedTokens(
		ctx,
		config,
		projectedPlaceholdersByEntryId,
		loadedSkillRoots,
	);
	const shouldDiscoverNewEntries = isProjectionThresholdExceeded(
		ctx,
		config.config,
	);
	if (!shouldDiscoverNewEntries && projectedPlaceholdersByEntryId.size === 0) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
			currentProjectedSavedTokens,
		);
	}

	const mappedContext = mapEventMessagesToBranchEntries(
		event.messages,
		ctx.sessionManager.getBranch(),
	);
	if (mappedContext === undefined) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
			currentProjectedSavedTokens,
		);
	}

	const decision = await createProjectionDecision({
		pi,
		ctx,
		config: config.config,
		mappedContext,
		projectedPlaceholdersByEntryId,
		loadedSkillRoots,
		discoverNewEntries: shouldDiscoverNewEntries,
		completeSimple,
	});
	if (!decision.changed) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
			currentProjectedSavedTokens,
		);
	}

	return createContextProjectionChangeResult({
		pi,
		ctx,
		config,
		projectedPlaceholdersByEntryId,
		publishedStatusText,
		decision,
	});
}

/** Creates the final projection decision, enriching new projected entries with summaries when available. */
async function createProjectionDecision({
	pi,
	ctx,
	config,
	mappedContext,
	projectedPlaceholdersByEntryId,
	loadedSkillRoots,
	discoverNewEntries,
	completeSimple,
}: ProjectionDecisionOptions): Promise<ProjectionDecision> {
	let decision = projectContextMessages({
		mappedContext,
		projectedPlaceholdersByEntryId,
		config,
		loadedSkillRoots,
		cwd: ctx.cwd,
		discoverNewEntries,
	});
	if (!decision.changed) {
		return decision;
	}
	const progress = createProjectionProgressReporter(
		ctx,
		decision.newProjectedEntries.length,
	);

	const summaryReplacementsByEntryId = await createSummaryReplacementsByEntryId(
		{
			pi,
			ctx,
			config,
			mappedContext,
			newProjectedEntries: decision.newProjectedEntries,
			completeSimple,
			progress,
		},
	);
	if (summaryReplacementsByEntryId.size === 0) {
		return decision;
	}

	decision = projectContextMessages({
		mappedContext,
		projectedPlaceholdersByEntryId,
		replacementTextByEntryId: summaryReplacementsByEntryId,
		config,
		loadedSkillRoots,
		cwd: ctx.cwd,
		discoverNewEntries,
	});
	return decision;
}

/** Shows a UI-only chat status when a new projection operation starts. */
function createProjectionProgressReporter(
	ctx: ExtensionContext,
	total: number,
): ProjectionProgressReporter {
	const progress: ProjectionProgressReporter = {
		total,
		processed: 0,
		advance(): void {
			progress.processed += 1;
			progress.notifyCurrent();
		},
		notifyCurrent(): void {
			notifyProjectionProgress(ctx, progress);
		},
		notifyRetry(nextAttempt: number, totalAttempts: number): void {
			notifyProjectionSummaryRetry(ctx, nextAttempt, totalAttempts);
		},
		notifySummaryUnavailable(): void {
			notifyProjectionSummaryUnavailable(ctx);
		},
		notifySummaryNotSmaller(): void {
			notifyProjectionSummaryNotSmaller(ctx);
		},
	};
	progress.notifyCurrent();
	return progress;
}

/** Shows current progress for UI-only projection status. */
function notifyProjectionProgress(
	ctx: ExtensionContext,
	progress: ProjectionProgressReporter,
): void {
	if (!ctx.hasUI || progress.total === 0) {
		return;
	}

	ctx.ui.notify(
		`Projecting context: ${progress.processed}/${progress.total} tool results processed`,
		"info",
	);
}

/** Shows the additional savings produced by the latest projection operation. */
function notifyProjectionCompleted(
	ctx: ExtensionContext,
	savedTokens: number,
): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		`Context projected: ~${formatSavedTokens(savedTokens)} saved`,
		"info",
	);
}

/** Shows one visible retry attempt for a failed summary request. */
function notifyProjectionSummaryRetry(
	ctx: ExtensionContext,
	nextAttempt: number,
	totalAttempts: number,
): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		`Retrying context projection summary: attempt ${nextAttempt}/${totalAttempts}`,
		"info",
	);
}

/** Shows that summary generation failed and the projected entry uses the configured placeholder. */
function notifyProjectionSummaryUnavailable(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		"Context projection summary unavailable; using placeholder",
		"info",
	);
}

/** Shows that a generated summary was rejected because it would not reduce context size. */
function notifyProjectionSummaryNotSmaller(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		"Context projection summary not smaller; using placeholder",
		"info",
	);
}

/** Builds summary replacement text for newly projected entries when summary config is enabled. */
async function createSummaryReplacementsByEntryId({
	pi,
	ctx,
	config,
	mappedContext,
	newProjectedEntries,
	completeSimple,
	progress,
}: SummaryReplacementOptions): Promise<Map<string, string>> {
	if (!config.summary.enabled || newProjectedEntries.length === 0) {
		for (const _entry of newProjectedEntries) {
			progress.advance();
		}
		return new Map();
	}

	const runtimeConfig = await resolveSummaryRuntimeConfig(
		pi,
		ctx,
		config.summary,
	);
	if (runtimeConfig === undefined) {
		for (const _entry of newProjectedEntries) {
			progress.notifySummaryUnavailable();
			progress.advance();
		}
		return new Map();
	}

	const candidates = collectNewProjectionSummaryCandidates({
		mappedContext,
		newProjectedEntries,
		progress,
	});
	if (candidates.length === 0) {
		return new Map();
	}

	const summaries = await mapWithConcurrency(
		candidates,
		config.summary.maxConcurrency,
		async (candidate) => {
			const summary = await summarizeProjectionCandidateWithRetries({
				candidate,
				runtimeConfig,
				completeSimple,
				config: config.summary,
				progress,
			});
			if (summary === undefined) {
				progress.notifySummaryUnavailable();
			}
			progress.advance();
			return summary;
		},
	);
	const replacementsByEntryId = new Map<string, string>();
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const summary = summaries[index];
		if (candidate === undefined || summary === undefined) {
			continue;
		}

		const replacement = wrapSummaryReplacement(summary, config.placeholder);
		if (
			countProjectionTextTokens(replacement) >=
			countProjectionTextTokens(candidate.text)
		) {
			progress.notifySummaryNotSmaller();
			progress.notifyCurrent();
			continue;
		}

		replacementsByEntryId.set(candidate.entryId, replacement);
	}

	return replacementsByEntryId;
}

/** Collects summary candidates for new projections and advances progress for entries skipped before provider calls. */
function collectNewProjectionSummaryCandidates({
	mappedContext,
	newProjectedEntries,
	progress,
}: {
	readonly mappedContext: readonly MappedContextEntry[];
	readonly newProjectedEntries: readonly ProjectedEntryState[];
	readonly progress: ProjectionProgressReporter;
}): ProjectionSummaryCandidate[] {
	const candidatesByEntryId = collectSummaryCandidates(mappedContext);
	const candidates: ProjectionSummaryCandidate[] = [];
	for (const projectedEntry of newProjectedEntries) {
		const candidate = candidatesByEntryId.get(projectedEntry.entryId);
		if (candidate === undefined) {
			progress.notifySummaryUnavailable();
			progress.advance();
			continue;
		}
		candidates.push(candidate);
	}

	return candidates;
}

/** Marks generated summaries as omitted full tool results in the final projected context. */
function wrapSummaryReplacement(summary: string, placeholder: string): string {
	return `<tool_result full_result="omitted" content="summary">\n<notice>${escapeXmlText(placeholder)}</notice>\n<summary>\n${escapeXmlText(summary)}\n</summary>\n</tool_result>`;
}

/** Escapes XML delimiter characters inside untrusted model-visible data. */
function escapeXmlText(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Selects the model, thinking level, auth, and prompt used for one-tool-result summaries. */
async function resolveSummaryRuntimeConfig(
	pi: Pick<ExtensionAPI, "getThinkingLevel">,
	ctx: ExtensionContext,
	config: ContextProjectionSummaryConfig,
): Promise<SummaryRuntimeConfig | undefined> {
	const model = selectSummaryModel(ctx, config);
	if (model === undefined) {
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return undefined;
	}

	const prompts = await readSummaryPrompts(config);
	if (prompts === undefined) {
		return undefined;
	}

	const thinking =
		config.thinking ?? parseSummaryThinking(pi.getThinkingLevel());
	const options: SimpleStreamOptions = {};
	if (ctx.signal !== undefined) {
		options.signal = ctx.signal;
	}
	if (auth.apiKey !== undefined) {
		options.apiKey = auth.apiKey;
	}
	if (auth.headers !== undefined) {
		options.headers = auth.headers;
	}
	if (thinking !== undefined && thinking !== "off") {
		options.reasoning = thinking;
	}

	return { model, thinking, ...prompts, options };
}

/** Selects the configured summary model, or the active main model when omitted. */
function selectSummaryModel(
	ctx: ExtensionContext,
	config: ContextProjectionSummaryConfig,
): Model<Api> | undefined {
	if (config.model === undefined) {
		return ctx.model;
	}

	const separatorIndex = config.model.indexOf("/");
	const provider = config.model.slice(0, separatorIndex);
	const modelId = config.model.slice(separatorIndex + 1);
	return ctx.modelRegistry.find(provider, modelId);
}

/** Reads configured summary prompts or bundled defaults. */
async function readSummaryPrompts(
	config: ContextProjectionSummaryConfig,
): Promise<
	{ readonly systemPrompt: string; readonly userPrompt: string } | undefined
> {
	const [systemPrompt, userPrompt] = await Promise.all([
		readPromptFile(
			resolveSummaryPromptPath(
				config.systemPromptFile,
				DEFAULT_SUMMARY_SYSTEM_PROMPT_FILE,
			),
		),
		readPromptFile(
			resolveSummaryPromptPath(
				config.userPromptFile,
				DEFAULT_SUMMARY_USER_PROMPT_FILE,
			),
		),
	]);
	if (systemPrompt === undefined || userPrompt === undefined) {
		return undefined;
	}

	return { systemPrompt, userPrompt };
}

/** Reads one prompt file and rejects empty content. */
async function readPromptFile(path: string): Promise<string | undefined> {
	try {
		const prompt = await readFile(path, "utf8");
		return prompt.trim().length === 0 ? undefined : prompt;
	} catch {
		return undefined;
	}
}

/** Resolves custom summary prompt paths after config validation guarantees absolute paths. */
function resolveSummaryPromptPath(
	promptFile: string | undefined,
	defaultPromptFile: string,
): string {
	return promptFile ?? defaultPromptFile;
}

/** Collects new projected tool results that are large enough to summarize. */
function collectSummaryCandidates(
	mappedContext: readonly MappedContextEntry[],
): Map<string, ProjectionSummaryCandidate> {
	const toolCallContextById = collectToolCallContextById(mappedContext);
	const candidatesByEntryId = new Map<string, ProjectionSummaryCandidate>();
	for (const { entry, message } of mappedContext) {
		if (entry.type !== "message" || message.role !== "toolResult") {
			continue;
		}
		const text = getToolResultText(message);
		if (text === undefined) {
			continue;
		}

		candidatesByEntryId.set(entry.id, {
			entryId: entry.id,
			text,
			message,
			toolCallContext: toolCallContextById.get(message.toolCallId),
		});
	}

	return candidatesByEntryId;
}

/** Collects model-visible tool-call context for summary prompts. */
function collectToolCallContextById(
	mappedContext: readonly MappedContextEntry[],
): Map<string, string> {
	const contextById = new Map<string, string>();
	for (const { message } of mappedContext) {
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

/** Retries transient summary failures before giving up on a generated replacement. */
async function summarizeProjectionCandidateWithRetries({
	candidate,
	runtimeConfig,
	completeSimple,
	config,
	progress,
}: {
	readonly candidate: ProjectionSummaryCandidate;
	readonly runtimeConfig: SummaryRuntimeConfig;
	readonly completeSimple: CompleteSimple;
	readonly config: ContextProjectionSummaryConfig;
	readonly progress: ProjectionProgressReporter;
}): Promise<string | undefined> {
	return summarizeProjectionCandidateAttempt({
		candidate,
		runtimeConfig,
		completeSimple,
		config,
		progress,
		attempt: 0,
	});
}

/** Runs one summary attempt and recurses only when retry budget remains. */
async function summarizeProjectionCandidateAttempt({
	candidate,
	runtimeConfig,
	completeSimple,
	config,
	progress,
	attempt,
}: {
	readonly candidate: ProjectionSummaryCandidate;
	readonly runtimeConfig: SummaryRuntimeConfig;
	readonly completeSimple: CompleteSimple;
	readonly config: ContextProjectionSummaryConfig;
	readonly progress: ProjectionProgressReporter;
	readonly attempt: number;
}): Promise<string | undefined> {
	const result = await summarizeProjectionCandidate(
		candidate,
		runtimeConfig,
		completeSimple,
	);
	if (result.kind === "success") {
		return result.summary;
	}
	if (result.kind === "fatal" || attempt >= config.retryCount) {
		return undefined;
	}

	const nextAttempt = attempt + 2;
	const totalAttempts = config.retryCount + 1;
	progress.notifyRetry(nextAttempt, totalAttempts);
	const shouldContinue = await delay(
		config.retryDelayMs,
		runtimeConfig.options.signal,
	);
	if (!shouldContinue) {
		return undefined;
	}
	progress.notifyCurrent();

	return summarizeProjectionCandidateAttempt({
		candidate,
		runtimeConfig,
		completeSimple,
		config,
		progress,
		attempt: attempt + 1,
	});
}

/** Summarizes one projected tool result and classifies failures for retry handling. */
async function summarizeProjectionCandidate(
	candidate: ProjectionSummaryCandidate,
	runtimeConfig: SummaryRuntimeConfig,
	completeSimple: CompleteSimple,
): Promise<SummaryAttemptResult> {
	const context = buildSummaryContext(candidate, runtimeConfig);
	if (!doesSummaryInputFitContextWindow(context, runtimeConfig)) {
		return { kind: "fatal" };
	}
	if (runtimeConfig.options.signal?.aborted === true) {
		return { kind: "fatal" };
	}

	try {
		const response = await completeSimple(
			runtimeConfig.model,
			context,
			runtimeConfig.options,
		);
		if (response.stopReason === "error") {
			return { kind: "retryable" };
		}

		const summary = extractSummaryText(response.content);
		return summary === undefined
			? { kind: "retryable" }
			: { kind: "success", summary };
	} catch (error) {
		return isAbortError(error) || runtimeConfig.options.signal?.aborted
			? { kind: "fatal" }
			: { kind: "retryable" };
	}
}

/** Checks summary input locally to avoid provider calls that cannot fit the summary model window. */
function doesSummaryInputFitContextWindow(
	context: Context,
	runtimeConfig: SummaryRuntimeConfig,
): boolean {
	return (
		estimateSerializedInputTokens(
			context,
			runtimeConfig.model.id,
			runtimeConfig.model.provider,
		) <= runtimeConfig.model.contextWindow
	);
}

/** Returns true when a thrown provider error means the current operation was aborted. */
function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

/** Waits before retrying a failed summary request unless the operation is aborted. */
async function delay(
	delayMs: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (signal?.aborted === true) {
		return false;
	}
	if (delayMs === 0) {
		return true;
	}

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		const onAbort = (): void => {
			clearTimeout(timeout);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Builds the isolated summary request context for one tool result. */
function buildSummaryContext(
	candidate: ProjectionSummaryCandidate,
	runtimeConfig: SummaryRuntimeConfig,
): Context {
	const toolCallContext = escapeXmlText(
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
							escapeXmlText(candidate.text),
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

/** Maps values through an async worker pool with deterministic result ordering. */
async function mapWithConcurrency<T, R>(
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

/** Returns a supported thinking level from dynamic pi state. */
function parseSummaryThinking(
	value: unknown,
): ContextProjectionSummaryConfig["thinking"] | undefined {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}

	return undefined;
}

function createContextProjectionChangeResult({
	pi,
	ctx,
	config,
	projectedPlaceholdersByEntryId,
	publishedStatusText,
	decision,
}: ContextProjectionChangeResultOptions): HandleContextProjectionResult {
	recordNewProjectedEntries(
		pi,
		ctx.cwd,
		projectedPlaceholdersByEntryId,
		decision.newProjectedEntries,
	);
	const statusText = publishProjectionStatus(
		ctx,
		config,
		estimateSavedTokens(decision.savedTokens),
		publishedStatusText,
	);
	if (decision.newProjectedEntries.length > 0) {
		notifyProjectionCompleted(
			ctx,
			estimateSavedTokens(decision.newSavedTokens),
		);
	}
	return {
		contextResult: { messages: decision.messages },
		statusText,
	};
}

/** Returns an unchanged provider context result while keeping footer status current. */
function createContextProjectionNoChangeResult(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	publishedStatusText: string | undefined,
	projectedSavedTokens = 0,
): HandleContextProjectionResult {
	return {
		contextResult: undefined,
		statusText: publishProjectionStatus(
			ctx,
			config,
			projectedSavedTokens,
			publishedStatusText,
		),
	};
}

function estimateCurrentProjectedSavedTokens(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	projectedPlaceholdersByEntryId: ReadonlyMap<string, string>,
	loadedSkillRoots: readonly string[],
): number {
	if (config.kind !== "valid") {
		return 0;
	}

	return estimateProjectedSavedTokens({
		branchEntries: ctx.sessionManager.getBranch(),
		cwd: ctx.cwd,
		projectedPlaceholdersByEntryId,
		config: config.config,
		loadedSkillRoots,
	});
}

/** Returns true when current context usage is known and has crossed the projection threshold. */
function isProjectionThresholdExceeded(
	ctx: ExtensionContext,
	config: ContextProjectionConfig,
): boolean {
	const usage = ctx.getContextUsage();
	if (usage === undefined || usage.tokens === null) {
		return false;
	}

	const remainingTokens = usage.contextWindow - usage.tokens;
	return remainingTokens <= config.projectionRemainingTokens;
}

/** Throws config errors that must stop startup or context handling instead of being shown as footer state. */
function assertNoFatalConfigIssue(config: ContextProjectionConfigResult): void {
	if (config.kind === "invalid" && config.fatal === true) {
		throw new Error(`[context-projection] ${config.issue}`);
	}
}

/** Publishes compact footer state while leaving missing and disabled config hidden. */
function publishProjectionStatus(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	savedTokens: number,
	publishedStatusText: string | undefined,
): string | undefined {
	const nextStatusText = formatProjectionStatus(ctx, config, savedTokens);
	if (ctx.hasUI !== false && nextStatusText !== publishedStatusText) {
		ctx.ui.setStatus(CONTEXT_PROJECTION_STATUS_KEY, nextStatusText);
	}

	return nextStatusText;
}

/** Formats the footer status text according to config validity and current projection savings. */
function formatProjectionStatus(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	savedTokens: number,
): string | undefined {
	if (config.kind === "disabled") {
		return undefined;
	}
	if (config.kind === "invalid") {
		return ctx.ui.theme.fg("error", INVALID_STATUS_TEXT);
	}
	if (savedTokens > 0) {
		return ctx.ui.theme.fg("warning", `~${formatSavedTokens(savedTokens)}`);
	}

	return READY_STATUS_TEXT;
}

/** Persists newly projected entries as one branch-local extension-owned custom entry. */
function recordNewProjectedEntries(
	pi: Pick<ExtensionAPI, "appendEntry">,
	cwd: string,
	projectedPlaceholdersByEntryId: Map<string, string>,
	newProjectedEntries: readonly ProjectedEntryState[],
): void {
	if (newProjectedEntries.length === 0) {
		return;
	}

	for (const projectedEntry of newProjectedEntries) {
		projectedPlaceholdersByEntryId.set(
			projectedEntry.entryId,
			projectedEntry.placeholder,
		);
	}
	publishRuntimeProjectedPlaceholders(cwd, projectedPlaceholdersByEntryId);
	pi.appendEntry(CONTEXT_PROJECTION_CUSTOM_TYPE, {
		projectedEntries: newProjectedEntries,
	});
}

/** Formats approximate saved-token counts for compact footer display. */
function formatSavedTokens(savedTokens: number): string {
	if (savedTokens < TOKEN_COMPACT_THRESHOLD) {
		return savedTokens.toString();
	}

	return `${Math.round(savedTokens / TOKEN_COMPACT_THRESHOLD)}k`;
}
