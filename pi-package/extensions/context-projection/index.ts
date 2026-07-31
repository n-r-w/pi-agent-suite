import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	addPendingProjectionSavings,
	CONTEXT_PROJECTION_CUSTOM_TYPE,
	type ContextProjectionConfig,
	type ContextProjectionConfigResult,
	collectLoadedSkillRoots,
	collectProjectedReplacements,
	estimatePendingProjectionSavings,
	estimateProjectedSavedTokens,
	estimateSavedTokens,
	getProjectionAwareContextUsage,
	hasValidAssistantContextUsage,
	type MappedContextEntry,
	mapEventMessagesToBranchEntries,
	type ProjectedEntryState,
	type ProjectionDecision,
	type ProjectionLevel,
	projectContextMessages,
	publishRuntimeProjectedReplacements,
	readContextProjectionConfig,
	resetPendingProjectionSavings,
	setPendingProjectionSavings,
} from "../../shared/context-projection";
import { CONTEXT_PROJECTION_STATUS_KEY } from "../../shared/context-projection-status";
import { recordHelperApiCost } from "../../shared/helper-api-cost";
import { createToolResultProjectionSummaries } from "../../shared/tool-result-projection";
import {
	collectToolResultSummaryCandidates,
	resolveToolResultSummaryRuntimeConfig,
	type ToolResultSummaryCandidate,
	type ToolResultSummaryCompleteSimple,
} from "../../shared/tool-result-summary";
import { createToolResultSummaryDiagnosticRecorder } from "../../shared/tool-result-summary-diagnostic";

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
	readonly projectedReplacementsByEntryId: Map<string, string>;
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
	readonly projectedReplacementsByEntryId: Map<string, string>;
	readonly publishedStatusText: string | undefined;
	readonly activeProjectionLevel: ProjectionLevel | undefined;
	readonly decision: ProjectionDecision;
}

type CompleteSimple = ToolResultSummaryCompleteSimple;

interface ContextProjectionDependencies {
	readonly completeSimple?: CompleteSimple;
}

interface ProjectionDecisionOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">;
	readonly ctx: ExtensionContext;
	readonly config: ContextProjectionConfig;
	readonly mappedContext: readonly MappedContextEntry[];
	readonly projectedReplacementsByEntryId: Map<string, string>;
	readonly loadedSkillRoots: readonly string[];
	readonly activeProjectionLevel: ProjectionLevel | undefined;
	readonly completeSimple: CompleteSimple;
}

interface ProjectionProgressReporter {
	readonly total: number;
	readonly activeProjectionLevel: ProjectionLevel | undefined;
	processed: number;
	advance(): void;
	notifyCurrent(): void;
	notifyRetry(nextAttempt: number, totalAttempts: number): void;
	notifySummaryUnavailable(): void;
	notifySummaryNotSmaller(): void;
}

interface SummaryReplacementOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">;
	readonly ctx: ExtensionContext;
	readonly config: ContextProjectionConfig;
	readonly mappedContext: readonly MappedContextEntry[];
	readonly newProjectedEntries: readonly ProjectedEntryState[];
	readonly completeSimple: CompleteSimple;
	readonly progress: ProjectionProgressReporter;
}

interface RecordNewProjectedEntriesOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly cwd: string;
	readonly sessionId: string;
	readonly branchLeafId: string | null;
	readonly projectedReplacementsByEntryId: Map<string, string>;
	readonly newProjectedEntries: readonly ProjectedEntryState[];
	readonly newSavedTokens: number;
}

