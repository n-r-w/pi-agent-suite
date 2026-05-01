import { describe, expect, test } from "bun:test";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { COUNCIL_CONTEXT_TOO_LARGE_ERROR } from "./constants";
import {
	createSummarySourceMessage,
	validateSummaryInputSize,
} from "./summary-preflight";
import type { ParticipantRuntime } from "./types";

/** Creates a participant runtime with a caller-controlled model context window. */
function createRuntime(contextWindow: number): ParticipantRuntime {
	return {
		model: {
			...createModel("summary", "medium"),
			contextWindow,
		},
		thinking: "medium",
	};
}

/** Estimates only the raw source message, without the Pi summary prompt envelope. */
function estimateRawSummarySourceTokens(contextPackage: string): number {
	return estimateSerializedInputTokens(
		{
			messages: [createSummarySourceMessage(contextPackage)],
		},
		"medium",
		"summary",
	);
}

describe("convene-council summary preflight", () => {
	test("rejects input that fits raw context but not the Pi summary prompt envelope", () => {
		// Purpose: summary preflight must budget the real Pi summary request envelope, not only the raw context package.
		// Input and expected output: model window is larger than raw context plus reserve, but validation still rejects the wrapped summary request.
		// Edge case: the test derives its model window from the controlled raw source estimate instead of participant prompt size.
		// Dependencies: summary preflight and shared context-size estimator.
		const contextPackage = `<context>\n${Array.from(
			{ length: 1_500 },
			(_, index) => `context-word-${index}`,
		).join(" ")}\n</context>`;
		const reserveTokens = 256;
		const rawEstimate = estimateRawSummarySourceTokens(contextPackage);

		const issue = validateSummaryInputSize({
			contextPackage,
			runtime: createRuntime(rawEstimate + reserveTokens + 1),
			reserveTokens,
		});

		expect(issue).toBe(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
	});
});
