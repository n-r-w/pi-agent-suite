import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import {
	type CouncilRunDetails,
	createCouncilProgressReporter,
	isCouncilRunDetails,
} from "./progress";
import type { CouncilRuntime } from "./types";

/** Creates the participant runtime fixture used by progress reporter tests. */
function createRuntime(): CouncilRuntime {
	return {
		llm1: { model: createModel("openai", "model-a"), thinking: "low" },
		llm2: { model: createModel("openai", "model-b"), thinking: "low" },
	};
}

/** Returns the latest typed council progress details emitted by the reporter. */
function requireLatestDetails(
	updates: readonly AgentToolResult<unknown>[],
): CouncilRunDetails {
	const latest = updates.at(-1)?.details;
	if (!isCouncilRunDetails(latest)) {
		throw new Error("latest update did not contain council progress details");
	}
	return latest;
}

describe("convene-council progress", () => {
	test("keeps participant elapsed time scoped to the current participant turn", () => {
		// Purpose: participant rows must show the work time for their current council turn, not total tool time.
		// Input and expected output: one participant runs for 600ms; later unrelated progress keeps that 600ms value.
		// Edge case: total council elapsed continues increasing after the participant turn has completed.
		// Dependencies: isolated reporter state with a controlled Date.now value.
		const originalDateNow = Date.now;
		let nowMs = 1_000;
		Date.now = () => nowMs;
		try {
			const updates: AgentToolResult<unknown>[] = [];
			const reporter = createCouncilProgressReporter({
				runId: "run-1",
				question: "question",
				runtime: createRuntime(),
				iterationLimit: 3,
				onUpdate: (partial) => updates.push(partial),
			});

			nowMs = 1_100;
			reporter.recordRequest("llm1", "reviews B");

			nowMs = 1_700;
			reporter.recordResponse("llm1", "AGREE", "accepted");
			const completedTurnDetails = requireLatestDetails(updates);
			expect(completedTurnDetails.elapsedMs).toBe(700);
			expect(completedTurnDetails.participants[0]?.elapsedMs).toBe(600);

			nowMs = 2_500;
			reporter.setPhase("B reviews A", 2);
			const laterDetails = requireLatestDetails(updates);
			expect(laterDetails.elapsedMs).toBe(1_500);
			expect(laterDetails.participants[0]?.elapsedMs).toBe(600);
		} finally {
			Date.now = originalDateNow;
		}
	});

	test("keeps assistant activity after participant agent_end", () => {
		// Purpose: the stable participant row must keep the answer preview after the child agent finishes.
		// Input and expected output: assistant message_end sets activity, agent_end only changes status.
		// Edge case: compact TUI renders the latest participant activity after the terminal child event.
		// Dependencies: isolated reporter state and child RPC session event shapes.
		const updates: AgentToolResult<unknown>[] = [];
		const reporter = createCouncilProgressReporter({
			runId: "run-1",
			question: "question",
			runtime: createRuntime(),
			iterationLimit: 3,
			onUpdate: (partial) => updates.push(partial),
		});

		reporter.recordSessionEvent("llm2", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "initial opinion text" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				},
			},
		});
		reporter.recordSessionEvent("llm2", { type: "agent_end" });

		const latestDetails = requireLatestDetails(updates);
		expect(latestDetails.participants[1]).toMatchObject({
			status: "succeeded",
			activity: "assistant initial opinion text",
		});
	});
});
