import { describe, expect, test } from "bun:test";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { isAbortedAgentRun, isCompletedAgentRun } from "./agent-end-state";

function agentEnd(messages: readonly Record<string, unknown>[]): AgentEndEvent {
	return { type: "agent_end", messages } as unknown as AgentEndEvent;
}

describe("agent end state", () => {
	test("classifies the final assistant outcome", () => {
		// Purpose: lifecycle consumers must share one definition of cancellation and completed work.
		// Input and expected output: aborted is cancellation, stop is completion, and error is neither.
		// Edge case: provider errors must not be treated as user cancellation.
		// Dependencies: pure AgentEndEvent classification only.
		expect({
			aborted: {
				cancelled: isAbortedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "aborted" }]),
				),
				completed: isCompletedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "aborted" }]),
				),
			},
			stop: {
				cancelled: isAbortedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "stop" }]),
				),
				completed: isCompletedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "stop" }]),
				),
			},
			error: {
				cancelled: isAbortedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "error" }]),
				),
				completed: isCompletedAgentRun(
					agentEnd([{ role: "assistant", stopReason: "error" }]),
				),
			},
		}).toEqual({
			aborted: { cancelled: true, completed: false },
			stop: { cancelled: false, completed: true },
			error: { cancelled: false, completed: false },
		});
	});

	test("uses the latest assistant message despite surrounding messages", () => {
		// Purpose: an earlier cancelled turn must not override a newer successful assistant outcome.
		// Input and expected output: aborted assistant, tool result, successful assistant, and trailing tool result classify as completed.
		// Edge case: non-assistant messages can follow either assistant outcome.
		// Dependencies: pure AgentEndEvent classification only.
		const event = agentEnd([
			{ role: "assistant", stopReason: "aborted" },
			{ role: "toolResult" },
			{ role: "assistant", stopReason: "toolUse" },
			{ role: "toolResult" },
		]);

		expect({
			cancelled: isAbortedAgentRun(event),
			completed: isCompletedAgentRun(event),
		}).toEqual({ cancelled: false, completed: true });
	});

	test("does not classify an event without an assistant message", () => {
		// Purpose: malformed or empty lifecycle events must not fabricate an outcome.
		// Input and expected output: empty and tool-only message lists are neither cancelled nor completed.
		// Edge case: a tool result may be the only message in a synthetic event.
		// Dependencies: pure AgentEndEvent classification only.
		for (const event of [agentEnd([]), agentEnd([{ role: "toolResult" }])]) {
			expect({
				cancelled: isAbortedAgentRun(event),
				completed: isCompletedAgentRun(event),
			}).toEqual({ cancelled: false, completed: false });
		}
	});
});
