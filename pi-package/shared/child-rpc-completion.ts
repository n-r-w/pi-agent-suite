import {
	type AssistantMessage,
	isContextOverflow,
} from "@earendil-works/pi-ai";

export type RecoveryEnablement = boolean | "unverified";

export interface ChildRpcRuntimeFacts {
	readonly modelProvider: string;
	readonly modelId: string;
	readonly contextWindow: number;
	readonly retryEnabled: RecoveryEnablement;
	readonly compactionEnabled: RecoveryEnablement;
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

type PromptState =
	| "active"
	| "retryable_error_pending_agent_end"
	| "retrying"
	| "retry_success_pending_agent_end"
	| "compaction_recovery_pending_agent_end"
	| "compaction_retrying";

type OverflowClassification = "none" | "same-model" | "cross-model";

/** Provider and transport failures that Pi 0.74.0 treats as retryable at session level. */
const RETRYABLE_CHILD_ERROR_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

const PARENT_ABORT_REASON = "parent abort";
const RETRY_UNVERIFIED_REASON = "child retry state is not verified";
const RETRY_DISABLED_REASON = "child retry is disabled";
const COMPACTION_UNVERIFIED_REASON = "child compaction state is not verified";
const COMPACTION_DISABLED_REASON = "child compaction is disabled";
const CROSS_MODEL_OVERFLOW_REASON =
	"child overflow message does not match the verified child model";

/** Creates the prompt-completion protocol state for one child RPC prompt. */
export function createChildRpcPromptCompletion(
	runtimeFacts: ChildRpcRuntimeFacts,
): ChildRpcPromptCompletion {
	return new ChildRpcPromptCompletionState(runtimeFacts);
}

/** Tracks prompt completion boundaries across child Pi RPC recovery events. */
class ChildRpcPromptCompletionState implements ChildRpcPromptCompletion {
	private state: PromptState = "active";
	private terminal: ChildRpcPromptDecision | undefined;
	private lastAssistantMessage: AssistantMessage | undefined;
	private pendingFailureReason: string | undefined;

	constructor(private readonly runtimeFacts: ChildRpcRuntimeFacts) {}

	public handleSessionEvent(event: unknown): ChildRpcPromptDecision {
		if (this.terminal !== undefined || !isRecord(event)) {
			return this.wait();
		}

		const type = event["type"];
		if (type === "message_end") {
			return this.handleMessageEnd(event["message"]);
		}
		if (type === "agent_end") {
			return this.handleAgentEnd();
		}
		if (type === "auto_retry_start") {
			return this.handleAutoRetryStart();
		}
		if (type === "auto_retry_end") {
			return this.handleAutoRetryEnd(event);
		}
		if (type === "compaction_end") {
			return this.handleCompactionEnd(event);
		}
		return this.wait();
	}

	public recordParentAbort(): ChildRpcPromptDecision {
		return this.abort(PARENT_ABORT_REASON);
	}

	public recordTransportFailure(reason: string): ChildRpcPromptDecision {
		return this.fail(reason);
	}

	private handleMessageEnd(message: unknown): ChildRpcPromptDecision {
		if (!isAssistantMessage(message)) {
			return this.wait();
		}

		this.lastAssistantMessage = message;
		this.pendingFailureReason = undefined;
		return this.handleAssistantMessage(message);
	}

	private handleAssistantMessage(
		message: AssistantMessage,
	): ChildRpcPromptDecision {
		const overflow = classifyOverflow(message, this.runtimeFacts);
		if (overflow !== "none") {
			return this.handleOverflowMessage(overflow);
		}
		if (isRetryableAssistantError(message)) {
			return this.handleRetryableError(message);
		}
		if (message.stopReason === "error") {
			this.pendingFailureReason = readAssistantErrorMessage(message);
			this.state = "active";
			return this.wait();
		}
		return this.handleSuccessfulAssistantMessage();
	}

	private handleOverflowMessage(
		overflow: Exclude<OverflowClassification, "none">,
	): ChildRpcPromptDecision {
		if (overflow === "cross-model") {
			this.pendingFailureReason = CROSS_MODEL_OVERFLOW_REASON;
			return this.wait();
		}
		if (this.runtimeFacts.compactionEnabled === true) {
			this.state = "compaction_recovery_pending_agent_end";
			return this.wait();
		}
		this.pendingFailureReason =
			this.runtimeFacts.compactionEnabled === false
				? COMPACTION_DISABLED_REASON
				: COMPACTION_UNVERIFIED_REASON;
		return this.wait();
	}

