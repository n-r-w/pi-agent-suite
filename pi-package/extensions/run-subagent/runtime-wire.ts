import type {
	KnowledgeMutationLease,
	KnowledgeSnapshots,
} from "../../shared/knowledge-runtime";
import {
	type AgentOperationPayload,
	type AgentOperationResponse,
	parseAgentOperationPayload,
	parseAgentOperationResponse,
} from "./agent-operation-wire";
import {
	hasExactKeys,
	readField,
	readNonEmptyString as readString,
} from "./boundary-validation";
import type { JournalRecord, SubagentFeedback } from "./domain";
import { parseFeedback, parseJournalRecord } from "./journal-codec";
import {
	type KnowledgeRuntimeOperation,
	parseKnowledgeRuntimeOperation,
	parseKnowledgeRuntimeResponse,
} from "./knowledge-wire";
import {
	parseQueryBranchRequest,
	parseQueryBranchResponse,
	type QueryBranchRequest,
	type QueryBranchResponse,
} from "./query-branch-wire";

interface RuntimeRequestIdentity {
	readonly requestId: string;
	readonly runtimeLeaseId: string;
	readonly ownerPiSessionId: string;
}

/** Correlates one nested wait cancellation to its original request and tool call. */
interface RuntimeWaitCancellation {
	readonly waitRequestId: string;
	readonly waitToolCallId: string;
}

/** Correlates one nested start or steer cancellation to its original request. */
interface RuntimeOperationCancellation {
	readonly operationRequestId: string;
	readonly operationToolCallId: string;
}

/** Defines one operation-specific payload after boundary validation. */
type RuntimeOperation =
	| KnowledgeRuntimeOperation
	| {
			readonly operation: "agent_operation";
			readonly payload: AgentOperationPayload;
	  }
	| {
			readonly operation: "append_journal";
			readonly payload: JournalRecord;
	  }
	| {
			readonly operation: "query_branch";
			readonly payload: QueryBranchRequest;
	  }
	| {
			readonly operation: "append_history";
			readonly payload: SubagentFeedback;
	  }
	| {
			readonly operation: "cancel_wait";
			readonly payload: RuntimeWaitCancellation;
	  }
	| {
			readonly operation: "cancel_operation";
			readonly payload: RuntimeOperationCancellation;
	  }
	| {
			readonly operation: "owner_stopping" | "delivery_acknowledgment";
			readonly payload: Record<string, never>;
	  };

/** Carries one validated runtime operation. */
export type RuntimeRequest = RuntimeRequestIdentity & RuntimeOperation;

/** Confirms one operation-specific command result. */
interface RuntimeAcknowledgment {
	readonly acknowledged: true;
}

/** Reports whether exact nested operation cancellation won before dispatch. */
export interface RuntimeOperationCancellationAcknowledgment {
	readonly acknowledged: true;
	readonly cancellationWon: boolean;
}

export type RuntimeWireMessage =
	| {
			readonly kind: "subagents-ready";
			readonly runtimeLeaseId: string;
			readonly ownerPiSessionId: string;
			readonly ownerSessionFile: string;
	  }
	| {
			readonly kind: "subagents-request";
			readonly source: "root" | "worker";
			readonly request: RuntimeRequest;
	  }
	| {
			readonly kind: "subagents-response";
			readonly source: "root" | "worker";
			readonly runtimeLeaseId: string;
			readonly requestId: string;
			readonly succeeded: boolean;
			readonly result?: unknown;
			readonly error?: string;
	  }
	| {
			readonly kind: "subagents-settled";
			readonly runtimeLeaseId: string;
			readonly requestId: string;
	  };

/** Parses the wire discriminator before delegating one closed message shape. */
export function parseWireMessage(
	value: unknown,
): RuntimeWireMessage | undefined {
	const kind = readString(value, "kind");
	switch (kind) {
		case "subagents-ready":
			return parseReadyMessage(value);
		case "subagents-request":
			return parseRequestMessage(value);
		case "subagents-response":
			return parseResponseMessage(value);
		case "subagents-settled":
			return parseSettledMessage(value);
		default:
			return undefined;
	}
}

