import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ChildRpcRuntimeFacts,
	createChildRpcPromptCompletion,
} from "./child-rpc-completion";

const BASE_FACTS: ChildRpcRuntimeFacts = {
	modelProvider: "openai",
	modelId: "model-a",
	contextWindow: 1_000,
};

/** Creates an assistant message fixture with Pi-compatible usage defaults. */
function assistantMessage(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "test",
		provider: "openai",
		model: "model-a",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

/** Builds a child RPC message_end event. */
function messageEnd(message: AssistantMessage): Record<string, unknown> {
	return { type: "message_end", message };
}

/** Builds the hidden marker that announces a threshold-compaction continuation. */
function compactionInterruption(): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "custom",
			customType: "compaction-trigger-interruption",
			content: "",
			display: false,
			timestamp: 1,
		},
	};
}

/** Builds a low-level child RPC agent_end event. */
function agentEnd(): Record<string, unknown> {
	return { type: "agent_end" };
}

/** Builds the session-level child RPC completion event. */
function agentSettled(): Record<string, unknown> {
	return { type: "agent_settled" };
}

/** Creates a silent same-model context-overflow response. */
function overflowMessage(): AssistantMessage {
	return assistantMessage({
		usage: {
			input: 1_001,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_002,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
}

describe("child RPC prompt completion", () => {
	test("uses agent_settled as the successful prompt boundary", () => {
		// Purpose: a low-level agent run must not terminate a prompt that Pi can still continue automatically.
		// Input and expected output: one successful assistant response waits through agent_end and succeeds on agent_settled.
		// Edge case: no retry or compaction event appears between the two lifecycle boundaries.
		// Dependencies: pure shared completion state.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		const answer = assistantMessage({
			content: [{ type: "text", text: "done" }],
		});

		// Act
		completion.handleSessionEvent(messageEnd(answer));
		const lowLevelEnd = completion.handleSessionEvent(agentEnd());
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(lowLevelEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({ kind: "success", message: answer });
	});

	test("survives the observed WebSocket retry sequence", () => {
		// Purpose: an accepted child must let Pi recover a transient transport error without parent intervention.
		// Input and expected output: WebSocket failure and agent_end remain pending; the retried answer succeeds on agent_settled.
		// Edge case: the parent does not need launch-time retry settings because Pi owns the actual retry decision.
		// Dependencies: pure shared completion state and Pi RPC lifecycle event order.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		const recovered = assistantMessage({
			content: [{ type: "text", text: "recovered" }],
		});

		// Act
		const failureMessage = completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "WebSocket closed 1000",
				}),
			),
		);
		const failedRunEnd = completion.handleSessionEvent(agentEnd());
		completion.handleSessionEvent({ type: "auto_retry_start", attempt: 1 });
		completion.handleSessionEvent(messageEnd(recovered));
		completion.handleSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		const retriedRunEnd = completion.handleSessionEvent(agentEnd());
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(failureMessage).toEqual({ kind: "wait" });
		expect(failedRunEnd).toEqual({ kind: "wait" });
		expect(retriedRunEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({ kind: "success", message: recovered });
	});

	test("reports an unrecovered assistant error only after agent_settled", () => {
		// Purpose: Pi must retain authority to retry or otherwise recover every assistant error before the parent finalizes it.
		// Input and expected output: one invalid request error waits through agent_end and fails with its original reason on agent_settled.
		// Edge case: the error is not transient and produces no auto_retry events.
		// Dependencies: pure shared completion state.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "invalid request payload",
				}),
			),
		);

		// Act
		const lowLevelEnd = completion.handleSessionEvent(agentEnd());
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(lowLevelEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({
			kind: "failure",
			reason: "invalid request payload",
		});
	});

	test("defers exhausted retry failure until agent_settled", () => {
		// Purpose: auto_retry_end reports recovery state but does not replace the session-level terminal boundary.
		// Input and expected output: final retry failure remains pending until agent_settled returns the final provider error.
		// Edge case: no later assistant message replaces the failed attempt.
		// Dependencies: pure shared completion state.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "server error 503",
				}),
			),
		);

		// Act
		completion.handleSessionEvent(agentEnd());
		const retryEnd = completion.handleSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 10,
			finalError: "retry budget exhausted",
		});
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(retryEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({
			kind: "failure",
			reason: "retry budget exhausted",
		});
	});

	test("defers failed overflow compaction until agent_settled", () => {
		// Purpose: compaction failure must preserve its diagnostic without making compaction_end a second terminal boundary.
		// Input and expected output: silent overflow and aborted compaction remain pending until agent_settled fails.
		// Edge case: the assistant response itself has stopReason stop and no errorMessage.
		// Dependencies: pure shared completion state and Pi overflow classification.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(messageEnd(overflowMessage()));
		completion.handleSessionEvent(agentEnd());

		// Act
		const compactionEnd = completion.handleSessionEvent({
			type: "compaction_end",
			reason: "overflow",
			aborted: true,
			willRetry: false,
			errorMessage: "child overflow compaction aborted",
		});
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(compactionEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({
			kind: "failure",
			reason: "child overflow compaction aborted",
		});
	});

	test("accepts a completed over-window answer after successful compaction without retry", () => {
		// Purpose: successful overflow compaction must not replace an already completed assistant answer with a false failure.
		// Input and expected output: an over-window stop response and successful non-retrying compaction succeed on agent_settled.
		// Edge case: Pi sets willRetry false because a completed assistant response cannot be continued.
		// Dependencies: pure shared completion state and Pi's documented compaction_end result contract.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		const completed = overflowMessage();
		completion.handleSessionEvent(messageEnd(completed));
		completion.handleSessionEvent(agentEnd());

		// Act
		const compactionEnd = completion.handleSessionEvent({
			type: "compaction_end",
			reason: "overflow",
			result: { summary: "compacted" },
			aborted: false,
			willRetry: false,
		});
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(compactionEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({ kind: "success", message: completed });
	});

	test("accepts a successful post-compaction answer on agent_settled", () => {
		// Purpose: successful overflow recovery must replace the provisional overflow failure.
		// Input and expected output: overflow, compaction retry, and recovered answer remain pending until agent_settled succeeds.
		// Edge case: two low-level agent runs belong to one prompt.
		// Dependencies: pure shared completion state and Pi overflow classification.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		const recovered = assistantMessage({
			content: [{ type: "text", text: "after compaction" }],
		});
		completion.handleSessionEvent(messageEnd(overflowMessage()));
		completion.handleSessionEvent(agentEnd());
		completion.handleSessionEvent({
			type: "compaction_end",
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		completion.handleSessionEvent(messageEnd(recovered));

		// Act
		const recoveredRunEnd = completion.handleSessionEvent(agentEnd());
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(recoveredRunEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({ kind: "success", message: recovered });
	});

	test("keeps a threshold compaction continuation inside one child prompt", () => {
		// Purpose: the parent must not terminate a child between a trigger-owned abort and its resumed answer.
		// Input and expected output: an interruption marker and aborted request survive the intermediate settlement, then the resumed answer succeeds.
		// Edge case: manual compaction does not set willRetry even though the extension starts a continuation.
		// Dependencies: pure shared completion state and the compaction-trigger lifecycle marker.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		const recovered = assistantMessage({
			content: [{ type: "text", text: "continued after compaction" }],
		});
		completion.handleSessionEvent(compactionInterruption());
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "This operation was aborted",
				}),
			),
		);

		// Act
		const interruptedSettlement = completion.handleSessionEvent(agentSettled());
		const compactionEnd = completion.handleSessionEvent({
			type: "compaction_end",
			reason: "manual",
			result: { summary: "compacted" },
			aborted: false,
			willRetry: false,
		});
		completion.handleSessionEvent(messageEnd(recovered));
		const resumedSettlement = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(interruptedSettlement).toEqual({ kind: "wait" });
		expect(compactionEnd).toEqual({ kind: "wait" });
		expect(resumedSettlement).toEqual({ kind: "success", message: recovered });
	});

	test("fails a marked child when manual compaction fails", () => {
		// Purpose: suppressing the interrupted settlement must not hide a terminal compaction failure.
		// Input and expected output: a marked aborted request waits once, then failed manual compaction returns its diagnostic.
		// Edge case: no second agent_settled event follows failed manual compaction.
		// Dependencies: pure shared completion state and Pi's manual compaction event contract.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(compactionInterruption());
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "This operation was aborted",
				}),
			),
		);

		// Act
		const interruptedSettlement = completion.handleSessionEvent(agentSettled());
		const compactionEnd = completion.handleSessionEvent({
			type: "compaction_end",
			reason: "manual",
			result: null,
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: quota exhausted",
		});

		// Assert
		expect(interruptedSettlement).toEqual({ kind: "wait" });
		expect(compactionEnd).toEqual({
			kind: "failure",
			reason: "Compaction failed: quota exhausted",
		});
	});

	test("transport failure and parent abort remain immediate terminal outcomes", () => {
		// Purpose: boundaries outside Pi's session lifecycle must still stop a child that cannot produce agent_settled.
		// Input and expected output: transport loss fails immediately and parent abort wins over later session events.
		// Edge case: terminal decisions remain immutable after later success events.
		// Dependencies: pure shared completion state.
		// Arrange
		const disconnected = createChildRpcPromptCompletion(BASE_FACTS);
		const aborted = createChildRpcPromptCompletion(BASE_FACTS);

		// Act
		const transportFailure = disconnected.recordTransportFailure("RPC lost");
		const parentAbort = aborted.recordParentAbort();
		const lateSettled = aborted.handleSessionEvent(agentSettled());

		// Assert
		expect(transportFailure).toEqual({ kind: "failure", reason: "RPC lost" });
		expect(parentAbort).toEqual({ kind: "abort", reason: "parent abort" });
		expect(lateSettled).toEqual(parentAbort);
	});

	test("settles without an assistant message only at agent_settled", () => {
		// Purpose: malformed message events must not fabricate assistant output or restore agent_end terminality.
		// Input and expected output: role-only assistant payload is ignored, agent_end waits, and agent_settled succeeds without a message.
		// Edge case: the RPC stream contains no valid AssistantMessage.
		// Dependencies: pure shared completion state and assistant payload validation.
		// Arrange
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent({
			type: "message_end",
			message: { role: "assistant" },
		});

		// Act
		const lowLevelEnd = completion.handleSessionEvent(agentEnd());
		const settled = completion.handleSessionEvent(agentSettled());

		// Assert
		expect(lowLevelEnd).toEqual({ kind: "wait" });
		expect(settled).toEqual({ kind: "success", message: undefined });
	});
});