/** Extension entry point for provider-context projection of old tool results. */
export default function contextProjection(
	pi: ExtensionAPI,
	dependencies: ContextProjectionDependencies = {},
): void {
	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	let projectedReplacementsByEntryId = new Map<string, string>();
	let publishedStatusText: string | undefined;
	let loadedSkillRoots: readonly string[] = [];

	const reconstructProjectionState = (ctx: {
		readonly cwd: string;
		readonly sessionManager: { getBranch(): SessionEntry[] };
	}): void => {
		projectedReplacementsByEntryId = collectProjectedReplacements(
			ctx.sessionManager.getBranch(),
		);
		publishRuntimeProjectedReplacements(
			ctx.cwd,
			projectedReplacementsByEntryId,
		);
	};

	const publishCurrentStatus = async (ctx: ExtensionContext): Promise<void> => {
		const config = await readContextProjectionConfig();
		syncPendingProjectionSavings(ctx, config, loadedSkillRoots);
		assertNoFatalConfigIssue(config);
		publishedStatusText = publishProjectionStatus(
			ctx,
			config,
			estimateCurrentProjectedSavedTokens(
				ctx,
				config,
				projectedReplacementsByEntryId,
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
			projectedReplacementsByEntryId,
			publishedStatusText,
			loadedSkillRoots,
			completeSimple,
		});
		publishedStatusText = result.statusText;
		return result.contextResult;
	});

	pi.on("message_end", (event, ctx) => {
		if (hasValidAssistantContextUsage(event.message)) {
			resetPendingProjectionSavings(ctx.sessionManager.getSessionId());
		}
	});
}

/** Handles one context event by projecting eligible tool results when the active config and usage permit it. */
async function handleContextProjection({
	pi,
	event,
	ctx,
	projectedReplacementsByEntryId,
	publishedStatusText,
	loadedSkillRoots,
	completeSimple,
}: HandleContextProjectionOptions): Promise<HandleContextProjectionResult> {
	const config = await readContextProjectionConfig();
	syncPendingProjectionSavings(ctx, config, loadedSkillRoots);
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
		projectedReplacementsByEntryId,
		loadedSkillRoots,
	);
	const createNoChangeResult = (): HandleContextProjectionResult =>
		createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
			currentProjectedSavedTokens,
		);
	const activeProjectionLevel = resolveActiveProjectionLevel(
		ctx,
		config.config,
	);
	if (
		!hasProjectionWork(activeProjectionLevel, projectedReplacementsByEntryId)
	) {
		return createNoChangeResult();
	}

	const mappedContext = mapEventMessagesToBranchEntries(
		event.messages,
		ctx.sessionManager.getBranch(),
	);
	if (mappedContext === undefined) {
		return createNoChangeResult();
	}

	const decision = await createProjectionDecision({
		pi,
		ctx,
		config: config.config,
		mappedContext,
		projectedReplacementsByEntryId,
		loadedSkillRoots,
		activeProjectionLevel,
		completeSimple,
	});
	if (!decision.changed) {
		return createNoChangeResult();
	}

	return createContextProjectionChangeResult({
		pi,
		ctx,
		config,
		projectedReplacementsByEntryId,
		publishedStatusText,
		activeProjectionLevel,
		decision,
	});
}

/** Returns true when a context event can apply stored projections or discover new projected entries. */
function hasProjectionWork(
	activeProjectionLevel: ProjectionLevel | undefined,
	projectedReplacementsByEntryId: ReadonlyMap<string, string>,
): boolean {
	return (
		activeProjectionLevel !== undefined ||
		projectedReplacementsByEntryId.size > 0
	);
}

/** Creates the final projection decision, enriching new projected entries with summaries when available. */
async function createProjectionDecision({
	pi,
	ctx,
	config,
	mappedContext,
	projectedReplacementsByEntryId,
	loadedSkillRoots,
	activeProjectionLevel,
	completeSimple,
}: ProjectionDecisionOptions): Promise<ProjectionDecision> {
	let decision = projectContextMessages({
		mappedContext,
		projectedReplacementsByEntryId,
		config,
		loadedSkillRoots,
		cwd: ctx.cwd,
		activeProjectionLevel,
	});
	if (!decision.changed) {
		return decision;
	}
	const progress = createProjectionProgressReporter(
		ctx,
		decision.newProjectedEntries.length,
		activeProjectionLevel,
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
		projectedReplacementsByEntryId,
		replacementTextByEntryId: summaryReplacementsByEntryId,
		config,
		loadedSkillRoots,
		cwd: ctx.cwd,
		activeProjectionLevel,
	});
	return decision;
}

