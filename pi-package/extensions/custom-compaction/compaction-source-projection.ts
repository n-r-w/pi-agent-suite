import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	buildContextEntryMapping,
	type ContextProjectionConfig,
	readContextProjectionConfig,
} from "../../shared/context-projection";
import { requestProjectionTasks } from "../../shared/projection-tasks";
import {
	createToolResultProjectionSummaries,
	isToolResultProjectionSummary,
} from "../../shared/tool-result-projection";
import {
	collectToolResultSummaryCandidates,
	resolveToolResultSummaryRuntimeConfig,
	type ToolResultSummaryCandidate,
	type ToolResultSummaryCompleteSimple,
	type ToolResultSummaryRuntimeConfig,
} from "../../shared/tool-result-summary";
import { createToolResultSummaryDiagnosticRecorder } from "../../shared/tool-result-summary-diagnostic";
import { publishUsageEvent } from "../../shared/usage-events";

/** Progress emitted while missing projection summaries are prepared for compaction. */
export type CompactionSourceProjectionProgressEvent =
	| { readonly type: "source-projection-request" }
	| {
			readonly type: "source-projection";
			readonly completed: number;
			readonly total: number;
			readonly projected?: number;
	  }
	| {
			readonly type: "source-projection-retry";
			readonly nextAttempt: number;
			readonly totalAttempts: number;
	  }
	| {
			readonly type: "source-projection-tasks-failure";
			readonly issue: string;
	  };

/** Dependencies and fixed Pi preparation used by forced source projection. */
export interface ProjectCompactionSourceOptions {
	readonly pi: ExtensionAPI;
	readonly event: SessionBeforeCompactEvent;
	readonly ctx: ExtensionContext;
	readonly currentProjectedMainMessages: readonly AgentMessage[];
	readonly currentThinking: string | undefined;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly onProgress?: (
		event: CompactionSourceProjectionProgressEvent,
	) => void | Promise<void>;
}

/** Reuses existing projections and best-effort summarizes every remaining L3 result. */
export async function projectCompactionSource({
	pi,
	event,
	ctx,
	currentProjectedMainMessages,
	currentThinking,
	completeSimple,
	onProgress,
}: ProjectCompactionSourceOptions): Promise<ReadonlyMap<string, string>> {
	const existingSummaries = collectProjectionSummaries(
		currentProjectedMainMessages,
	);
	const configResult = await readContextProjectionConfig();
	if (
		configResult.kind !== "valid" ||
		!configResult.config.projectCompactionSource ||
		!configResult.config.summary.enabled
	) {
		return existingSummaries;
	}

	const candidates = collectMissingProjectionCandidates(
		event,
		existingSummaries,
		configResult.config.projectionLevels[2].minToolResultTokens,
	);
	if (candidates.length === 0) {
		return existingSummaries;
	}

	const runtimeConfig = await resolveToolResultSummaryRuntimeConfig({
		currentModel: ctx.model,
		modelRegistry: ctx.modelRegistry,
		config: configResult.config.summary,
		currentThinking,
		signal: event.signal,
	});
	if (runtimeConfig === undefined) {
		return existingSummaries;
	}

	const currentTasks = await requestCurrentTasks({
		pi,
		event,
		ctx,
		currentProjectedMainMessages,
		currentThinking,
		config: configResult.config,
		completeSimple,
		...(onProgress === undefined ? {} : { onProgress }),
	});
	return generateMissingProjectionSummaries({
		pi,
		candidates,
		existingSummaries,
		config: configResult.config,
		runtimeConfig:
			currentTasks === undefined
				? runtimeConfig
				: { ...runtimeConfig, currentTasks },
		completeSimple,
		...(onProgress === undefined ? {} : { onProgress }),
	});
}

/** Asks the task model once for the current tasks; reports a failure as progress and returns undefined when summaries must go without them. */
async function requestCurrentTasks({
	pi,
	event,
	ctx,
	currentProjectedMainMessages,
	currentThinking,
	config,
	completeSimple,
	onProgress,
}: {
	readonly pi: ExtensionAPI;
	readonly event: SessionBeforeCompactEvent;
	readonly ctx: ExtensionContext;
	readonly currentProjectedMainMessages: readonly AgentMessage[];
	readonly currentThinking: string | undefined;
	readonly config: ContextProjectionConfig;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly onProgress?: (
		event: CompactionSourceProjectionProgressEvent,
	) => void | Promise<void>;
}): Promise<string | undefined> {
	const result = await requestProjectionTasks({
		messages: currentProjectedMainMessages,
		modelContext: ctx,
		config: config.summary,
		currentThinking,
		signal: event.signal,
		completeSimple,
		recordCost: (message) => {
			publishUsageEvent(pi, "projection-tasks", message);
		},
	});
	if (result.kind === "failure") {
		await onProgress?.({
			type: "source-projection-tasks-failure",
			issue: result.issue,
		});
	}
	return result.kind === "success" ? result.text : undefined;
}