	private handleRetryableError(
		message: AssistantMessage,
	): ChildRpcPromptDecision {
		if (this.runtimeFacts.retryEnabled === true) {
			this.state = "retryable_error_pending_agent_end";
			this.pendingFailureReason = readAssistantErrorMessage(message);
			return this.wait();
		}
		this.pendingFailureReason =
			this.runtimeFacts.retryEnabled === false
				? RETRY_DISABLED_REASON
				: RETRY_UNVERIFIED_REASON;
		return this.wait();
	}

	private handleSuccessfulAssistantMessage(): ChildRpcPromptDecision {
		if (this.state === "retrying") {
			this.state = "retry_success_pending_agent_end";
			return this.wait();
		}
		if (this.isCompactionRecoveryActive()) {
			this.state = "active";
			return this.wait();
		}
		this.state = "active";
		return this.wait();
	}

	private handleAgentEnd(): ChildRpcPromptDecision {
		if (this.isRecoveryActive()) {
			return this.wait();
		}
		if (this.pendingFailureReason !== undefined) {
			return this.fail(this.pendingFailureReason);
		}
		return this.rememberTerminal({
			kind: "success",
			message: this.lastAssistantMessage,
		});
	}

	private handleAutoRetryStart(): ChildRpcPromptDecision {
		if (this.state === "retryable_error_pending_agent_end") {
			this.state = "retrying";
		}
		return this.wait();
	}

	private handleAutoRetryEnd(
		event: Record<string, unknown>,
	): ChildRpcPromptDecision {
		return event["success"] === false
			? this.fail(readEventError(event, "child retry failed"))
			: this.wait();
	}

	private handleCompactionEnd(
		event: Record<string, unknown>,
	): ChildRpcPromptDecision {
		if (event["reason"] !== "overflow") {
			return this.wait();
		}
		if (event["aborted"] === true) {
			return this.fail(
				readEventError(event, "child overflow compaction aborted"),
			);
		}
		if (event["willRetry"] === true) {
			this.state = "compaction_retrying";
			return this.wait();
		}
		return this.fail(readEventError(event, "child overflow compaction failed"));
	}

	private isRecoveryActive(): boolean {
		return (
			this.state === "retryable_error_pending_agent_end" ||
			this.state === "retrying" ||
			this.isCompactionRecoveryActive()
		);
	}

	private isCompactionRecoveryActive(): boolean {
		return (
			this.state === "compaction_recovery_pending_agent_end" ||
			this.state === "compaction_retrying"
		);
	}

	private rememberTerminal(
		decision: ChildRpcPromptDecision,
	): ChildRpcPromptDecision {
		this.terminal = decision;
		return decision;
	}

	private wait(): ChildRpcPromptDecision {
		return this.terminal ?? { kind: "wait" };
	}

	private fail(reason: string): ChildRpcPromptDecision {
		return this.terminal ?? this.rememberTerminal({ kind: "failure", reason });
	}

	private abort(reason: string): ChildRpcPromptDecision {
		return this.terminal ?? this.rememberTerminal({ kind: "abort", reason });
	}
}

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

function isRetryableAssistantError(message: AssistantMessage): boolean {
	const errorMessage = readAssistantErrorMessage(message);
	return (
		message.stopReason === "error" &&
		errorMessage.length > 0 &&
		RETRYABLE_CHILD_ERROR_PATTERN.test(errorMessage)
	);
}

function readAssistantErrorMessage(message: AssistantMessage): string {
	return typeof message.errorMessage === "string" ? message.errorMessage : "";
}

function readEventError(
	event: Record<string, unknown>,
	fallback: string,
): string {
	if (typeof event["finalError"] === "string") {
		return event["finalError"];
	}
	if (typeof event["errorMessage"] === "string") {
		return event["errorMessage"];
	}
	return fallback;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		isRecord(value) &&
		value["role"] === "assistant" &&
		Array.isArray(value["content"]) &&
		typeof value["api"] === "string" &&
		typeof value["provider"] === "string" &&
		typeof value["model"] === "string" &&
		isRecord(value["usage"]) &&
		typeof value["stopReason"] === "string" &&
		typeof value["timestamp"] === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