/** Shows a UI-only chat status when a new projection operation starts. */
function createProjectionProgressReporter(
	ctx: ExtensionContext,
	total: number,
	activeProjectionLevel: ProjectionLevel | undefined,
): ProjectionProgressReporter {
	const progress: ProjectionProgressReporter = {
		total,
		activeProjectionLevel,
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
	if (
		!ctx.hasUI ||
		progress.total === 0 ||
		progress.activeProjectionLevel === undefined
	) {
		return;
	}

	ctx.ui.notify(
		`Projecting context: ${progress.activeProjectionLevel.label}, ${progress.processed}/${progress.total} tool results processed`,
		"info",
	);
}

/** Shows the additional savings produced by the latest projection operation. */
function notifyProjectionCompleted(
	ctx: ExtensionContext,
	activeProjectionLevel: ProjectionLevel,
	savedTokens: number,
): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		`Context projected: ${activeProjectionLevel.label}, ~${formatSavedTokens(savedTokens)} saved`,
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

/** Shows that summary generation failed and the projected entry uses the omitted notice. */
function notifyProjectionSummaryUnavailable(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		"Context projection summary unavailable; using omitted notice",
		"info",
	);
}

/** Shows that a generated summary was rejected because it would not reduce context size. */
function notifyProjectionSummaryNotSmaller(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		"Context projection summary not smaller; using omitted notice",
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

	const runtimeConfig = await resolveToolResultSummaryRuntimeConfig({
		currentModel: ctx.model,
		modelRegistry: ctx.modelRegistry,
		config: config.summary,
		currentThinking: pi.getThinkingLevel(),
		signal: ctx.signal,
	});
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

	const recordAttemptFailure = createToolResultSummaryDiagnosticRecorder(
		pi,
		"context-projection",
		runtimeConfig.model,
	);
	return createToolResultProjectionSummaries({
		candidates,
		runtimeConfig,
		completeSimple,
		config: config.summary,
		summaryNotice: config.summaryNotice,
		callbacks: {
			onAttemptFailure: recordAttemptFailure,
			onRetryAttempt: () => {
				progress.notifyCurrent();
			},
			onRetryScheduled: (nextAttempt, totalAttempts) => {
				progress.notifyRetry(nextAttempt, totalAttempts);
			},
			onCandidateComplete: (summaryCreated) => {
				if (!summaryCreated) {
					progress.notifySummaryUnavailable();
				}
				progress.advance();
			},
			onSummaryNotSmaller: () => {
				progress.notifySummaryNotSmaller();
				progress.notifyCurrent();
			},
			recordCost: (message) => {
				recordHelperApiCost(pi, "context-projection", message);
			},
		},
	});
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
}): ToolResultSummaryCandidate[] {
	const candidatesByEntryId = new Map(
		collectToolResultSummaryCandidates(
			mappedContext.map(({ entry, message }) => ({ id: entry.id, message })),
			0,
		).map((candidate) => [candidate.id, candidate]),
	);
	const candidates: ToolResultSummaryCandidate[] = [];
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

function createContextProjectionChangeResult({
	pi,
	ctx,
	config,
	projectedReplacementsByEntryId,
	publishedStatusText,
	activeProjectionLevel,
	decision,
}: ContextProjectionChangeResultOptions): HandleContextProjectionResult {
	recordNewProjectedEntries({
		pi,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		branchLeafId: ctx.sessionManager.getLeafId(),
		projectedReplacementsByEntryId,
		newProjectedEntries: decision.newProjectedEntries,
		newSavedTokens: decision.newSavedTokens,
	});
	const statusText = publishProjectionStatus(
		ctx,
		config,
		estimateSavedTokens(decision.savedTokens),
		publishedStatusText,
	);
	if (
		decision.newProjectedEntries.length > 0 &&
		activeProjectionLevel !== undefined
	) {
		notifyProjectionCompleted(
			ctx,
			activeProjectionLevel,
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

/** Rebuilds pending projection savings from branch state when the active session changes. */
function syncPendingProjectionSavings(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	loadedSkillRoots: readonly string[],
): void {
	if (config.kind !== "valid") {
		resetPendingProjectionSavings(ctx.sessionManager.getSessionId());
		return;
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const pendingSavings = estimatePendingProjectionSavings({
		branchEntries,
		cwd: ctx.cwd,
		config: config.config,
		loadedSkillRoots,
	});
	setPendingProjectionSavings(
		ctx.sessionManager.getSessionId(),
		pendingSavings.savedTokens,
		pendingSavings.entryIds,
		new Set(branchEntries.map((entry) => entry.id)),
	);
}

function estimateCurrentProjectedSavedTokens(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	projectedReplacementsByEntryId: ReadonlyMap<string, string>,
	loadedSkillRoots: readonly string[],
): number {
	if (config.kind !== "valid") {
		return 0;
	}

	return estimateProjectedSavedTokens({
		branchEntries: ctx.sessionManager.getBranch(),
		cwd: ctx.cwd,
		projectedReplacementsByEntryId,
		config: config.config,
		loadedSkillRoots,
	});
}

/** Returns the deepest active projection level when current context usage crosses a configured threshold. */
function resolveActiveProjectionLevel(
	ctx: ExtensionContext,
	config: ContextProjectionConfig,
): ProjectionLevel | undefined {
	const usage = getProjectionAwareContextUsage(
		ctx.sessionManager.getSessionId(),
		ctx.getContextUsage(),
	);
	if (usage === undefined || usage.tokens === null) {
		return undefined;
	}

	const remainingTokens = usage.contextWindow - usage.tokens;
	for (let index = config.projectionLevels.length - 1; index >= 0; index -= 1) {
		const level = config.projectionLevels[index];
		if (level !== undefined && remainingTokens <= level.remainingTokens) {
			return level;
		}
	}

	return undefined;
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
function recordNewProjectedEntries({
	pi,
	cwd,
	sessionId,
	branchLeafId,
	projectedReplacementsByEntryId,
	newProjectedEntries,
	newSavedTokens,
}: RecordNewProjectedEntriesOptions): void {
	if (newProjectedEntries.length === 0) {
		return;
	}

	if (branchLeafId === null) {
		throw new Error(
			"cannot record pending projection savings without an active branch leaf",
		);
	}

	const projectionState = { projectedEntries: newProjectedEntries };
	try {
		pi.appendEntry(CONTEXT_PROJECTION_CUSTOM_TYPE, projectionState);
	} catch (error) {
		// Pi keeps this data object in the in-memory branch before persistence can fail.
		// Clearing it prevents failed projection state from being replayed in this process.
		projectionState.projectedEntries = [];
		throw error;
	}
	for (const projectedEntry of newProjectedEntries) {
		projectedReplacementsByEntryId.set(
			projectedEntry.entryId,
			projectedEntry.replacementText,
		);
	}
	publishRuntimeProjectedReplacements(cwd, projectedReplacementsByEntryId);
	addPendingProjectionSavings(sessionId, estimateSavedTokens(newSavedTokens), {
		branchLeafId,
		entryIds: newProjectedEntries.map(
			(projectedEntry) => projectedEntry.entryId,
		) as [string, ...string[]],
	});
}

/** Formats approximate saved-token counts for compact footer display. */
function formatSavedTokens(savedTokens: number): string {
	if (savedTokens < TOKEN_COMPACT_THRESHOLD) {
		return savedTokens.toString();
	}

	return `${Math.round(savedTokens / TOKEN_COMPACT_THRESHOLD)}k`;
}
