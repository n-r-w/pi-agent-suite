import {
	hasExactKeys,
	readField,
	readNonEmptyString as readStringField,
} from "./boundary-validation";
import type { AgentOperationEvidence } from "./domain";
import { parseFeedback } from "./journal-codec";
import {
	parseSubagentNormalResult,
	parseSubagentStartRequest,
	parseSubagentSteerRequest,
	parseSubagentWaitRequest,
	type SubagentFailureDetails,
	type SubagentNormalResult,
	type SubagentStartRequest,
	type SubagentSteerRequest,
	type SubagentWaitRequest,
} from "./contracts";

/** Carries one validated worker-to-root tool operation. */
export type AgentOperationPayload =
	| {
			readonly toolName: "subagent_start";
			readonly toolCallId: string;
			readonly params: SubagentStartRequest;
	  }
	| {
			readonly toolName: "subagent_steer";
			readonly toolCallId: string;
			readonly params: SubagentSteerRequest;
	  }
	| {
			readonly toolName: "subagent_wait";
			readonly toolCallId: string;
			readonly params: SubagentWaitRequest;
	  };

/** Carries one root-to-worker tool operation result. */
export type AgentOperationResponse =
	| {
			readonly kind: "ok";
			readonly result: SubagentNormalResult;
			readonly evidence?: AgentOperationEvidence;
	  }
	| {
			readonly kind: "failed";
			readonly failure: SubagentFailureDetails;
	  };

/** Parses one nested worker operation envelope. */
export function parseAgentOperationPayload(
	value: unknown,
): AgentOperationPayload {
	if (!hasExactKeys(value, ["toolName", "toolCallId", "params"])) {
		throw new Error("worker sent an invalid agent operation");
	}
	const toolName = readStringField(value, "toolName");
	const toolCallId = readStringField(value, "toolCallId");
	if (
		(toolName !== "subagent_start" &&
			toolName !== "subagent_steer" &&
			toolName !== "subagent_wait") ||
		toolCallId === undefined
	) {
		throw new Error("worker sent an invalid agent operation");
	}
	const params = readField(value, "params");
	if (toolName === "subagent_start") {
		return { toolName, toolCallId, params: parseSubagentStartRequest(params) };
	}
	if (toolName === "subagent_steer") {
		return { toolName, toolCallId, params: parseSubagentSteerRequest(params) };
	}
	return { toolName, toolCallId, params: parseSubagentWaitRequest(params) };
}

/** Parses one nested root operation response. */
export function parseAgentOperationResponse(
	value: unknown,
): AgentOperationResponse {
	const kind = readStringField(value, "kind");
	if (kind === "ok") {
		return parseSuccessfulResponse(value);
	}
	if (kind === "failed") {
		return parseFailedResponse(value);
	}
	throw new Error("root returned an invalid agent operation response");
}

/** Parses one successful nested operation response and optional wait evidence. */
function parseSuccessfulResponse(value: unknown): AgentOperationResponse {
	if (!hasExactKeys(value, ["kind", "result"], ["evidence"])) {
		throw new Error("root returned an invalid agent operation response");
	}
	const result = parseSubagentNormalResult(readField(value, "result"));
	const evidenceValue = readField(value, "evidence");
	if (evidenceValue === undefined) {
		return { kind: "ok", result };
	}
	const evidence = parseAgentOperationEvidence(evidenceValue);
	if (evidence === undefined) {
		throw new Error("root returned invalid presentation evidence");
	}
	return { kind: "ok", result, evidence };
}

/** Parses accepted or wait-owned presentation evidence from an untrusted boundary. */
export function parseAgentOperationEvidence(
	value: unknown,
): AgentOperationEvidence | undefined {
	const presentationKind = readStringField(value, "presentationKind");
	if (presentationKind === "accepted") {
		if (
			!hasExactKeys(
				value,
				["presentationKind", "agentId", "taskName"],
				["modelId", "thinking"],
			)
		) {
			return undefined;
		}
		const agentId = readStringField(value, "agentId");
		const taskName = readStringField(value, "taskName");
		const rawModelId = readField(value, "modelId");
		const rawThinking = readField(value, "thinking");
		const modelId = readStringField(value, "modelId");
		const thinking = readStringField(value, "thinking");
		if (
			agentId === undefined ||
			taskName === undefined ||
			(rawModelId !== undefined && modelId === undefined) ||
			(rawThinking !== undefined && thinking === undefined)
		) {
			return undefined;
		}
		return {
			presentationKind,
			agentId,
			taskName,
			...(modelId === undefined ? {} : { modelId }),
			...(thinking === undefined ? {} : { thinking }),
		};
	}
	if (
		presentationKind !== "wait-feedback" ||
		!hasExactKeys(value, [
			"presentationKind",
			"feedbackId",
			"invocationId",
			"waitRequestId",
			"waitElapsedMs",
			"feedback",
		])
	) {
		return undefined;
	}
	const feedbackId = readStringField(value, "feedbackId");
	const invocationId = readStringField(value, "invocationId");
	const waitRequestId = readStringField(value, "waitRequestId");
	const waitElapsedMs = readNonNegativeSafeInteger(value, "waitElapsedMs");
	const feedback = parseFeedback(readField(value, "feedback"));
	if (
		feedbackId === undefined ||
		invocationId === undefined ||
		waitRequestId === undefined ||
		waitElapsedMs === undefined ||
		feedback === undefined ||
		feedback.feedbackId !== feedbackId ||
		feedback.invocationId !== invocationId
	) {
		return undefined;
	}
	return {
		presentationKind,
		feedbackId,
		invocationId,
		waitRequestId,
		waitElapsedMs,
		feedback,
	};
}

/** Reads one non-negative safe integer from untrusted evidence. */
function readNonNegativeSafeInteger(
	value: unknown,
	key: string,
): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" &&
		Number.isSafeInteger(field) &&
		field >= 0
		? field
		: undefined;
}

/** Parses one failed nested operation response and its public failure details. */
function parseFailedResponse(value: unknown): AgentOperationResponse {
	if (!hasExactKeys(value, ["kind", "failure"])) {
		throw new Error("root returned an invalid agent operation response");
	}
	const failureValue = readField(value, "failure");
	if (!hasExactKeys(failureValue, ["code", "message"])) {
		throw new Error("root returned invalid failure details");
	}
	const code = readStringField(failureValue, "code");
	const message = readStringField(failureValue, "message");
	if (!isFailureCode(code) || message === undefined) {
		throw new Error("root returned invalid failure details");
	}
	return { kind: "failed", failure: { code, message } };
}

/** Narrows one unknown string to the stable failed-code union. */
function isFailureCode(
	value: string | undefined,
): value is SubagentFailureDetails["code"] {
	return (
		value === "invalid_request" ||
		value === "agent_unavailable" ||
		value === "unknown_session" ||
		value === "not_owner" ||
		value === "message_rejected" ||
		value === "start_failed" ||
		value === "wait_already_active"
	);
}
