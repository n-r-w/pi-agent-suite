/** Converts milliseconds to seconds for model-visible invocation duration. */
const MILLISECONDS_PER_SECOND = 1_000;

/** Identifies the Pi session that directly owns logical child IDs. */
export interface OwnerIdentity {
	readonly ownerPiSessionId: string;
	readonly ownerSessionFile: string;
}

/** Uniquely identifies one logical session across the reconstructed hierarchy. */
export interface SessionKey {
	readonly ownerPiSessionId: string;
	readonly ownerLocalSessionId: number;
}

/** Encodes one owner-qualified session key for runtime maps. */
export function sessionMapKey(key: SessionKey): string {
	return `${key.ownerPiSessionId}\u0000${key.ownerLocalSessionId}`;
}

/** Lists every authoritative invocation state. */
type InvocationState =
	| "starting"
	| "active"
	| "terminal-success"
	| "terminal-failure"
	| "terminal-aborted";

/** Lists every durable feedback disposition. */
type FeedbackDisposition =
	| "pending"
	| "wait-claimed"
	| "history-pending"
	| "wait-committed"
	| "history-committed"
	| "withheld-forced-abort";

/** Describes one accepted logical child invocation and its latest presentation metrics. */
export interface InvocationMetadata {
	readonly startedAtMs: number;
	readonly elapsedMs: number;
	readonly modelId?: string;
	readonly thinking?: string;
	readonly contextWindow?: number;
	readonly contextTokens?: number;
	readonly projectionSavedTokens?: number;
}

/** Converts invocation runtime to model-visible whole seconds with a one-second minimum. */
export function invocationElapsedSeconds(metadata: InvocationMetadata): number {
	return Math.max(1, Math.ceil(metadata.elapsedMs / MILLISECONDS_PER_SECOND));
}

/** Captures the logical identity and finalized invocation metrics used by feedback rendering. */
export interface SubagentPresentation {
	readonly agentId: string;
	readonly taskName: string;
	readonly invocationMetadata: InvocationMetadata;
}

/** Carries accepted invocation identity in non-model-visible tool details. */
export interface AcceptedPresentationEvidence {
	readonly presentationKind: "accepted";
	readonly agentId: string;
	readonly taskName: string;
	readonly modelId?: string;
	readonly thinking?: string;
}

export interface LogicalSession {
	readonly key: SessionKey;
	readonly childPiSessionId: string;
	readonly childSessionDir: string;
	readonly childSessionFile: string;
	readonly agentId: string;
	readonly taskName: string;
	readonly creationOrder: number;
	readonly invocationId: string;
	readonly runtimeLeaseId: string;
	readonly ownerRuntimeLeaseId?: string;
	readonly invocationMetadata: InvocationMetadata;
	readonly state: InvocationState;
}

/** Carries terminal feedback independently from its eventual destination. */
export type SubagentFeedback =
	| {
			readonly feedbackId: string;
			readonly invocationId: string;
			readonly sessionKey: SessionKey;
			readonly status: "success";
			readonly output: string;
			readonly presentation: SubagentPresentation;
	  }
	| {
			readonly feedbackId: string;
			readonly invocationId: string;
			readonly sessionKey: SessionKey;
			readonly status: "failure" | "abort";
			readonly error: string;
			readonly presentation: SubagentPresentation;
	  };

/** Carries one wait-owned feedback snapshot through root and nested result details. */
export interface WaitFeedbackPresentationEvidence {
	readonly presentationKind: "wait-feedback";
	readonly feedbackId: string;
	readonly invocationId: string;
	readonly waitRequestId: string;
	readonly waitElapsedMs: number;
	readonly feedback: SubagentFeedback;
}

/** Lists presentation evidence that may accompany an unchanged normal tool result. */
export type AgentOperationEvidence =
	| AcceptedPresentationEvidence
	| WaitFeedbackPresentationEvidence;

/** Records direct-owner state transitions outside model context. */
export type JournalRecord =
	| {
			readonly kind: "session-accepted";
			readonly session: LogicalSession;
	  }
	| {
			readonly kind: "continuation-accepted";
			readonly sessionKey: SessionKey;
			readonly invocationId: string;
			readonly runtimeLeaseId: string;
			readonly ownerRuntimeLeaseId?: string;
			readonly invocationMetadata: InvocationMetadata;
	  }
	| {
			readonly kind: "terminal";
			readonly sessionKey: SessionKey;
			readonly invocationId: string;
			readonly state: Exclude<InvocationState, "starting" | "active">;
			readonly disposition: FeedbackDisposition;
			readonly feedback?: SubagentFeedback;
	  }
	| {
			readonly kind: "wait-claimed";
			readonly feedback: SubagentFeedback;
			readonly waitToolCallId: string;
			readonly waitRequestId: string;
	  }
	| {
			readonly kind: "history-pending" | "wait-committed" | "history-committed";
			readonly feedbackId: string;
			readonly invocationId: string;
			readonly sessionKey: SessionKey;
	  };
