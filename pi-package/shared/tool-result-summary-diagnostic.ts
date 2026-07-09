import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ToolResultSummaryAttemptFailure,
	ToolResultSummaryCandidate,
} from "./tool-result-summary";

/** Session custom entry type used to persist failed tool-result summary attempts. */
export const TOOL_RESULT_SUMMARY_DIAGNOSTIC_CUSTOM_TYPE =
	"tool-result-summary-diagnostic";

/** Extensions that use the shared tool-result summary mechanism. */
export const TOOL_RESULT_SUMMARY_DIAGNOSTIC_SOURCES = [
	"context-projection",
	"custom-compaction",
] as const;

/** Extension that initiated a failed tool-result summary attempt. */
export type ToolResultSummaryDiagnosticSource =
	(typeof TOOL_RESULT_SUMMARY_DIAGNOSTIC_SOURCES)[number];

/** Mutable safe fields persisted for one failed tool-result summary attempt. */
interface ToolResultSummaryDiagnosticEntryData {
	source: ToolResultSummaryDiagnosticSource;
	provider: string;
	model: string;
	candidateId: string;
	toolName: string;
	attempt: number;
	totalAttempts: number;
	failureKind: ToolResultSummaryAttemptFailure["failureKind"];
	errorMessage: string;
	errorName?: string;
	errorCode?: string | number;
}

/** Creates a per-candidate recorder that adds extension and model identity to each failed attempt. */
export function createToolResultSummaryDiagnosticRecorder(
	pi: Pick<ExtensionAPI, "appendEntry">,
	source: ToolResultSummaryDiagnosticSource,
	model: Model<Api>,
): (
	candidate: ToolResultSummaryCandidate,
	failure: ToolResultSummaryAttemptFailure,
	attempt: number,
	totalAttempts: number,
) => void {
	return (candidate, failure, attempt, totalAttempts) => {
		recordToolResultSummaryDiagnostic(pi, {
			source,
			model,
			candidate,
			attempt,
			totalAttempts,
			failure,
		});
	};
}

/** Records one failed summary attempt without exposing prompts, tool results, auth data, or stacks. */
function recordToolResultSummaryDiagnostic(
	pi: Pick<ExtensionAPI, "appendEntry">,
	options: {
		readonly source: ToolResultSummaryDiagnosticSource;
		readonly model: Model<Api>;
		readonly candidate: ToolResultSummaryCandidate;
		readonly attempt: number;
		readonly totalAttempts: number;
		readonly failure: ToolResultSummaryAttemptFailure;
	},
): void {
	const data: ToolResultSummaryDiagnosticEntryData = {
		source: options.source,
		provider: options.model.provider,
		model: options.model.id,
		candidateId: options.candidate.id,
		toolName: options.candidate.message.toolName,
		attempt: options.attempt,
		totalAttempts: options.totalAttempts,
		...options.failure,
	};
	try {
		pi.appendEntry(TOOL_RESULT_SUMMARY_DIAGNOSTIC_CUSTOM_TYPE, data);
	} catch {
		// The provider error message must not remain reachable through a rejected persistence call.
		data.errorMessage = "";
	}
}
