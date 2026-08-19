import {
	hasExactKeys,
	readField,
	readNonEmptyString as readStringField,
} from "./boundary-validation";
import type {
	InvocationMetadata,
	JournalRecord,
	LogicalSession,
	SessionKey,
	SubagentFeedback,
} from "./domain";

/** Lists required fields for one accepted logical session. */
const LOGICAL_SESSION_KEYS = [
	"key",
	"childPiSessionId",
	"childSessionDir",
	"childSessionFile",
	"agentId",
	"taskName",
	"creationOrder",
	"invocationId",
	"runtimeLeaseId",
	"invocationMetadata",
	"state",
] as const;

/** Parses the journal discriminator before delegating one closed record shape. */
export function parseJournalRecord(value: unknown): JournalRecord | undefined {
	const kind = readStringField(value, "kind");
	switch (kind) {
		case "owner-snapshot":
			return parseOwnerSnapshotRecord(value);
		case "session-accepted":
			return parseAcceptedRecord(value);
		case "continuation-accepted":
			return parseContinuationRecord(value);
		case "terminal":
			return parseTerminalRecord(value);
		case "wait-claimed":
			return parseWaitClaimRecord(value);
		case "history-pending":
		case "wait-committed":
		case "history-committed":
			return parseDispositionRecord(kind, value);
		default:
			return undefined;
	}
}

/** Parses one owner snapshot that establishes a new journal boundary. */
function parseOwnerSnapshotRecord(value: unknown): JournalRecord | undefined {
	if (!hasExactKeys(value, ["kind", "ownerPiSessionId", "sessions"])) {
		return undefined;
	}
	const ownerPiSessionId = readStringField(value, "ownerPiSessionId");
	const rawSessions = readField(value, "sessions");
	if (ownerPiSessionId === undefined || !Array.isArray(rawSessions)) {
		return undefined;
	}
	const sessions: LogicalSession[] = [];
	for (const sessionValue of rawSessions) {
		if (
			typeof sessionValue !== "object" ||
			sessionValue === null ||
			Object.hasOwn(sessionValue, "ownerRuntimeLeaseId")
		) {
			return undefined;
		}
		const session = parseLogicalSession(sessionValue);
		if (
			session === undefined ||
			session.key.ownerPiSessionId !== ownerPiSessionId ||
			session.state !== "terminal-success"
		) {
			return undefined;
		}
		sessions.push(session);
	}
	return { kind: "owner-snapshot", ownerPiSessionId, sessions };
}

/** Parses one accepted-session journal record. */
function parseAcceptedRecord(value: unknown): JournalRecord | undefined {
	if (!hasExactKeys(value, ["kind", "session"])) {
		return undefined;
	}
	const session = parseLogicalSession(readField(value, "session"));
	return session === undefined
		? undefined
		: { kind: "session-accepted", session };
}

/** Parses one continuation-acceptance journal record. */
function parseContinuationRecord(value: unknown): JournalRecord | undefined {
	if (
		!hasExactKeys(
			value,
			[
				"kind",
				"sessionKey",
				"invocationId",
				"runtimeLeaseId",
				"invocationMetadata",
			],
			["ownerRuntimeLeaseId"],
		)
	) {
		return undefined;
	}
	const sessionKey = parseSessionKey(readField(value, "sessionKey"));
	const invocationId = readStringField(value, "invocationId");
	const runtimeLeaseId = readStringField(value, "runtimeLeaseId");
	const ownerRuntimeLeaseId = readStringField(value, "ownerRuntimeLeaseId");
	const invocationMetadata = parseInvocationMetadata(
		readField(value, "invocationMetadata"),
	);
	if (
		sessionKey === undefined ||
		invocationId === undefined ||
		runtimeLeaseId === undefined ||
		invocationMetadata === undefined
	) {
		return undefined;
	}
	const common = {
		kind: "continuation-accepted" as const,
		sessionKey,
		invocationId,
		runtimeLeaseId,
		invocationMetadata,
	};
	return ownerRuntimeLeaseId === undefined
		? common
		: { ...common, ownerRuntimeLeaseId };
}

/** Parses one terminal journal record with optional withheld feedback. */
function parseTerminalRecord(value: unknown): JournalRecord | undefined {
	if (
		!hasExactKeys(
			value,
			["kind", "sessionKey", "invocationId", "state", "disposition"],
			["feedback"],
		)
	) {
		return undefined;
	}
	const sessionKey = parseSessionKey(readField(value, "sessionKey"));
	const invocationId = readStringField(value, "invocationId");
	const state = readTerminalState(readField(value, "state"));
	const disposition = readDisposition(readField(value, "disposition"));
	const feedbackValue = readField(value, "feedback");
	const feedback =
		feedbackValue === undefined ? undefined : parseFeedback(feedbackValue);
	if (
		sessionKey === undefined ||
		invocationId === undefined ||
		state === undefined ||
		disposition === undefined ||
		(feedbackValue !== undefined && feedback === undefined)
	) {
		return undefined;
	}
	const common = {
		kind: "terminal" as const,
		sessionKey,
		invocationId,
		state,
		disposition,
	};
	return feedback === undefined ? common : { ...common, feedback };
}