/** Parses one worker-ready message. */
function parseReadyMessage(value: unknown): RuntimeWireMessage | undefined {
	if (
		!hasExactKeys(value, [
			"kind",
			"runtimeLeaseId",
			"ownerPiSessionId",
			"ownerSessionFile",
		])
	) {
		return undefined;
	}
	const runtimeLeaseId = readString(value, "runtimeLeaseId");
	const ownerPiSessionId = readString(value, "ownerPiSessionId");
	const ownerSessionFile = readString(value, "ownerSessionFile");
	return runtimeLeaseId === undefined ||
		ownerPiSessionId === undefined ||
		ownerSessionFile === undefined
		? undefined
		: {
				kind: "subagents-ready",
				runtimeLeaseId,
				ownerPiSessionId,
				ownerSessionFile,
			};
}

/** Parses one root- or worker-originated request message. */
function parseRequestMessage(value: unknown): RuntimeWireMessage | undefined {
	if (!hasExactKeys(value, ["kind", "source", "request"])) {
		return undefined;
	}
	const source = readSource(readField(value, "source"));
	const request = parseRuntimeRequest(readField(value, "request"));
	return source === undefined || request === undefined
		? undefined
		: { kind: "subagents-request", source, request };
}

/** Parses one correlated runtime response. */
function parseResponseMessage(value: unknown): RuntimeWireMessage | undefined {
	const runtimeLeaseId = readString(value, "runtimeLeaseId");
	const source = readSource(readField(value, "source"));
	const requestId = readString(value, "requestId");
	const succeeded = readField(value, "succeeded");
	if (
		typeof succeeded !== "boolean" ||
		!hasExactKeys(
			value,
			["kind", "source", "runtimeLeaseId", "requestId", "succeeded"],
			succeeded ? ["result"] : ["error"],
		) ||
		runtimeLeaseId === undefined ||
		source === undefined ||
		requestId === undefined
	) {
		return undefined;
	}
	const error = readField(value, "error");
	if (
		!succeeded &&
		error !== undefined &&
		(typeof error !== "string" || error.length === 0)
	) {
		return undefined;
	}
	return succeeded
		? {
				kind: "subagents-response",
				source,
				runtimeLeaseId,
				requestId,
				succeeded,
				result: readField(value, "result"),
			}
		: {
				kind: "subagents-response",
				source,
				runtimeLeaseId,
				requestId,
				succeeded,
				error: typeof error === "string" ? error : "runtime response failed",
			};
}

/** Parses one worker settlement acknowledgment. */
function parseSettledMessage(value: unknown): RuntimeWireMessage | undefined {
	if (!hasExactKeys(value, ["kind", "runtimeLeaseId", "requestId"])) {
		return undefined;
	}
	const runtimeLeaseId = readString(value, "runtimeLeaseId");
	const requestId = readString(value, "requestId");
	return runtimeLeaseId === undefined || requestId === undefined
		? undefined
		: { kind: "subagents-settled", runtimeLeaseId, requestId };
}

/** Reads the lease identity from either top-level or nested request framing. */
export function wireRuntimeLeaseId(message: RuntimeWireMessage): string {
	return message.kind === "subagents-request"
		? message.request.runtimeLeaseId
		: message.runtimeLeaseId;
}

/** Parses one closed-operation runtime request. */
function parseRuntimeRequest(value: unknown): RuntimeRequest | undefined {
	if (
		!hasExactKeys(value, [
			"requestId",
			"runtimeLeaseId",
			"ownerPiSessionId",
			"operation",
			"payload",
		])
	) {
		return undefined;
	}
	const requestId = readString(value, "requestId");
	const runtimeLeaseId = readString(value, "runtimeLeaseId");
	const ownerPiSessionId = readString(value, "ownerPiSessionId");
	const operation = readOperation(readField(value, "operation"));
	if (
		requestId === undefined ||
		runtimeLeaseId === undefined ||
		ownerPiSessionId === undefined ||
		operation === undefined
	) {
		return undefined;
	}
	const parsedOperation = parseRuntimeOperationPayload(
		operation,
		readField(value, "payload"),
	);
	return parsedOperation === undefined
		? undefined
		: {
				requestId,
				runtimeLeaseId,
				ownerPiSessionId,
				...parsedOperation,
			};
}

