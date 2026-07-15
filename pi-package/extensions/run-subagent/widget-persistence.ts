import {
	createSubagentProgressState,
	isSubagentRunDetails,
	SUBAGENT_WIDGET_FORMAT_VERSION,
	type SubagentRunDetails,
	toSubagentRunDetails,
} from "./progress";
import {
	recordSubagentWidgetRun,
	resetSubagentWidgetState,
	type SubagentWidgetState,
} from "./widget";
import { findFocusedSubagentWidgetSession } from "./widget-tree";

/** Custom entry that records an invocation before its child process starts. */
export const SUBAGENT_WIDGET_START_CUSTOM_TYPE = "run-subagent-widget-start";
/** Custom entry that records explicit browser ownership outside LLM context. */
export const SUBAGENT_WIDGET_PIN_CUSTOM_TYPE = "run-subagent-widget-pin";

/** Stores the minimum invocation state needed to recover interrupted work. */
export interface SubagentWidgetStartData {
	readonly formatVersion: typeof SUBAGENT_WIDGET_FORMAT_VERSION;
	readonly runId: string;
	readonly childSessionId: string;
	readonly sessionId: number;
	readonly agentId: string;
	readonly taskName: string;
	readonly isResume: boolean;
	readonly startedAtMs: number;
}

/** Stores the logical child session selected in the browser, or automatic mode. */
export interface SubagentWidgetPinData {
	readonly formatVersion: typeof SUBAGENT_WIDGET_FORMAT_VERSION;
	readonly childSessionId: string | null;
}

/** Creates the persisted start record written before child execution. */
export function createSubagentWidgetStartData(
	details: SubagentRunDetails,
	startedAtMs: number,
): SubagentWidgetStartData {
	return {
		formatVersion: SUBAGENT_WIDGET_FORMAT_VERSION,
		runId: details.runId,
		childSessionId: details.childSessionId,
		sessionId: details.sessionId,
		agentId: details.agentId,
		taskName: details.taskName,
		isResume: details.isResume,
		startedAtMs,
	};
}

/** Creates the persisted browser selection written after explicit confirmation. */
export function createSubagentWidgetPinData(
	childSessionId: string | undefined,
): SubagentWidgetPinData {
	return {
		formatVersion: SUBAGENT_WIDGET_FORMAT_VERSION,
		childSessionId: childSessionId ?? null,
	};
}

/** Reconstructs presentation state from the current main-session branch. */
export function restoreSubagentWidgetState(
	state: SubagentWidgetState,
	entries: readonly unknown[],
	nowMs: number,
): void {
	resetSubagentWidgetState(state);
	for (const entry of entries) {
		const record = parseBranchRecord(entry);
		switch (record.kind) {
			case "ignore":
				break;
			case "invalid-run":
				resetSubagentWidgetState(state);
				break;
			case "invalid-pin":
				state.pinnedChildSessionId = undefined;
				break;
			case "pin":
				state.pinnedChildSessionId = record.childSessionId;
				break;
			case "start":
				recordSubagentWidgetRun(
					state,
					toAbortedRunDetails(record.data, nowMs),
					nowMs,
				);
				break;
			case "terminal":
				recordSubagentWidgetRun(state, record.details, nowMs);
				break;
		}
	}

	const pinnedChildSessionId = state.pinnedChildSessionId;
	if (
		pinnedChildSessionId !== undefined &&
		findFocusedSubagentWidgetSession(state.roots, pinnedChildSessionId) ===
			undefined
	) {
		state.pinnedChildSessionId = undefined;
	}
}

type PersistedWidgetRecord =
	| { readonly kind: "ignore" }
	| { readonly kind: "invalid-run" }
	| { readonly kind: "invalid-pin" }
	| { readonly kind: "pin"; readonly childSessionId: string | undefined }
	| { readonly kind: "start"; readonly data: SubagentWidgetStartData }
	| { readonly kind: "terminal"; readonly details: SubagentRunDetails };

