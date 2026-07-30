import {
	type AssistantMessage,
	isContextOverflow,
} from "@earendil-works/pi-ai";

export interface ChildRpcRuntimeFacts {
	readonly modelProvider: string;
	readonly modelId: string;
	readonly contextWindow: number;
}

export type ChildRpcPromptDecision =
	| { readonly kind: "wait" }
	| { readonly kind: "success"; readonly message: AssistantMessage | undefined }
	| { readonly kind: "failure"; readonly reason: string }
	| { readonly kind: "abort"; readonly reason: string };

export interface ChildRpcPromptCompletion {
	handleSessionEvent(event: unknown): ChildRpcPromptDecision;
	recordParentAbort(): ChildRpcPromptDecision;
	recordTransportFailure(reason: string): ChildRpcPromptDecision;
}

type OverflowClassification = "none" | "same-model" | "cross-model";

const PARENT_ABORT_REASON = "parent abort";
const ASSISTANT_FAILURE_REASON = "child assistant request failed";
const UNRECOVERED_OVERFLOW_REASON = "child context overflow was not recovered";
const CROSS_MODEL_OVERFLOW_REASON =
	"child overflow message does not match the verified child model";

/** Creates the completion state for one child RPC prompt. */
export function createChildRpcPromptCompletion(
	runtimeFacts: ChildRpcRuntimeFacts,
): ChildRpcPromptCompletion {
	return new ChildRpcPromptCompletionState(runtimeFacts);
}

/** Tracks the latest child result until Pi reports that the complete session run settled. */
class ChildRpcPromptCompletionState implements ChildRpcPromptCompletion {
	private terminal: ChildRpcPromptDecision | undefined;
	private lastAssistantMessage: AssistantMessage | undefined;
	private pendingFailureReason: string | undefined;

	constructor(private readonly runtimeFacts: ChildRpcRuntimeFacts) {}

	/** Applies one Pi RPC lifecycle event without treating low-level agent_end as terminal. */
	public handleSessionEvent(event: unknown): ChildRpcPromptDecision {
		if (this.terminal !== undefined || !isRecord(event)) {
			return this.wait();
		}

		const type = event["type"];
		if (type === "message_end") {
			return this.handleMessageEnd(event["message"]);
		}
		if (type === "agent_settled") {
			return this.handleAgentSettled();
		}
		if (type === "auto_retry_end") {
			return this.handleAutoRetryEnd(event);
		}
		if (type === "compaction_end") {
			return this.handleCompactionEnd(event);
		}
		return this.wait();
	}

	/** Records cancellation initiated by the parent runtime. */
	public recordParentAbort(): ChildRpcPromptDecision {
		return this.abort(PARENT_ABORT_REASON);
	}

	/** Records a transport boundary that cannot produce agent_settled. */
	public recordTransportFailure(reason: string): ChildRpcPromptDecision {
		return this.fail(reason);
	}

	/** Records the latest valid assistant message and its provisional outcome. */
	private handleMessageEnd(message: unknown): ChildRpcPromptDecision {
		if (!isAssistantMessage(message)) {
			return this.wait();
		}

		this.lastAssistantMessage = message;
		const overflow = classifyOverflow(message, this.runtimeFacts);
		if (overflow === "cross-model") {
			this.pendingFailureReason = CROSS_MODEL_OVERFLOW_REASON;
			return this.wait();
		}
		if (overflow === "same-model") {
			this.pendingFailureReason = UNRECOVERED_OVERFLOW_REASON;
			return this.wait();
		}
		if (message.stopReason === "error") {
			this.pendingFailureReason =
				readAssistantErrorMessage(message) || ASSISTANT_FAILURE_REASON;
			return this.wait();
		}

		// A later successful attempt replaces provisional retry or compaction failure.
		this.pendingFailureReason = undefined;
		return this.wait();
	}

	/** Preserves the final retry diagnostic while waiting for agent_settled. */
	private handleAutoRetryEnd(
		event: Record<string, unknown>,
	): ChildRpcPromptDecision {
		if (event["success"] === false) {
			this.pendingFailureReason = readEventError(event, "child retry failed");
		}
		return this.wait();
	}

	/** Preserves an unrecovered overflow diagnostic while waiting for agent_settled. */
	private handleCompactionEnd(
		event: Record<string, unknown>,
	): ChildRpcPromptDecision {
		if (event["reason"] !== "overflow" || event["willRetry"] === true) {
			return this.wait();
		}

		this.pendingFailureReason = readEventError(
			event,
			event["aborted"] === true
				? "child overflow compaction aborted"
				: "child overflow compaction failed",
		);
		return this.wait();
	}

	/** Finalizes the latest provisional result after Pi exhausts automatic continuation. */
	private handleAgentSettled(): ChildRpcPromptDecision {
		if (this.pendingFailureReason !== undefined) {
			return this.fail(this.pendingFailureReason);
		}
		return this.rememberTerminal({
			kind: "success",
			message: this.lastAssistantMessage,
		});
	}

	/** Stores the first terminal decision so later lifecycle events cannot replace it. */
	private rememberTerminal(
		decision: ChildRpcPromptDecision,
	): ChildRpcPromptDecision {
		this.terminal = decision;
		return decision;
	}

	/** Returns the immutable terminal decision or a pending result. */
	private wait(): ChildRpcPromptDecision {
		return this.terminal ?? { kind: "wait" };
	}

	/** Stores one terminal failure unless another terminal decision already won. */
	private fail(reason: string): ChildRpcPromptDecision {
		return this.terminal ?? this.rememberTerminal({ kind: "failure", reason });
	}

	/** Stores one terminal abort unless another terminal decision already won. */
	private abort(reason: string): ChildRpcPromptDecision {
		return this.terminal ?? this.rememberTerminal({ kind: "abort", reason });
	}
}

/** Classifies final context overflow against the model selected for the child. */
function classifyOverflow(
	message: AssistantMessage,
	runtimeFacts: ChildRpcRuntimeFacts,
): OverflowClassification {
	if (!isContextOverflow(message, runtimeFacts.contextWindow)) {
		return "none";
	}
	return message.provider === runtimeFacts.modelProvider &&
		message.model === runtimeFacts.modelId
		? "same-model"
		: "cross-model";
}

/** Reads an assistant error without trusting unknown payload fields. */
function readAssistantErrorMessage(message: AssistantMessage): string {
	return typeof message.errorMessage === "string" ? message.errorMessage : "";
}

/** Reads the most specific error carried by a recovery event. */
function readEventError(
	event: Record<string, unknown>,
	fallback: string,
): string {
	const error = event["error"];
	if (typeof error === "string" && error.length > 0) {
		return error;
	}
	const finalError = event["finalError"];
	if (typeof finalError === "string" && finalError.length > 0) {
		return finalError;
	}
	const errorMessage = event["errorMessage"];
	return typeof errorMessage === "string" && errorMessage.length > 0
		? errorMessage
		: fallback;
}

/** Validates the minimum assistant message shape needed by completion logic. */
function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (!isRecord(value) || value["role"] !== "assistant") {
		return false;
	}
	return (
		Array.isArray(value["content"]) &&
		typeof value["api"] === "string" &&
		typeof value["provider"] === "string" &&
		typeof value["model"] === "string" &&
		isRecord(value["usage"]) &&
		typeof value["stopReason"] === "string" &&
		typeof value["timestamp"] === "number"
	);
}

/** Narrows unknown RPC payloads to string-keyed records. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
