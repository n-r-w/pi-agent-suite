import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	isSingleLineText,
	singleLineTextSchema,
} from "../../shared/text-contracts";
import { invocationElapsedSeconds, type SubagentFeedback } from "./domain";
import { sanitizePublicSubagentErrorMessage } from "./public-error";

const UNICODE_WHITE_SPACE_CODE_POINT = /^\p{White_Space}$/u;

/** Names the complete public subagent tool set. */
export const SUBAGENT_TOOL_NAMES = [
	"subagent_start",
	"subagent_steer",
	"subagent_wait",
	"subagent_query",
] as const;

/** Opens the available-subagent contribution for model context and diagnostics. */
export const AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG =
	'<available_subagents note="List of available subagent IDs">';

/** Closes the available-subagent contribution in model context. */
export const AVAILABLE_SUBAGENTS_PROMPT_CLOSING_TAG = "</available_subagents>";

/** Lists stable failed-tool codes. */
const SUBAGENT_FAILED_CODES = [
	"invalid_request",
	"agent_unavailable",
	"unknown_session",
	"not_owner",
	"message_rejected",
	"start_failed",
	"query_failed",
	"wait_already_active",
] as const;

/** Identifies one public failed-tool code. */
export type SubagentFailedCode = (typeof SUBAGENT_FAILED_CODES)[number];

/** Carries machine-readable failed-tool details. */
export interface SubagentFailureDetails {
	readonly code: SubagentFailedCode;
	readonly message: string;
}

/** Declares the exact public start request boundary. */
export const SubagentStartParameters = Type.Object(
	{
		agentId: singleLineTextSchema({
			description: "Subagent ID listed in <available_subagents>",
			minLength: 1,
		}),
		taskName: singleLineTextSchema({
			description: "Short task name for subagent session",
			minLength: 3,
			maxLength: 60,
		}),
		prompt: Type.String({
			description: "Instructions for subagent",
			minLength: 1,
			maxLength: 32768,
		}),
	},
	{ additionalProperties: false },
);

/** Declares the exact public steer request boundary. */
export const SubagentSteerParameters = Type.Object(
	{
		sessionId: Type.Integer({
			description: "Session ID returned by subagent_start",
			minimum: 1,
		}),
		prompt: Type.String({
			description: "Instructions to send to existing subagent session",
			minLength: 1,
			maxLength: 32768,
		}),
	},
	{ additionalProperties: false },
);

/** Declares the exact public query request boundary. */
export const SubagentQueryParameters = Type.Object(
	{
		sessionId: Type.Integer({
			description: "Session ID returned by subagent_start",
			minimum: 1,
		}),
		question: Type.String({
			description: "Question about specified subagent session",
			minLength: 1,
			maxLength: 4096,
		}),
	},
	{ additionalProperties: false },
);

/** Declares the exact public wait request boundary. */
export const SubagentWaitParameters = Type.Object(
	{
		sessionIds: Type.Array(Type.Integer({ minimum: 1 }), {
			description: "List of unique session IDs returned by subagent_start",
			minItems: 1,
			maxItems: 64,
			uniqueItems: true,
		}),
		timeout: Type.Integer({
			description: "Maximum wait time in seconds",
			minimum: 1,
			maximum: 3600,
		}),
	},
	{ additionalProperties: false },
);

/** Describes a validated start request. */
export type SubagentStartRequest = Static<typeof SubagentStartParameters>;
/** Describes a validated steer request. */
export type SubagentSteerRequest = Static<typeof SubagentSteerParameters>;
/** Describes a validated query request. */
export type SubagentQueryRequest = Static<typeof SubagentQueryParameters>;
/** Describes a validated wait request. */
export type SubagentWaitRequest = Static<typeof SubagentWaitParameters>;

/** Lists public normal results. */
export type SubagentNormalResult =
	| { readonly outcome: "accepted"; readonly sessionId: number }
	| ({
			readonly outcome: "feedback";
			readonly sessionId: number;
			readonly elapsedSeconds: number;
	  } & (
			| { readonly status: "success"; readonly output: string }
			| { readonly status: "failure" | "abort"; readonly error: string }
	  ))
	| { readonly outcome: "timeout" }
	| { readonly outcome: "no_active_sessions" };

/** Carries one public failed-tool result through Pi's throwing tool channel. */
export class SubagentToolError extends Error {
	public readonly details: SubagentFailureDetails;
	public readonly code: SubagentFailedCode;

	/** Creates a stable code while leaving message wording non-contractual. */
	public constructor(code: SubagentFailedCode, message: string) {
		const safeMessage = sanitizePublicSubagentErrorMessage(message);
		super(`[${code}] ${safeMessage}`);
		this.name = "SubagentToolError";
		this.code = code;
		this.details = { code, message: safeMessage };
	}
}

/** Validates and narrows an unknown start request once at the tool boundary. */
export function parseSubagentStartRequest(
	value: unknown,
): SubagentStartRequest {
	if (!isExactRecord(value, ["agentId", "taskName", "prompt"])) {
		throw invalidRequest(
			"subagent_start requires agentId, taskName, and prompt",
		);
	}
	const agentId = value["agentId"];
	const taskName = value["taskName"];
	const prompt = value["prompt"];
	if (
		!isSingleLineText(agentId) ||
		!isSingleLineText(taskName) ||
		typeof prompt !== "string" ||
		!hasNonWhitespaceCodePoint(prompt)
	) {
		throw invalidRequest("subagent_start request fields are invalid");
	}
	return { agentId, taskName, prompt };
}

