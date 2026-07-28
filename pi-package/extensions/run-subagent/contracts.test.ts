import { describe, expect, test } from "bun:test";
import {
	feedbackResult,
	parseSubagentNormalResult,
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

describe("Subagents V2 contracts", () => {
	test("validates structural requests before semantic coordination", () => {
		// Purpose: each agent operation must receive one closed, normalized request shape.
		// Input and expected output: valid requests round-trip while missing, extra, whitespace, duplicate, and range violations return invalid_request.
		// Edge case: taskName counts Unicode code points rather than UTF-16 code units.
		// Dependencies: production boundary parsers only.
		expect({
			start: parseSubagentStartRequest({
				agentId: "SubAgentCoder",
				taskName: "a\u0301b",
				prompt: "work",
			}),
			steer: parseSubagentSteerRequest({ sessionId: 2, prompt: "change" }),
			wait: parseSubagentWaitRequest({ sessionIds: [2, 1], timeoutMs: 1 }),
			missing: failureCode(() => parseSubagentStartRequest({})),
			extra: failureCode(() =>
				parseSubagentSteerRequest({ sessionId: 1, prompt: "x", extra: true }),
			),
			blankPrompt: failureCode(() =>
				parseSubagentStartRequest({
					agentId: "SubAgentCoder",
					taskName: "Trace runtime",
					prompt: " \n ",
				}),
			),
			duplicate: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1, 1], timeoutMs: 1 }),
			),
			outOfRange: failureCode(() =>
				parseSubagentWaitRequest({ sessionIds: [1], timeoutMs: 2_147_483_648 }),
			),
		}).toEqual({
			start: {
				agentId: "SubAgentCoder",
				taskName: "a\u0301b",
				prompt: "work",
			},
			steer: { sessionId: 2, prompt: "change" },
			wait: { sessionIds: [2, 1], timeoutMs: 1 },
			missing: "invalid_request",
			extra: "invalid_request",
			blankPrompt: "invalid_request",
			duplicate: "invalid_request",
			outOfRange: "invalid_request",
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
		// Input and expected output: accepted, timeout, no-active, success, failure, and abort parse or project unchanged.
		// Edge case: malformed feedback without its status-specific field fails through start_failed.
		// Dependencies: production result parser and feedback projector.
		const key = { ownerPiSessionId: "owner", ownerLocalSessionId: 7 };
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
			}),
			feedbackResult({
				feedbackId: "failure",
				invocationId: "i2",
				sessionKey: key,
				status: "failure",
				error: "failed",
			}),
			feedbackResult({
				feedbackId: "abort",
				invocationId: "i3",
				sessionKey: key,
				status: "abort",
				error: "aborted",
			}),
			failureCode(() =>
				parseSubagentNormalResult({
					outcome: "feedback",
					sessionId: 7,
					status: "success",
				}),
			),
		]).toEqual([
			{ outcome: "accepted", sessionId: 7 },
			{ outcome: "timeout" },
			{ outcome: "no_active_sessions" },
			{ outcome: "feedback", sessionId: 7, status: "success", output: "done" },
			{ outcome: "feedback", sessionId: 7, status: "failure", error: "failed" },
			{ outcome: "feedback", sessionId: 7, status: "abort", error: "aborted" },
			"start_failed",
		]);
	});
});