/** Parses one durable wait-claim record. */
function parseWaitClaimRecord(value: unknown): JournalRecord | undefined {
	if (
		!hasExactKeys(value, [
			"kind",
			"feedback",
			"waitToolCallId",
			"waitRequestId",
		])
	) {
		return undefined;
	}
	const feedback = parseFeedback(readField(value, "feedback"));
	const waitToolCallId = readStringField(value, "waitToolCallId");
	const waitRequestId = readStringField(value, "waitRequestId");
	return feedback === undefined ||
		waitToolCallId === undefined ||
		waitRequestId === undefined
		? undefined
		: {
				kind: "wait-claimed",
				feedback,
				waitToolCallId,
				waitRequestId,
			};
}

/** Parses one pending or committed feedback disposition record. */
function parseDispositionRecord(
	kind: "history-pending" | "wait-committed" | "history-committed",
	value: unknown,
): JournalRecord | undefined {
	if (
		!hasExactKeys(value, ["kind", "feedbackId", "invocationId", "sessionKey"])
	) {
		return undefined;
	}
	const sessionKey = parseSessionKey(readField(value, "sessionKey"));
	const feedbackId = readStringField(value, "feedbackId");
	const invocationId = readStringField(value, "invocationId");
	return sessionKey === undefined ||
		feedbackId === undefined ||
		invocationId === undefined
		? undefined
		: { kind, feedbackId, invocationId, sessionKey };
}

/** Parses one complete accepted logical-session record. */
function parseLogicalSession(value: unknown): LogicalSession | undefined {
	if (!hasExactKeys(value, LOGICAL_SESSION_KEYS, ["ownerRuntimeLeaseId"])) {
		return undefined;
	}
	const key = parseSessionKey(readField(value, "key"));
	const childPiSessionId = readStringField(value, "childPiSessionId");
	const childSessionDir = readStringField(value, "childSessionDir");
	const childSessionFile = readStringField(value, "childSessionFile");
	const agentId = readStringField(value, "agentId");
	const taskName = readStringField(value, "taskName");
	const creationOrder = readPositiveInteger(value, "creationOrder");
	const invocationId = readStringField(value, "invocationId");
	const runtimeLeaseId = readStringField(value, "runtimeLeaseId");
	const ownerRuntimeLeaseId = readStringField(value, "ownerRuntimeLeaseId");
	const invocationMetadata = parseInvocationMetadata(
		readField(value, "invocationMetadata"),
	);
	const state = readInvocationState(readField(value, "state"));
	if (
		key === undefined ||
		childPiSessionId === undefined ||
		childSessionDir === undefined ||
		childSessionFile === undefined ||
		agentId === undefined ||
		taskName === undefined ||
		creationOrder === undefined ||
		invocationId === undefined ||
		runtimeLeaseId === undefined ||
		invocationMetadata === undefined ||
		state === undefined
	) {
		return undefined;
	}
	return ownerRuntimeLeaseId === undefined
		? {
				key,
				childPiSessionId,
				childSessionDir,
				childSessionFile,
				agentId,
				taskName,
				creationOrder,
				invocationId,
				runtimeLeaseId,
				invocationMetadata,
				state,
			}
		: {
				key,
				childPiSessionId,
				childSessionDir,
				childSessionFile,
				agentId,
				taskName,
				creationOrder,
				invocationId,
				runtimeLeaseId,
				ownerRuntimeLeaseId,
				invocationMetadata,
				state,
			};
}

/** Parses one complete terminal feedback payload. */
export function parseFeedback(value: unknown): SubagentFeedback | undefined {
	const status = readStringField(value, "status");
	const expectedPayloadKey = status === "success" ? "output" : "error";
	if (
		(status !== "success" && status !== "failure" && status !== "abort") ||
		!hasExactKeys(value, [
			"feedbackId",
			"invocationId",
			"sessionKey",
			"status",
			expectedPayloadKey,
			"presentation",
		])
	) {
		return undefined;
	}
	const feedbackId = readStringField(value, "feedbackId");
	const invocationId = readStringField(value, "invocationId");
	const sessionKey = parseSessionKey(readField(value, "sessionKey"));
	const presentation = parsePresentation(readField(value, "presentation"));
	if (
		feedbackId === undefined ||
		invocationId === undefined ||
		sessionKey === undefined ||
		presentation === undefined
	) {
		return undefined;
	}
	if (status === "success") {
		const output = readStringField(value, "output");
		return output === undefined
			? undefined
			: { feedbackId, invocationId, sessionKey, status, output, presentation };
	}
	if (status === "failure" || status === "abort") {
		const error = readStringField(value, "error");
		return error === undefined
			? undefined
			: { feedbackId, invocationId, sessionKey, status, error, presentation };
	}
	return undefined;
}