/** Validates and narrows an unknown steer request once at the tool boundary. */
export function parseSubagentSteerRequest(
	value: unknown,
): SubagentSteerRequest {
	if (!isExactRecord(value, ["sessionId", "prompt"])) {
		throw invalidRequest("subagent_steer requires sessionId and prompt");
	}
	const sessionId = value["sessionId"];
	const prompt = value["prompt"];
	if (
		typeof sessionId !== "number" ||
		!Number.isInteger(sessionId) ||
		sessionId <= 0 ||
		typeof prompt !== "string" ||
		!hasNonWhitespaceCodePoint(prompt)
	) {
		throw invalidRequest("subagent_steer request fields are invalid");
	}
	return { sessionId, prompt };
}

/** Validates and narrows an unknown query request once at the tool boundary. */
export function parseSubagentQueryRequest(
	value: unknown,
): SubagentQueryRequest {
	if (!isExactRecord(value, ["sessionId", "question"])) {
		throw invalidRequest("subagent_query requires sessionId and question");
	}
	const sessionId = value["sessionId"];
	const question = value["question"];
	if (
		typeof sessionId !== "number" ||
		!Number.isInteger(sessionId) ||
		sessionId <= 0 ||
		typeof question !== "string" ||
		!hasNonWhitespaceCodePoint(question)
	) {
		throw invalidRequest("subagent_query request fields are invalid");
	}
	return { sessionId, question };
}

/** Validates and narrows an unknown wait request once at the tool boundary. */
export function parseSubagentWaitRequest(value: unknown): SubagentWaitRequest {
	if (!Check(SubagentWaitParameters, value)) {
		throw invalidRequest("subagent_wait request fields are invalid");
	}
	return value;
}

/** Validates one normal result returned through the runtime IPC bridge. */
export function parseSubagentNormalResult(
	value: unknown,
): SubagentNormalResult {
	const outcome =
		typeof value === "object" && value !== null
			? Reflect.get(value, "outcome")
			: undefined;
	if (isOutcomeOnlyResult(value, outcome)) {
		return { outcome };
	}
	const sessionId = readPositiveInteger(value, "sessionId");
	if (
		outcome === "accepted" &&
		sessionId !== undefined &&
		isExactRecord(value, ["outcome", "sessionId"])
	) {
		return { outcome, sessionId };
	}
	const status = readString(value, "status");
	const elapsedSeconds = readPositiveInteger(value, "elapsedSeconds");
	if (
		outcome === "feedback" &&
		sessionId !== undefined &&
		elapsedSeconds !== undefined &&
		status === "success" &&
		isExactRecord(value, [
			"outcome",
			"sessionId",
			"status",
			"elapsedSeconds",
			"output",
		])
	) {
		const output = readString(value, "output");
		if (output !== undefined) {
			return { outcome, sessionId, status, elapsedSeconds, output };
		}
	}
	if (
		outcome === "feedback" &&
		sessionId !== undefined &&
		elapsedSeconds !== undefined &&
		(status === "failure" || status === "abort") &&
		isExactRecord(value, [
			"outcome",
			"sessionId",
			"status",
			"elapsedSeconds",
			"error",
		])
	) {
		const error = readString(value, "error");
		if (error !== undefined) {
			return {
				outcome,
				sessionId,
				status,
				elapsedSeconds,
				error: sanitizePublicSubagentErrorMessage(error),
			};
		}
	}
	throw new SubagentToolError(
		"start_failed",
		"Subagent returned an invalid response",
	);
}

/** Converts terminal feedback to its exact public wait result. */
export function feedbackResult(
	feedback: SubagentFeedback,
): SubagentNormalResult {
	const sessionId = feedback.sessionKey.ownerLocalSessionId;
	const elapsedSeconds = invocationElapsedSeconds(
		feedback.presentation.invocationMetadata,
	);
	return feedback.status === "success"
		? {
				outcome: "feedback",
				sessionId,
				status: "success",
				elapsedSeconds,
				output: feedback.output,
			}
		: {
				outcome: "feedback",
				sessionId,
				status: feedback.status,
				elapsedSeconds,
				error: sanitizePublicSubagentErrorMessage(feedback.error),
			};
}

/** Reads one non-empty string from untrusted result data. */
function readString(value: unknown, key: string): string | undefined {
	const field =
		typeof value === "object" && value !== null
			? Reflect.get(value, key)
			: undefined;
	return typeof field === "string" ? field : undefined;
}

/** Reads one positive integer from untrusted result data. */
function readPositiveInteger(value: unknown, key: string): number | undefined {
	const field =
		typeof value === "object" && value !== null
			? Reflect.get(value, key)
			: undefined;
	return typeof field === "number" && Number.isInteger(field) && field > 0
		? field
		: undefined;
}

/** Returns a failed-tool error for structural request violations. */
function invalidRequest(message: string): SubagentToolError {
	return new SubagentToolError("invalid_request", message);
}

/** Identifies closed normal results whose outcome is their only field. */
function isOutcomeOnlyResult(
	value: unknown,
	outcome: unknown,
): outcome is "timeout" | "no_active_sessions" {
	return (
		(outcome === "timeout" || outcome === "no_active_sessions") &&
		isExactRecord(value, ["outcome"])
	);
}

/** Requires at least one Unicode code point outside the whitespace class. */
function hasNonWhitespaceCodePoint(value: string): boolean {
	return Array.from(value).some(
		(codePoint) => !UNICODE_WHITE_SPACE_CODE_POINT.test(codePoint),
	);
}

/** Rejects unknown object keys before any semantic validation. */
function isExactRecord(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const actualKeys = Object.keys(value);
	return (
		actualKeys.length === keys.length &&
		actualKeys.every((key) => keys.includes(key))
	);
}
