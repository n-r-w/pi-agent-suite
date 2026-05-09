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
	retryEnabled: true,
	compactionEnabled: true,
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

/** Builds a child RPC agent_end event. */
function agentEnd(): Record<string, unknown> {
	return { type: "agent_end" };
}

describe("child RPC prompt completion", () => {
	test("waits past retryable agent_end only when retry is enabled", () => {
		// Purpose: retryable failures need one non-final agent_end before Pi emits auto_retry_start.
		// Input and expected output: retry-enabled state waits; disabled and unverified states do not wait.
		// Edge case: retryable error detection depends on message_end before agent_end.
		// Dependencies: pure shared state machine.
		const retryable = assistantMessage({
			stopReason: "error",
			errorMessage: "provider returned error 503",
		});

		const enabled = createChildRpcPromptCompletion(BASE_FACTS);
		expect(enabled.handleSessionEvent(messageEnd(retryable))).toEqual({
			kind: "wait",
		});
		expect(enabled.handleSessionEvent(agentEnd())).toEqual({ kind: "wait" });

		const disabled = createChildRpcPromptCompletion({
			...BASE_FACTS,
			retryEnabled: false,
		});
		disabled.handleSessionEvent(messageEnd(retryable));
		expect(disabled.handleSessionEvent(agentEnd()).kind).toBe("failure");

		const unverified = createChildRpcPromptCompletion({
			...BASE_FACTS,
			retryEnabled: "unverified",
		});
		unverified.handleSessionEvent(messageEnd(retryable));
		expect(unverified.handleSessionEvent(agentEnd()).kind).toBe("failure");

		const websocketClosed = createChildRpcPromptCompletion(BASE_FACTS);
		websocketClosed.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "websocket closed before response",
				}),
			),
		);
		expect(websocketClosed.handleSessionEvent(agentEnd())).toEqual({
			kind: "wait",
		});
	});

	test("does not resolve retry success until final agent_end", () => {
		// Purpose: auto_retry_end(success=true) is not the final prompt boundary.
		// Input and expected output: successful retry output waits until the later final agent_end.
		// Edge case: auto_retry_end can arrive between successful message_end and final agent_end.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "rate limit 429",
				}),
			),
		);
		completion.handleSessionEvent(agentEnd());
		completion.handleSessionEvent({ type: "auto_retry_start", attempt: 1 });
		expect(
			completion.handleSessionEvent(
				messageEnd(
					assistantMessage({ content: [{ type: "text", text: "retry ok" }] }),
				),
			),
		).toEqual({ kind: "wait" });
		expect(
			completion.handleSessionEvent({ type: "auto_retry_end", success: true }),
		).toEqual({ kind: "wait" });
		expect(completion.handleSessionEvent(agentEnd())).toMatchObject({
			kind: "success",
		});
	});

	test("keeps repeated retry attempts active until final failure", () => {
		// Purpose: repeated retryable attempts must not resolve on intermediate agent_end events.
		// Input and expected output: second retryable failure waits; final retry end with success false fails.
		// Edge case: max retry failure arrives after the agent_end that triggered retry handling.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		for (const errorMessage of [
			"server error 500",
			"socket hang up",
		] as const) {
			completion.handleSessionEvent(
				messageEnd(assistantMessage({ stopReason: "error", errorMessage })),
			);
			expect(completion.handleSessionEvent(agentEnd())).toEqual({
				kind: "wait",
			});
			completion.handleSessionEvent({ type: "auto_retry_start", attempt: 1 });
		}
		expect(
			completion.handleSessionEvent({
				type: "auto_retry_end",
				success: false,
				finalError: "retry exhausted",
			}),
		).toEqual({ kind: "failure", reason: "retry exhausted" });
	});

	test("waits past overflow agent_end only when compaction is enabled and model matches", () => {
		// Purpose: overflow compaction has the same non-final agent_end boundary as auto-retry.
		// Input and expected output: same-model overflow waits; disabled or cross-model overflow fails.
		// Edge case: silent stop overflow is detected through usage and contextWindow.
		// Dependencies: pure shared state machine and Pi overflow classifier.
		const overflow = assistantMessage({
			usage: {
				input: 1_001,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_002,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});

		const enabled = createChildRpcPromptCompletion(BASE_FACTS);
		enabled.handleSessionEvent(messageEnd(overflow));
		expect(enabled.handleSessionEvent(agentEnd())).toEqual({ kind: "wait" });

		const disabled = createChildRpcPromptCompletion({
			...BASE_FACTS,
			compactionEnabled: false,
		});
		disabled.handleSessionEvent(messageEnd(overflow));
		expect(disabled.handleSessionEvent(agentEnd()).kind).toBe("failure");

		const crossModel = createChildRpcPromptCompletion(BASE_FACTS);
		crossModel.handleSessionEvent(
			messageEnd(assistantMessage({ ...overflow, model: "other-model" })),
		);
		expect(crossModel.handleSessionEvent(agentEnd()).kind).toBe("failure");
	});

	test("does not let non-overflow compaction reasons finalize overflow recovery", () => {
		// Purpose: manual and threshold compaction events are progress, not overflow recovery decisions.
		// Input and expected output: threshold compaction end keeps the prompt waiting; overflow failure fails.
		// Edge case: overflow failure can arrive without a prior compaction_start.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "length",
					usage: {
						input: 990,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 990,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				}),
			),
		);
		completion.handleSessionEvent(agentEnd());
		expect(
			completion.handleSessionEvent({
				type: "compaction_end",
				reason: "threshold",
				willRetry: false,
				aborted: false,
			}),
		).toEqual({ kind: "wait" });
		expect(
			completion.handleSessionEvent({
				type: "compaction_end",
				reason: "overflow",
				willRetry: false,
				aborted: false,
				errorMessage: "overflow recovery failed",
			}),
		).toEqual({ kind: "failure", reason: "overflow recovery failed" });
	});

	test("continues after overflow compaction will retry", () => {
		// Purpose: compaction_end(willRetry=true) starts a recovery continuation, not completion.
		// Input and expected output: later successful message_end plus final agent_end resolves success.
		// Edge case: compaction success is keyed only by reason overflow.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					usage: {
						input: 1_001,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_002,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				}),
			),
		);
		completion.handleSessionEvent(agentEnd());
		expect(
			completion.handleSessionEvent({
				type: "compaction_end",
				reason: "overflow",
				willRetry: true,
				aborted: false,
			}),
		).toEqual({ kind: "wait" });
		expect(
			completion.handleSessionEvent(
				messageEnd(
					assistantMessage({
						content: [{ type: "text", text: "after compaction" }],
					}),
				),
			),
		).toEqual({ kind: "wait" });
		expect(completion.handleSessionEvent(agentEnd())).toMatchObject({
			kind: "success",
		});
	});

	test("classifies compaction abort and unverified compaction as failure", () => {
		// Purpose: overflow recovery must not wait when compaction state is unavailable or aborts.
		// Input and expected output: unverified compaction fails on agent_end; aborted compaction fails from event.
		// Edge case: abort without parent abort is an ordinary child failure.
		// Dependencies: pure shared state machine.
		const overflow = assistantMessage({
			usage: {
				input: 1_001,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_002,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const unverified = createChildRpcPromptCompletion({
			...BASE_FACTS,
			compactionEnabled: "unverified",
		});
		unverified.handleSessionEvent(messageEnd(overflow));
		expect(unverified.handleSessionEvent(agentEnd()).kind).toBe("failure");

		const aborted = createChildRpcPromptCompletion(BASE_FACTS);
		aborted.handleSessionEvent(messageEnd(overflow));
		aborted.handleSessionEvent(agentEnd());
		expect(
			aborted.handleSessionEvent({
				type: "compaction_end",
				reason: "overflow",
				willRetry: false,
				aborted: true,
				errorMessage: "compaction aborted",
			}),
		).toEqual({ kind: "failure", reason: "compaction aborted" });
	});

	test("finalizes non-retryable assistant errors on agent_end", () => {
		// Purpose: ordinary assistant errors must not wait for child recovery.
		// Input and expected output: non-retryable error produces failure at following agent_end.
		// Edge case: retry is enabled but error text is not retryable.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		completion.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "invalid request payload",
				}),
			),
		);
		expect(completion.handleSessionEvent(agentEnd())).toEqual({
			kind: "failure",
			reason: "invalid request payload",
		});
	});

	test("ignores malformed assistant message_end payloads", () => {
		// Purpose: unknown child RPC payloads must not be trusted as assistant messages.
		// Input and expected output: malformed role-only payload does not become a successful message.
		// Edge case: later agent_end has no assistant message for council fallback handling.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		expect(
			completion.handleSessionEvent({
				type: "message_end",
				message: { role: "assistant" },
			}),
		).toEqual({ kind: "wait" });
		expect(completion.handleSessionEvent(agentEnd())).toEqual({
			kind: "success",
			message: undefined,
		});
	});

	test("transport failure terminates retry and compaction wait states", () => {
		// Purpose: child process or stream failure must not leave recovery prompts active.
		// Input and expected output: transport failure returns failure while waiting for retry or compaction.
		// Edge case: applies before child emits final recovery events.
		// Dependencies: pure shared state machine.
		const retrying = createChildRpcPromptCompletion(BASE_FACTS);
		retrying.handleSessionEvent(
			messageEnd(
				assistantMessage({
					stopReason: "error",
					errorMessage: "server error 500",
				}),
			),
		);
		retrying.handleSessionEvent(agentEnd());
		expect(retrying.recordTransportFailure("child exited")).toEqual({
			kind: "failure",
			reason: "child exited",
		});

		const compacting = createChildRpcPromptCompletion(BASE_FACTS);
		compacting.handleSessionEvent(
			messageEnd(
				assistantMessage({
					usage: {
						input: 1_001,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_002,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				}),
			),
		);
		compacting.handleSessionEvent(agentEnd());
		expect(compacting.recordTransportFailure("malformed stdout")).toEqual({
			kind: "failure",
			reason: "malformed stdout",
		});
	});

	test("parent abort overrides later child success and failure", () => {
		// Purpose: user cancellation is the highest-priority terminal state.
		// Input and expected output: abort decision persists before and after child terminal events.
		// Edge case: late child success and transport failure must not replace abort.
		// Dependencies: pure shared state machine.
		const completion = createChildRpcPromptCompletion(BASE_FACTS);
		expect(completion.recordParentAbort()).toEqual({
			kind: "abort",
			reason: "parent abort",
		});
		expect(
			completion.handleSessionEvent(messageEnd(assistantMessage())),
		).toEqual({
			kind: "abort",
			reason: "parent abort",
		});
		expect(completion.handleSessionEvent(agentEnd())).toEqual({
			kind: "abort",
			reason: "parent abort",
		});
		expect(completion.recordTransportFailure("child exited")).toEqual({
			kind: "abort",
			reason: "parent abort",
		});
	});
});
