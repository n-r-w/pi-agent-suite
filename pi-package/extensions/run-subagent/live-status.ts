import { readField, readNonEmptyString } from "./boundary-validation";

/** Describes one transient status shown by an active child Pi runtime. */
export type LiveAgentStatus =
	| { readonly kind: "working" }
	| {
			readonly kind: "retrying";
			readonly attempt: number;
			readonly maxAttempts: number;
			readonly deadlineAtMs: number;
	  }
	| {
			readonly kind: "compacting";
			readonly reason: "manual" | "threshold" | "overflow";
	  }
	| { readonly kind: "summarizingBranch" };

/** Reduces one untrusted child Pi event into the latest transient status. */
export function reduceLiveAgentStatus(
	current: LiveAgentStatus | undefined,
	event: unknown,
	nowMs: number,
): LiveAgentStatus | undefined {
	const type = readNonEmptyString(event, "type");
	switch (type) {
		// A new model attempt replaces any backoff or summarization indicator.
		case "agent_start":
			return { kind: "working" };
		case "agent_end":
			return clearStatus(current, "working");
		case "auto_retry_start":
		case "summarization_retry_scheduled":
			return readRetryStatus(event, nowMs) ?? current;
		case "auto_retry_end":
		case "summarization_retry_finished":
			return clearStatus(current, "retrying");
		case "compaction_start":
			return readCompactionStatus(event) ?? current;
		case "compaction_end":
			return clearStatus(current, "compacting");
		case "summarization_retry_attempt_start":
			return readSummarizationAttemptStatus(event) ?? current;
		default:
			return current;
	}
}

/** Reads a retry countdown only when every numeric contract field is valid. */
function readRetryStatus(
	event: unknown,
	nowMs: number,
): LiveAgentStatus | undefined {
	const attempt = readPositiveInteger(event, "attempt");
	const maxAttempts = readPositiveInteger(event, "maxAttempts");
	const delayMs = readNonNegativeNumber(event, "delayMs");
	if (
		attempt === undefined ||
		maxAttempts === undefined ||
		delayMs === undefined ||
		attempt > maxAttempts
	) {
		return undefined;
	}
	return {
		kind: "retrying",
		attempt,
		maxAttempts,
		deadlineAtMs: nowMs + delayMs,
	};
}

/** Reads one documented compaction reason from an untrusted event. */
function readCompactionStatus(event: unknown): LiveAgentStatus | undefined {
	const reason = readNonEmptyString(event, "reason");
	if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") {
		return undefined;
	}
	return { kind: "compacting", reason };
}

/** Maps one summarization retry attempt back to its active operation. */
function readSummarizationAttemptStatus(
	event: unknown,
): LiveAgentStatus | undefined {
	const source = readNonEmptyString(event, "source");
	if (source === "branchSummary") {
		return { kind: "summarizingBranch" };
	}
	if (source === "compaction") {
		return readCompactionStatus(event);
	}
	return undefined;
}

/** Clears an ended status without letting a late event erase a newer state. */
function clearStatus(
	current: LiveAgentStatus | undefined,
	kind: LiveAgentStatus["kind"],
): LiveAgentStatus | undefined {
	return current?.kind === kind ? undefined : current;
}

/** Reads one positive integer field from untrusted runtime data. */
function readPositiveInteger(value: unknown, key: string): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isInteger(field) && field > 0
		? field
		: undefined;
}

/** Reads one finite duration that may complete immediately. */
function readNonNegativeNumber(
	value: unknown,
	key: string,
): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isFinite(field) && field >= 0
		? field
		: undefined;
}