interface GenerateMissingProjectionSummariesOptions {
	readonly pi: ExtensionAPI;
	readonly candidates: readonly ToolResultSummaryCandidate[];
	readonly existingSummaries: ReadonlyMap<string, string>;
	readonly config: ContextProjectionConfig;
	readonly runtimeConfig: ToolResultSummaryRuntimeConfig;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly onProgress?: (
		event: CompactionSourceProjectionProgressEvent,
	) => void | Promise<void>;
}

/** Generates missing summaries with visible progress and per-result fallback. */
async function generateMissingProjectionSummaries({
	pi,
	candidates,
	existingSummaries,
	config,
	runtimeConfig,
	completeSimple,
	onProgress,
}: GenerateMissingProjectionSummariesOptions): Promise<
	ReadonlyMap<string, string>
> {
	await onProgress?.({
		type: "source-projection",
		completed: 0,
		total: candidates.length,
	});
	let completed = 0;
	const requestedCandidateIds = new Set<string>();
	const generatedByEntryId = await createToolResultProjectionSummaries({
		candidates,
		runtimeConfig,
		completeSimple,
		config: config.summary,
		summaryNotice: config.summaryNotice,
		callbacks: {
			onRequest: async (candidate) => {
				if (requestedCandidateIds.has(candidate.id)) {
					return;
				}
				requestedCandidateIds.add(candidate.id);
				await onProgress?.({ type: "source-projection-request" });
			},
			onAttemptFailure: createToolResultSummaryDiagnosticRecorder(
				pi,
				"custom-compaction",
				runtimeConfig.model,
			),
			onRetryScheduled: async (nextAttempt, totalAttempts) => {
				await onProgress?.({
					type: "source-projection-retry",
					nextAttempt,
					totalAttempts,
				});
			},
			onCandidateComplete: async () => {
				completed += 1;
				await onProgress?.({
					type: "source-projection",
					completed,
					total: candidates.length,
				});
			},
			recordCost: (message) => {
				publishUsageEvent(pi, "custom-compaction", message);
			},
		},
	});
	await onProgress?.({
		type: "source-projection",
		completed: candidates.length,
		total: candidates.length,
		projected: generatedByEntryId.size,
	});
	return mergeProjectionSummaries(
		existingSummaries,
		candidates,
		generatedByEntryId,
	);
}

/** Selects every missing L3 candidate inside Pi's exact discarded range. */
export function collectMissingProjectionCandidates(
	event: SessionBeforeCompactEvent,
	existingSummaries: ReadonlyMap<string, string>,
	minimumTokens: number,
): ToolResultSummaryCandidate[] {
	const targetToolCallIds = collectCompactionToolCallIds(event);
	if (targetToolCallIds.size === 0) {
		return [];
	}
	return collectToolResultSummaryCandidates(
		buildContextEntryMapping(event.branchEntries).map(({ entry, message }) => ({
			id: entry.id,
			message,
		})),
		minimumTokens,
	).filter(
		(candidate) =>
			targetToolCallIds.has(candidate.message.toolCallId) &&
			!existingSummaries.has(candidate.message.toolCallId),
	);
}

/** Merges generated entry replacements into the tool-call keyed source map. */
function mergeProjectionSummaries(
	existingSummaries: ReadonlyMap<string, string>,
	candidates: readonly ToolResultSummaryCandidate[],
	generatedByEntryId: ReadonlyMap<string, string>,
): Map<string, string> {
	const summaries = new Map(existingSummaries);
	for (const candidate of candidates) {
		const replacement = generatedByEntryId.get(candidate.id);
		if (replacement !== undefined) {
			summaries.set(candidate.message.toolCallId, replacement);
		}
	}
	return summaries;
}

/** Collects only semantic projection summaries, never omission-only notices. */
function collectProjectionSummaries(
	messages: readonly AgentMessage[],
): Map<string, string> {
	const summaries = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "toolResult") {
			continue;
		}
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (isToolResultProjectionSummary(text)) {
			summaries.set(message.toolCallId, text);
		}
	}
	return summaries;
}

/** Restricts forced projection to the exact history Pi will discard. */
function collectCompactionToolCallIds(
	event: SessionBeforeCompactEvent,
): ReadonlySet<string> {
	const toolCallIds = new Set<string>();
	for (const message of [
		...event.preparation.messagesToSummarize,
		...event.preparation.turnPrefixMessages,
	]) {
		if (message.role === "toolResult") {
			toolCallIds.add(message.toolCallId);
		}
	}
	return toolCallIds;
}
