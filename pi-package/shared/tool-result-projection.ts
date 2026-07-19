import { escapeUTF8 } from "entities";
import { createAuxiliaryLlmSessionId } from "./auxiliary-llm-session";
import { countProjectionTextTokens } from "./context-size";
import {
	mapWithConcurrency,
	summarizeToolResultCandidateWithRetries,
	type ToolResultSummaryCandidate,
	type ToolResultSummaryCompleteSimple,
	type ToolResultSummaryConfig,
	type ToolResultSummaryRuntimeConfig,
} from "./tool-result-summary";

/** Exact opening marker owned by generated context-projection summaries. */
const PROJECTION_SUMMARY_PREFIX =
	'<tool_result full_result="omitted" content="summary">\n';

type SummarizeCandidateOptions = Parameters<
	typeof summarizeToolResultCandidateWithRetries
>[0];

/** Callbacks that preserve extension-specific diagnostics, cost, and progress UI. */
export interface ToolResultProjectionCallbacks {
	readonly recordCost: SummarizeCandidateOptions["recordCost"];
	readonly onRequest?: (
		candidate: ToolResultSummaryCandidate,
	) => void | Promise<void>;
	readonly onAttemptFailure: SummarizeCandidateOptions["onAttemptFailure"];
	readonly onRetryAttempt?: SummarizeCandidateOptions["onRetryAttempt"];
	readonly onRetryScheduled?: SummarizeCandidateOptions["onRetryScheduled"];
	readonly onCandidateComplete?: (
		summaryCreated: boolean,
	) => void | Promise<void>;
	readonly onSummaryNotSmaller?: () => void;
}

/** Inputs shared by regular and compaction-source projection generation. */
export interface CreateToolResultProjectionSummariesOptions {
	readonly candidates: readonly ToolResultSummaryCandidate[];
	readonly runtimeConfig: ToolResultSummaryRuntimeConfig;
	readonly completeSimple: ToolResultSummaryCompleteSimple;
	readonly config: ToolResultSummaryConfig;
	readonly summaryNotice: string;
	readonly callbacks: ToolResultProjectionCallbacks;
}

/** Generates bounded semantic replacements while preserving candidate identity. */
export async function createToolResultProjectionSummaries({
	candidates,
	runtimeConfig,
	completeSimple,
	config,
	summaryNotice,
	callbacks,
}: CreateToolResultProjectionSummariesOptions): Promise<Map<string, string>> {
	const summaries = await mapWithConcurrency(
		candidates,
		config.maxConcurrency,
		async (candidate) => {
			const summary = await summarizeToolResultCandidateWithRetries({
				candidate,
				runtimeConfig,
				sessionId: createAuxiliaryLlmSessionId(),
				completeSimple,
				config,
				recordCost: callbacks.recordCost,
				onRequest: async () => {
					await callbacks.onRequest?.(candidate);
				},
				onAttemptFailure: callbacks.onAttemptFailure,
				...(callbacks.onRetryAttempt === undefined
					? {}
					: { onRetryAttempt: callbacks.onRetryAttempt }),
				...(callbacks.onRetryScheduled === undefined
					? {}
					: { onRetryScheduled: callbacks.onRetryScheduled }),
			});
			await callbacks.onCandidateComplete?.(summary !== undefined);
			return summary;
		},
	);

	const replacements = new Map<string, string>();
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const summary = summaries[index];
		if (candidate === undefined || summary === undefined) {
			continue;
		}
		const replacement = formatToolResultProjectionSummary(
			summary,
			summaryNotice,
		);
		if (
			countProjectionTextTokens(replacement) >=
			countProjectionTextTokens(candidate.text)
		) {
			callbacks.onSummaryNotSmaller?.();
			continue;
		}
		replacements.set(candidate.id, replacement);
	}
	return replacements;
}

/** Wraps one generated summary in the provider-visible projection contract. */
export function formatToolResultProjectionSummary(
	summary: string,
	summaryNotice: string,
): string {
	return `${PROJECTION_SUMMARY_PREFIX}<notice>${escapeUTF8(summaryNotice)}</notice>\n<summary>\n${escapeUTF8(summary)}\n</summary>\n</tool_result>`;
}

/** Distinguishes generated summaries from omission-only projection notices. */
export function isToolResultProjectionSummary(text: string): boolean {
	return text.startsWith(PROJECTION_SUMMARY_PREFIX);
}