/** Classifies one untrusted branch entry without throwing during startup. */
function parseBranchRecord(entry: unknown): PersistedWidgetRecord {
	if (!isRecord(entry)) {
		return { kind: "ignore" };
	}
	const { type, customType, data, message } = entry;
	if (type === "custom") {
		return parseCustomEntry(customType, data);
	}
	return type === "message"
		? parseToolResultEntry(message)
		: { kind: "ignore" };
}

/** Parses widget-owned CustomEntry variants and ignores unrelated custom data. */
function parseCustomEntry(
	customType: unknown,
	data: unknown,
): PersistedWidgetRecord {
	if (customType === SUBAGENT_WIDGET_START_CUSTOM_TYPE) {
		const start = parseStartData(data);
		return start === undefined
			? { kind: "invalid-run" }
			: { kind: "start", data: start };
	}
	if (customType !== SUBAGENT_WIDGET_PIN_CUSTOM_TYPE) {
		return { kind: "ignore" };
	}
	const pin = parsePinData(data);
	return pin === undefined
		? { kind: "invalid-pin" }
		: {
				kind: "pin",
				childSessionId: pin.childSessionId ?? undefined,
			};
}

/** Parses terminal results from either public subagent tool. */
function parseToolResultEntry(message: unknown): PersistedWidgetRecord {
	if (!isRecord(message)) {
		return { kind: "ignore" };
	}
	const { role, toolName, details } = message;
	if (
		role !== "toolResult" ||
		(toolName !== "run_subagent" && toolName !== "resume_subagent")
	) {
		return { kind: "ignore" };
	}
	if (details === undefined) {
		return { kind: "ignore" };
	}
	return isSubagentRunDetails(details)
		? { kind: "terminal", details }
		: { kind: "invalid-run" };
}

/** Parses one exact current-version invocation-start record. */
function parseStartData(value: unknown): SubagentWidgetStartData | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const {
		formatVersion,
		runId,
		childSessionId,
		sessionId,
		agentId,
		taskName,
		isResume,
		startedAtMs,
	} = value;
	if (
		formatVersion !== SUBAGENT_WIDGET_FORMAT_VERSION ||
		!isNonEmptyString(runId) ||
		!isNonEmptyString(childSessionId) ||
		!isPositiveSafeInteger(sessionId) ||
		!isNonEmptyString(agentId) ||
		!isNonEmptyString(taskName) ||
		typeof isResume !== "boolean" ||
		!isNonNegativeFiniteNumber(startedAtMs)
	) {
		return undefined;
	}
	return {
		formatVersion: SUBAGENT_WIDGET_FORMAT_VERSION,
		runId,
		childSessionId,
		sessionId,
		agentId,
		taskName,
		isResume,
		startedAtMs,
	};
}

/** Parses one exact current-version browser-pin record. */
function parsePinData(value: unknown): SubagentWidgetPinData | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { formatVersion, childSessionId } = value;
	if (
		formatVersion !== SUBAGENT_WIDGET_FORMAT_VERSION ||
		(childSessionId !== null && !isNonEmptyString(childSessionId))
	) {
		return undefined;
	}
	return {
		formatVersion: SUBAGENT_WIDGET_FORMAT_VERSION,
		childSessionId,
	};
}

/** Converts an unmatched start into a terminal interrupted invocation snapshot. */
function toAbortedRunDetails(
	data: SubagentWidgetStartData,
	nowMs: number,
): SubagentRunDetails {
	const state = createSubagentProgressState({
		runId: data.runId,
		agentId: data.agentId,
		taskName: data.taskName,
		sessionId: data.sessionId,
		depth: 1,
		startedAtMs: data.startedAtMs,
		childSessionId: data.childSessionId,
		isResume: data.isResume,
	});
	return toSubagentRunDetails(state, "aborted", nowMs);
}

/** Narrows untrusted branch payloads to plain records. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows non-empty persisted identifiers and labels. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Narrows positive integer session labels. */
function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Narrows non-negative timestamps. */
function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
