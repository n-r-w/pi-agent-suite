import { describe, expect, test } from "bun:test";
import {
	parseRuntimeResponseResult,
	parseWireMessage,
	type RuntimeWireMessage,
	wireRuntimeLeaseId,
} from "./runtime-wire";

describe("runtime wire parser", () => {
	test("parses every IPC message shape and derives its lease", () => {
		// Purpose: root and worker bridges must share one validated closed wire protocol.
		// Input and expected output: ready, request, successful and failed response, and settlement messages parse unchanged.
		// Edge case: the request message derives its lease from the nested validated request.
		// Dependencies: production runtime wire parser and lease selector.
		const messages: RuntimeWireMessage[] = [
			{
				kind: "subagents-ready",
				runtimeLeaseId: "lease-1",
				ownerPiSessionId: "owner-1",
				ownerSessionFile: "/tmp/owner.jsonl",
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "request-1",
					runtimeLeaseId: "lease-1",
					ownerPiSessionId: "owner-1",
					operation: "owner_stopping",
					payload: {},
				},
			},
			{
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "lease-1",
				requestId: "request-1",
				succeeded: true,
				result: { acknowledged: true },
			},
			{
				kind: "subagents-response",
				source: "worker",
				runtimeLeaseId: "lease-1",
				requestId: "request-2",
				succeeded: false,
				error: "failed",
			},
			{
				kind: "subagents-settled",
				runtimeLeaseId: "lease-1",
				requestId: "request-1",
			},
		];
		const parsed = messages.map(parseWireMessage);

		expect({
			parsed,
			leases: parsed.map((message) =>
				message === undefined ? undefined : wireRuntimeLeaseId(message),
			),
		}).toEqual({ parsed: messages, leases: messages.map(() => "lease-1") });
	});

	test("parses the complete operation-specific payload and result matrix", () => {
		// Purpose: each runtime operation must own one exact request payload and successful response result contract.
		// Input and expected output: all eight valid payload variants parse, while every acknowledgment operation rejects false, missing, and extra fields.
		// Edge case: agent-operation params and response values use their nested exact parsers rather than acknowledgment parsing.
		// Dependencies: production runtime request and pending-operation response parsers.
		const sessionKey = {
			ownerPiSessionId: "owner-matrix",
			ownerLocalSessionId: 1,
		};
		const feedback = {
			feedbackId: "feedback-matrix",
			invocationId: "invocation-matrix",
			sessionKey,
			status: "success" as const,
			output: "done",
			presentation: {
				agentId: "SubAgentCoder",
				taskName: "Trace runtime wire",
				invocationMetadata: {
					startedAtMs: 1_700_000_000_000,
					elapsedMs: 2_400,
					modelId: "openai/test-model",
					thinking: "high",
					contextWindow: 128_000,
					contextTokens: 58_000,
					projectionSavedTokens: 20_000,
				},
			},
		};
		const payloads = [
			[
				"agent_operation",
				{
					toolName: "subagent_wait",
					toolCallId: "tool-matrix",
					params: { sessionIds: [1], timeout: 1 },
				},
			],
			[
				"append_journal",
				{
					kind: "history-committed",
					feedbackId: feedback.feedbackId,
					invocationId: feedback.invocationId,
					sessionKey,
				},
			],
			["append_history", feedback],
			["query_branch", { sessionId: 1 }],
			[
				"cancel_wait",
				{
					waitRequestId: "wait-request-matrix",
					waitToolCallId: "wait-tool-matrix",
				},
			],
			[
				"cancel_operation",
				{
					operationRequestId: "operation-request-matrix",
					operationToolCallId: "operation-tool-matrix",
				},
			],
			["owner_stopping", {}],
			["delivery_acknowledgment", {}],
		] as const;
		const parsedPayloads = payloads.map(([operation, payload], index) =>
			parseWireMessage({
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: `matrix-${index}`,
					runtimeLeaseId: "lease-matrix",
					ownerPiSessionId: "owner-matrix",
					operation,
					payload,
				},
			}),
		);
		const acknowledgmentOperations = [
			"append_journal",
			"append_history",
			"cancel_wait",
			"owner_stopping",
			"delivery_acknowledgment",
		] as const;
		const malformedAcknowledgments = [
			{ acknowledged: false },
			{},
			{ acknowledged: true, extra: true },
		];

		expect({
			parsedPayloads: parsedPayloads.map((message) =>
				message?.kind === "subagents-request"
					? message.request.operation
					: undefined,
			),
			validResults: acknowledgmentOperations.map((operation) =>
				parseRuntimeResponseResult(operation, { acknowledged: true }),
			),
			malformedResults: acknowledgmentOperations.flatMap((operation) =>
				malformedAcknowledgments.map((value) =>
					parseRuntimeResponseResult(operation, value),
				),
			),
			operationCancellationResults: [true, false].map((cancellationWon) =>
				parseRuntimeResponseResult("cancel_operation", {
					acknowledged: true,
					cancellationWon,
				}),
			),
			malformedOperationCancellationResults: [
				{ acknowledged: true },
				{ acknowledged: true, cancellationWon: "yes" },
				{ acknowledged: true, cancellationWon: true, extra: true },
			].map((value) => parseRuntimeResponseResult("cancel_operation", value)),
			agentResult: parseRuntimeResponseResult("agent_operation", {
				kind: "ok",
				result: { outcome: "accepted", sessionId: 1 },
				evidence: {
					presentationKind: "accepted",
					agentId: "SubAgentCoder",
					taskName: "Trace runtime wire",
					modelId: "openai/test-model",
					thinking: "high",
				},
			}),
			queryBranchResult: parseRuntimeResponseResult("query_branch", {
				kind: "ok",
				branch: [
					{
						type: "message",
						id: "query-entry",
						parentId: null,
						timestamp: "2026-07-29T00:00:00.000Z",
						message: { role: "user", content: "saved", timestamp: 1 },
					},
				],
			}),
		}).toEqual({
			parsedPayloads: payloads.map(([operation]) => operation),
			validResults: acknowledgmentOperations.map(() => ({
				acknowledged: true,
			})),
			malformedResults: acknowledgmentOperations.flatMap(() =>
				malformedAcknowledgments.map(() => undefined),
			),
			operationCancellationResults: [
				{ acknowledged: true, cancellationWon: true },
				{ acknowledged: true, cancellationWon: false },
			],
			malformedOperationCancellationResults: [undefined, undefined, undefined],
			agentResult: {
				kind: "ok",
				result: { outcome: "accepted", sessionId: 1 },
				evidence: {
					presentationKind: "accepted",
					agentId: "SubAgentCoder",
					taskName: "Trace runtime wire",
					modelId: "openai/test-model",
					thinking: "high",
				},
			},
			queryBranchResult: {
				kind: "ok",
				branch: [
					{
						type: "message",
						id: "query-entry",
						parentId: null,
						timestamp: "2026-07-29T00:00:00.000Z",
						message: { role: "user", content: "saved", timestamp: 1 },
					},
				],
			},
		});
	});

	test("rejects malformed IPC payloads before bridge state changes", () => {
		// Purpose: untrusted process messages must fail closed before correlation handling.
		// Input and expected output: invalid values and unknown keys at every wire level return undefined.
		// Edge case: response keys depend on succeeded, while failed responses without error text receive the bounded default error.
		// Dependencies: production runtime wire parser.
		const malformed: unknown[] = [
			null,
			{},
			{ kind: "unknown" },
			{
				kind: "subagents-ready",
				runtimeLeaseId: "",
				ownerPiSessionId: "owner",
				ownerSessionFile: "/tmp/owner.jsonl",
			},
			{
				kind: "subagents-request",
				source: "peer",
				request: {},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "request",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "unknown",
					payload: {},
				},
			},
			{
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "lease",
				requestId: "request",
				succeeded: "yes",
			},
			{
				kind: "subagents-settled",
				runtimeLeaseId: "lease",
				requestId: "",
			},
			{
				kind: "subagents-ready",
				runtimeLeaseId: "lease",
				ownerPiSessionId: "owner",
				ownerSessionFile: "/tmp/owner.jsonl",
				extra: true,
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "request",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "agent_operation",
					payload: {},
				},
				extra: true,
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "request",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "agent_operation",
					payload: {},
					extra: true,
				},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "cancel-wait-extra",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "cancel_wait",
					payload: {
						waitRequestId: "wait-request",
						waitToolCallId: "wait-tool",
						extra: true,
					},
				},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "cancel-operation-extra",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "cancel_operation",
					payload: {
						operationRequestId: "operation-request",
						operationToolCallId: "operation-tool",
						extra: true,
					},
				},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "owner-stopping-extra",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "owner_stopping",
					payload: { extra: true },
				},
			},
			{
				kind: "subagents-request",
				source: "root",
				request: {
					requestId: "delivery-invalid",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "delivery_acknowledgment",
					payload: false,
				},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "agent-envelope-extra",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "agent_operation",
					payload: {
						toolName: "subagent_start",
						toolCallId: "tool-1",
						params: {
							agentId: "SubAgentCoder",
							taskName: "Trace runtime",
							prompt: "Inspect runtime",
						},
						extra: true,
					},
				},
			},
			{
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: "agent-params-extra",
					runtimeLeaseId: "lease",
					ownerPiSessionId: "owner",
					operation: "agent_operation",
					payload: {
						toolName: "subagent_start",
						toolCallId: "tool-2",
						params: {
							agentId: "SubAgentCoder",
							taskName: "Trace runtime",
							prompt: "Inspect runtime",
							extra: true,
						},
					},
				},
			},
			{
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "lease",
				requestId: "request",
				succeeded: true,
				result: { acknowledged: true },
				extra: true,
			},
			{
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "lease",
				requestId: "request",
				succeeded: true,
				result: { acknowledged: true },
				error: "not permitted on success",
			},
			{
				kind: "subagents-response",
				source: "worker",
				runtimeLeaseId: "lease",
				requestId: "request",
				succeeded: false,
				error: "failed",
				result: { acknowledged: true },
			},
			{
				kind: "subagents-settled",
				runtimeLeaseId: "lease",
				requestId: "request",
				extra: true,
			},
		];
		const failedDefault = parseWireMessage({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: "lease",
			requestId: "request",
			succeeded: false,
		});

		expect({
			malformed: malformed.map(parseWireMessage),
			failedDefault,
		}).toEqual({
			malformed: malformed.map(() => undefined),
			failedDefault: {
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "lease",
				requestId: "request",
				succeeded: false,
				error: "runtime response failed",
			},
		});
	});
});
