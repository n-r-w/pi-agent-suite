import { describe, expect, test } from "bun:test";
import {
	parseAgentOperationPayload,
	parseAgentOperationResponse,
} from "./agent-operation-wire";

/** Reports whether one nested operation parser rejects its boundary value. */
function rejects(operation: () => unknown): boolean {
	try {
		operation();
		return false;
	} catch {
		return true;
	}
}

const INVOCATION_METADATA = {
	startedAtMs: 1_700_000_000_000,
	elapsedMs: 2_400,
	modelId: "openai/test-model",
	thinking: "high",
	contextWindow: 128_000,
	contextTokens: 58_000,
	projectionSavedTokens: 20_000,
};
const FEEDBACK = {
	feedbackId: "feedback-1",
	invocationId: "invocation-1",
	sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
	status: "success",
	output: "done",
	presentation: {
		agentId: "SubAgentCoder",
		taskName: "Trace wire evidence",
		invocationMetadata: INVOCATION_METADATA,
	},
} as const;
const WAIT_EVIDENCE = {
	presentationKind: "wait-feedback",
	feedbackId: FEEDBACK.feedbackId,
	invocationId: FEEDBACK.invocationId,
	waitRequestId: "wait-1",
	waitElapsedMs: 15_000,
	feedback: FEEDBACK,
} as const;
const ACCEPTED_EVIDENCE = {
	presentationKind: "accepted",
	agentId: "SubAgentCoder",
	taskName: "Trace wire evidence",
	modelId: "openai/test-model",
	thinking: "high",
} as const;

describe("agent operation wire parser", () => {
	test("rejects unknown and conditional keys in nested operation objects", () => {
		// Purpose: nested agent operations must remain closed after outer runtime-request validation.
		// Input and expected output: extra envelope, response, result, evidence, failure, and opposite-variant keys all reject.
		// Edge case: every normal result variant is closed, failed messages are non-empty, and valid values parse unchanged.
		// Dependencies: production nested operation request and response parsers.
		// Arrange and act.
		const malformed = {
			requestExtra: rejects(() =>
				parseAgentOperationPayload({
					toolName: "subagent_start",
					toolCallId: "tool-1",
					params: {},
					extra: true,
				}),
			),
			successExtra: rejects(() =>
				parseAgentOperationResponse({
					kind: "ok",
					result: { outcome: "timeout" },
					extra: true,
				}),
			),
			successFailureKey: rejects(() =>
				parseAgentOperationResponse({
					kind: "ok",
					result: { outcome: "timeout" },
					failure: { code: "start_failed", message: "failed" },
				}),
			),
			failureExtra: rejects(() =>
				parseAgentOperationResponse({
					kind: "failed",
					failure: { code: "start_failed", message: "failed" },
					extra: true,
				}),
			),
			failureResultKey: rejects(() =>
				parseAgentOperationResponse({
					kind: "failed",
					failure: { code: "start_failed", message: "failed" },
					result: { outcome: "timeout" },
				}),
			),
			evidenceExtra: rejects(() =>
				parseAgentOperationResponse({
					kind: "ok",
					result: {
						outcome: "feedback",
						sessionId: 1,
						status: "success",
						elapsedSeconds: 3,
						output: "done",
					},
					evidence: { ...WAIT_EVIDENCE, extra: true },
				}),
			),
			failureDetailsExtra: rejects(() =>
				parseAgentOperationResponse({
					kind: "failed",
					failure: {
						code: "start_failed",
						message: "failed",
						extra: true,
					},
				}),
			),
		};

		// Assert.
		expect(malformed).toEqual({
			requestExtra: true,
			successExtra: true,
			successFailureKey: true,
			failureExtra: true,
			failureResultKey: true,
			evidenceExtra: true,
			failureDetailsExtra: true,
		});
		const nestedResultValues = [
			{ outcome: "timeout", extra: true },
			{ outcome: "timeout", sessionId: 1 },
			{ outcome: "no_active_sessions", extra: true },
			{ outcome: "no_active_sessions", output: "wrong variant" },
			{ outcome: "accepted", sessionId: 1, extra: true },
			{ outcome: "accepted", sessionId: 1, status: "success" },
			{
				outcome: "feedback",
				sessionId: 1,
				status: "success",
				output: "missing duration",
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "success",
				elapsedSeconds: 3,
				output: "done",
				extra: true,
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "success",
				elapsedSeconds: 3,
				output: "done",
				error: "wrong variant",
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "failure",
				elapsedSeconds: 3,
				error: "failed",
				extra: true,
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "failure",
				elapsedSeconds: 3,
				error: "failed",
				output: "wrong variant",
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "abort",
				elapsedSeconds: 3,
				error: "aborted",
				extra: true,
			},
			{
				outcome: "feedback",
				sessionId: 1,
				status: "abort",
				elapsedSeconds: 3,
				error: "aborted",
				output: "wrong variant",
			},
		];
		expect({
			nestedResults: nestedResultValues.map((result) =>
				rejects(() => parseAgentOperationResponse({ kind: "ok", result })),
			),
			emptyFailureMessage: rejects(() =>
				parseAgentOperationResponse({
					kind: "failed",
					failure: { code: "start_failed", message: "" },
				}),
			),
		}).toEqual({
			nestedResults: nestedResultValues.map(() => true),
			emptyFailureMessage: true,
		});
		expect({
			request: parseAgentOperationPayload({
				toolName: "subagent_wait",
				toolCallId: "tool-2",
				params: { sessionIds: [1], timeoutMs: 1 },
			}),
			success: parseAgentOperationResponse({
				kind: "ok",
				result: { outcome: "timeout" },
			}),
			acceptedEvidence: parseAgentOperationResponse({
				kind: "ok",
				result: { outcome: "accepted", sessionId: 1 },
				evidence: ACCEPTED_EVIDENCE,
			}),
			successEvidence: parseAgentOperationResponse({
				kind: "ok",
				result: {
					outcome: "feedback",
					sessionId: 1,
					status: "success",
					elapsedSeconds: 3,
					output: "done",
				},
				evidence: WAIT_EVIDENCE,
			}),
			failure: parseAgentOperationResponse({
				kind: "failed",
				failure: { code: "start_failed", message: "failed" },
			}),
		}).toEqual({
			request: {
				toolName: "subagent_wait",
				toolCallId: "tool-2",
				params: { sessionIds: [1], timeoutMs: 1 },
			},
			success: { kind: "ok", result: { outcome: "timeout" } },
			acceptedEvidence: {
				kind: "ok",
				result: { outcome: "accepted", sessionId: 1 },
				evidence: ACCEPTED_EVIDENCE,
			},
			successEvidence: {
				kind: "ok",
				result: {
					outcome: "feedback",
					sessionId: 1,
					status: "success",
					elapsedSeconds: 3,
					output: "done",
				},
				evidence: WAIT_EVIDENCE,
			},
			failure: {
				kind: "failed",
				failure: { code: "start_failed", message: "failed" },
			},
		});
	});
});
