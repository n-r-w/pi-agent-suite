import { describe, expect, test } from "bun:test";
import {
	feedbackResult,
	parseSubagentNormalResult,
	parseSubagentQueryRequest,
	parseSubagentStartRequest,
	parseSubagentSteerRequest,
	parseSubagentWaitRequest,
	SubagentToolError,
} from "./contracts";

/** Reports semantic prompt acceptance or the stable failed code. */
function promptBoundary(operation: () => { readonly prompt: string }): string {
	try {
		operation();
		return "accepted";
	} catch (error) {
		return error instanceof SubagentToolError ? error.code : "unexpected";
	}
}

/** Reads the stable code from a boundary parser failure. */
function failureCode(operation: () => unknown): string {
	try {
		operation();
	} catch (error) {
		return error instanceof SubagentToolError ? error.code : "unexpected";
	}
	return "missing";
}

describe("Subagents contracts", () => {
	test("validates structural requests before semantic coordination", () => {
		// Purpose: each agent operation must receive one closed, normalized request shape.
		// Input and expected output: valid requests round-trip while missing, extra, whitespace, duplicate, legacy, and range violations return invalid_request.
		// Edge cases: taskName counts Unicode code points, and wait timeout accepts the inclusive 1–3600 second range.
		// Dependencies: production boundary parsers only.
		expect({
			start: parseSubagentStartRequest({
				agentId: "SubAgentCoder",
				taskName: "a\u0301b",
				prompt: "work",
			}),
			steer: parseSubagentSteerRequest({ sessionId: 2, prompt: "change" }),
			wait: parseSubagentWaitRequest({ sessionIds: [2, 1], timeout: 1 }),
			waitUpperBound: parseSubagentWaitRequest({
				sessionIds: [2, 1],
				timeout: 3600,
			}),
			missing: failureCode(() => parseSubagentStartRequest({})),
			query: parseSubagentQueryRequest({
				sessionId: 3,
				question: "What changed?",
			}),
			extra: failureCode(() =>
				parseSubagentSteerRequest({ sessionId: 1, prompt: "x", extra: true }),
			),
			queryExtra: failureCode(() =>
				parseSubagentQueryRequest({
					sessionId: 3,
					question: "What changed?",
					extra: true,
				}),
			),
			blankPrompt: failureCode(() =>
				parseSubagentStartRequest({
					agentId: "SubAgentCoder",
					taskName: "Trace runtime",
					prompt: " \n ",
				}),
			),
			blankQuestion: failureCode(() =>
				parseSubagentQueryRequest({ sessionId: 3, question: "\u0085" }),
			),
			duplicate: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1, 1], timeout: 1 }),
			),
			legacyTimeout: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1], timeoutMs: 1000 }),
			),
			zeroTimeout: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1], timeout: 0 }),
			),
			outOfRange: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1], timeout: 3601 }),
			),
		}).toEqual({
			start: {
				agentId: "SubAgentCoder",
				taskName: "a\u0301b",
				prompt: "work",
			},
			steer: { sessionId: 2, prompt: "change" },
			wait: { sessionIds: [2, 1], timeout: 1 },
			waitUpperBound: { sessionIds: [2, 1], timeout: 3600 },
			query: { sessionId: 3, question: "What changed?" },
			missing: "invalid_request",
			extra: "invalid_request",
			queryExtra: "invalid_request",
			blankPrompt: "invalid_request",
			blankQuestion: "invalid_request",
			duplicate: "invalid_request",
			legacyTimeout: "invalid_request",
			zeroTimeout: "invalid_request",
			outOfRange: "invalid_request",
		});
	});

	test("sanitizes and bounds every public tool error message", () => {
		// Purpose: model-visible failures must preserve unknown diagnostics without allowing terminal controls or unbounded context growth.
		// Input and expected output: ANSI, layout controls, and oversized text become one terminal-safe truncated line.
		// Edge case: an error containing only removed controls falls back to a useful message.
		// Dependencies: the common SubagentToolError boundary used by every subagent tool.
		const unsafe = `failure\u202e\u2066\u001b[31m red\u001b[0m\n\t${"x".repeat(100_000)}`;
		const error = new SubagentToolError("start_failed", unsafe);
		const empty = new SubagentToolError("start_failed", "\u001b[31m\u001b[0m");
		const feedback = parseSubagentNormalResult({
			outcome: "feedback",
			sessionId: 1,
			status: "failure",
			elapsedSeconds: 1,
			error: unsafe,
		});

		expect(error.details.message).toStartWith("failure red ");
		expect(error.details.message).toEndWith("…");
		expect(error.details.message.length).toBeLessThanOrEqual(2_000);
		for (const control of ["\u001b", "\n", "\r", "\t", "\u202e", "\u2066"]) {
			expect(error.details.message).not.toContain(control);
		}
		expect(empty.details.message).toBe("Unknown error");
		expect(feedback).toMatchObject({
			status: "failure",
			error: error.details.message,
		});
	});

	test("uses Unicode White_Space for prompt semantics", () => {
		// Purpose: semantic prompt classification must follow the named Unicode property rather than ECMAScript shorthand behavior.
		// Input and expected output: U+0085 and U+2003-only prompts reject, while U+FEFF and ordinary text accept.
		// Edge case: U+FEFF is matched by ECMAScript whitespace but is not a Unicode White_Space code point.
		// Dependencies: structural TypeBox parsing followed by production semantic prompt validation.
		// Arrange and act.
		const boundaries = {
			nextLine: promptBoundary(() =>
				parseSubagentStartRequest({
					agentId: "SubAgentCoder",
					taskName: "Unicode boundary",
					prompt: "\u0085",
				}),
			),
			ordinaryUnicodeWhitespace: promptBoundary(() =>
				parseSubagentSteerRequest({ sessionId: 1, prompt: "\u2003" }),
			),
			byteOrderMark: promptBoundary(() =>
				parseSubagentSteerRequest({ sessionId: 1, prompt: "\uFEFF" }),
			),
			ordinaryText: promptBoundary(() =>
				parseSubagentStartRequest({
					agentId: "SubAgentCoder",
					taskName: "Unicode text",
					prompt: "work",
				}),
			),
		};

		// Assert.
		expect(boundaries).toEqual({
			nextLine: "invalid_request",
			ordinaryUnicodeWhitespace: "invalid_request",
			byteOrderMark: "accepted",
			ordinaryText: "accepted",
		});
	});

	test("validates all normal result variants and feedback projections", () => {
		// Purpose: runtime IPC and coordinator feedback must expose only exact public normal variants.
		// Input and expected output: accepted, timeout, and no-active parse unchanged while every feedback status exposes rounded invocation seconds.
		// Edge case: malformed feedback without its status-specific field fails through start_failed.
		// Dependencies: production result parser and feedback projector.
		const key = { ownerPiSessionId: "owner", ownerLocalSessionId: 7 };
		// Each status exercises one duration boundary while sharing stable presentation identity.
		const presentation = (elapsedMs: number) => ({
			agentId: "SubAgentCoder",
			taskName: "Project feedback",
			invocationMetadata: { startedAtMs: 0, elapsedMs },
		});
		expect([
			parseSubagentNormalResult({ outcome: "accepted", sessionId: 7 }),
			parseSubagentNormalResult({ outcome: "timeout" }),
			parseSubagentNormalResult({ outcome: "no_active_sessions" }),
			feedbackResult({
				feedbackId: "success",
				invocationId: "i1",
				sessionKey: key,
				status: "success",
				output: "done",
				presentation: presentation(0),
			}),
			feedbackResult({
				feedbackId: "failure",
				invocationId: "i2",
				sessionKey: key,
				status: "failure",
				error: "failed",
				presentation: presentation(1_001),
			}),
			feedbackResult({
				feedbackId: "abort",
				invocationId: "i3",
				sessionKey: key,
				status: "abort",
				error: "aborted",
				presentation: presentation(2_000),
			}),
			failureCode(() =>
				parseSubagentNormalResult({
					outcome: "feedback",
					sessionId: 7,
					status: "success",
					elapsedSeconds: 1,
				}),
			),
		]).toEqual([
			{ outcome: "accepted", sessionId: 7 },
			{ outcome: "timeout" },
			{ outcome: "no_active_sessions" },
			{
				outcome: "feedback",
				sessionId: 7,
				status: "success",
				elapsedSeconds: 1,
				output: "done",
			},
			{
				outcome: "feedback",
				sessionId: 7,
				status: "failure",
				elapsedSeconds: 2,
				error: "failed",
			},
			{
				outcome: "feedback",
				sessionId: 7,
				status: "abort",
				elapsedSeconds: 2,
				error: "aborted",
			},
			"start_failed",
		]);
	});
});