/** Parses one complete invocation metadata snapshot without inventing absent fields. */
function parseInvocationMetadata(
	value: unknown,
): InvocationMetadata | undefined {
	if (
		!hasExactKeys(
			value,
			["startedAtMs", "elapsedMs"],
			[
				"modelId",
				"thinking",
				"contextWindow",
				"contextTokens",
				"projectionSavedTokens",
			],
		)
	) {
		return undefined;
	}
	const startedAtMs = readNonNegativeSafeInteger(value, "startedAtMs");
	const elapsedMs = readNonNegativeSafeInteger(value, "elapsedMs");
	const rawModelId = readField(value, "modelId");
	const rawThinking = readField(value, "thinking");
	const rawContextWindow = readField(value, "contextWindow");
	const rawContextTokens = readField(value, "contextTokens");
	const rawProjectionSavedTokens = readField(value, "projectionSavedTokens");
	const modelId = readStringField(value, "modelId");
	const thinking = readStringField(value, "thinking");
	const contextWindow = readPositiveSafeInteger(value, "contextWindow");
	const contextTokens = readNonNegativeSafeInteger(value, "contextTokens");
	const projectionSavedTokens = readNonNegativeSafeInteger(
		value,
		"projectionSavedTokens",
	);
	if (
		startedAtMs === undefined ||
		elapsedMs === undefined ||
		(rawModelId !== undefined && modelId === undefined) ||
		(rawThinking !== undefined && thinking === undefined) ||
		(rawContextWindow !== undefined && contextWindow === undefined) ||
		(rawContextTokens !== undefined && contextTokens === undefined) ||
		(rawProjectionSavedTokens !== undefined &&
			projectionSavedTokens === undefined) ||
		(contextTokens !== undefined && contextWindow === undefined)
	) {
		return undefined;
	}
	return {
		startedAtMs,
		elapsedMs,
		...(modelId === undefined ? {} : { modelId }),
		...(thinking === undefined ? {} : { thinking }),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(contextTokens === undefined ? {} : { contextTokens }),
		...(projectionSavedTokens === undefined ? {} : { projectionSavedTokens }),
	};
}

/** Parses one complete presentation identity around validated invocation metadata. */
function parsePresentation(
	value: unknown,
): SubagentFeedback["presentation"] | undefined {
	if (!hasExactKeys(value, ["agentId", "taskName", "invocationMetadata"])) {
		return undefined;
	}
	const agentId = readStringField(value, "agentId");
	const taskName = readStringField(value, "taskName");
	const invocationMetadata = parseInvocationMetadata(
		readField(value, "invocationMetadata"),
	);
	return agentId === undefined ||
		taskName === undefined ||
		invocationMetadata === undefined
		? undefined
		: { agentId, taskName, invocationMetadata };
}

/** Parses one owner-qualified stable key. */
function parseSessionKey(value: unknown): SessionKey | undefined {
	if (!hasExactKeys(value, ["ownerPiSessionId", "ownerLocalSessionId"])) {
		return undefined;
	}
	const ownerPiSessionId = readStringField(value, "ownerPiSessionId");
	const ownerLocalSessionId = readPositiveInteger(value, "ownerLocalSessionId");
	return ownerPiSessionId === undefined || ownerLocalSessionId === undefined
		? undefined
		: { ownerPiSessionId, ownerLocalSessionId };
}

/** Reads one positive integer field. */
function readPositiveInteger(value: unknown, key: string): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isInteger(field) && field > 0
		? field
		: undefined;
}

/** Reads one positive safe integer metadata field. */
function readPositiveSafeInteger(
	value: unknown,
	key: string,
): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isSafeInteger(field) && field > 0
		? field
		: undefined;
}

/** Reads one non-negative safe integer metadata field. */
function readNonNegativeSafeInteger(
	value: unknown,
	key: string,
): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
		? field
		: undefined;
}

/** Narrows the invocation-state field. */
function readInvocationState(
	value: unknown,
): LogicalSession["state"] | undefined {
	return value === "starting" ||
		value === "active" ||
		value === "terminal-success" ||
		value === "terminal-failure" ||
		value === "terminal-aborted"
		? value
		: undefined;
}

/** Narrows durable terminal states. */
function readTerminalState(
	value: unknown,
): "terminal-success" | "terminal-failure" | "terminal-aborted" | undefined {
	return value === "terminal-success" ||
		value === "terminal-failure" ||
		value === "terminal-aborted"
		? value
		: undefined;
}

/** Narrows durable feedback dispositions. */
function readDisposition(
	value: unknown,
): Extract<JournalRecord, { kind: "terminal" }>["disposition"] | undefined {
	return value === "pending" ||
		value === "wait-claimed" ||
		value === "history-pending" ||
		value === "wait-committed" ||
		value === "history-committed" ||
		value === "withheld-forced-abort"
		? value
		: undefined;
}