/** Parses one operation-specific payload before request dispatch. */
export function parseRuntimeOperationPayload(
	operation: RuntimeRequest["operation"],
	payload: unknown,
): RuntimeOperation | undefined {
	switch (operation) {
		case "knowledge_read":
		case "knowledge_acquire":
		case "knowledge_release":
		case "knowledge_cancel":
			return parseKnowledgeRuntimeOperation(operation, payload);
		case "agent_operation":
			try {
				return { operation, payload: parseAgentOperationPayload(payload) };
			} catch {
				return undefined;
			}
		case "query_branch":
			try {
				return { operation, payload: parseQueryBranchRequest(payload) };
			} catch {
				return undefined;
			}
		case "append_journal": {
			const record = parseJournalRecord(payload);
			return record === undefined ? undefined : { operation, payload: record };
		}
		case "append_history": {
			const feedback = parseFeedback(payload);
			return feedback === undefined
				? undefined
				: { operation, payload: feedback };
		}
		case "cancel_wait": {
			const cancellation = parseWaitCancellation(payload);
			return cancellation === undefined
				? undefined
				: { operation, payload: cancellation };
		}
		case "cancel_operation": {
			const cancellation = parseOperationCancellation(payload);
			return cancellation === undefined
				? undefined
				: { operation, payload: cancellation };
		}
		default:
			return hasExactKeys(payload, []) ? { operation, payload: {} } : undefined;
	}
}

/** Parses one exact start or steer cancellation correlation. */
function parseOperationCancellation(
	payload: unknown,
): RuntimeOperationCancellation | undefined {
	if (!hasExactKeys(payload, ["operationRequestId", "operationToolCallId"])) {
		return undefined;
	}
	const operationRequestId = readString(payload, "operationRequestId");
	const operationToolCallId = readString(payload, "operationToolCallId");
	return operationRequestId === undefined || operationToolCallId === undefined
		? undefined
		: { operationRequestId, operationToolCallId };
}

/** Parses one exact wait cancellation correlation. */
function parseWaitCancellation(
	payload: unknown,
): RuntimeWaitCancellation | undefined {
	if (!hasExactKeys(payload, ["waitRequestId", "waitToolCallId"])) {
		return undefined;
	}
	const waitRequestId = readString(payload, "waitRequestId");
	const waitToolCallId = readString(payload, "waitToolCallId");
	return waitRequestId === undefined || waitToolCallId === undefined
		? undefined
		: { waitRequestId, waitToolCallId };
}

/** Parses a successful nested result against its pending operation. */
export function parseRuntimeResponseResult(
	operation: RuntimeRequest["operation"],
	value: unknown,
):
	| AgentOperationResponse
	| QueryBranchResponse
	| KnowledgeSnapshots
	| KnowledgeMutationLease
	| RuntimeAcknowledgment
	| RuntimeOperationCancellationAcknowledgment
	| undefined {
	if (operation === "agent_operation") {
		try {
			return parseAgentOperationResponse(value);
		} catch {
			return undefined;
		}
	}
	if (operation === "query_branch") {
		try {
			return parseQueryBranchResponse(value);
		} catch {
			return undefined;
		}
	}
	if (
		operation === "knowledge_read" ||
		operation === "knowledge_acquire" ||
		operation === "knowledge_release" ||
		operation === "knowledge_cancel"
	) {
		return parseKnowledgeRuntimeResponse(operation, value);
	}
	if (operation === "cancel_operation") {
		const cancellationWon = readField(value, "cancellationWon");
		return hasExactKeys(value, ["acknowledged", "cancellationWon"]) &&
			readField(value, "acknowledged") === true &&
			typeof cancellationWon === "boolean"
			? { acknowledged: true, cancellationWon }
			: undefined;
	}
	return hasExactKeys(value, ["acknowledged"]) &&
		readField(value, "acknowledged") === true
		? { acknowledged: true }
		: undefined;
}

/** Narrows one wire message source. */
function readSource(value: unknown): "root" | "worker" | undefined {
	return value === "root" || value === "worker" ? value : undefined;
}

/** Narrows one closed runtime operation. */
function readOperation(
	value: unknown,
): RuntimeRequest["operation"] | undefined {
	return value === "agent_operation" ||
		value === "knowledge_read" ||
		value === "knowledge_acquire" ||
		value === "knowledge_release" ||
		value === "knowledge_cancel" ||
		value === "append_journal" ||
		value === "append_history" ||
		value === "query_branch" ||
		value === "cancel_wait" ||
		value === "cancel_operation" ||
		value === "owner_stopping" ||
		value === "delivery_acknowledgment"
		? value
		: undefined;
}
