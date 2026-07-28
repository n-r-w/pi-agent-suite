import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { SubagentFeedback } from "./domain";

const TASK_NAME_MIN_CODE_POINTS = 3;
const TASK_NAME_MAX_CODE_POINTS = 60;
const HIGH_SURROGATE_PATTERN = "[\\uD800-\\uDBFF]";
const LOW_SURROGATE_PATTERN = "[\\uDC00-\\uDFFF]";
const NON_SURROGATE_PATTERN = "[^\\uD800-\\uDFFF]";
const TASK_NAME_CODE_POINT_PATTERN = `^(?:(?:${HIGH_SURROGATE_PATTERN}${LOW_SURROGATE_PATTERN}|${NON_SURROGATE_PATTERN})){3,60}$`;
const UNICODE_WHITE_SPACE_CODE_POINT = /^\p{White_Space}$/u;

/** Names the complete public V2 tool set. */
export const SUBAGENT_TOOL_NAMES = [
	"subagent_start",
	"subagent_steer",
	"subagent_wait",
] as const;

/** Marks the callable-agent contribution for runtime diagnostics. */
export const SUBAGENTS_PROMPT_MARKER = "<subagents-v2-callable-agents>";

/** Lists stable failed-tool codes. */
const SUBAGENT_FAILED_CODES = [
	"invalid_request",
	"agent_unavailable",
	"unknown_session",
	"not_owner",
	"message_rejected",
	"start_failed",
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
		agentId: Type.String(),
		taskName: Type.String({ pattern: TASK_NAME_CODE_POINT_PATTERN }),
		prompt: Type.String(),
	},
	{ additionalProperties: false },
);

/** Declares the exact public steer request boundary. */
export const SubagentSteerParameters = Type.Object(
	{
		sessionId: Type.Integer({ minimum: 1 }),
		prompt: Type.String(),
	},
	{ additionalProperties: false },
);

/** Declares the exact public wait request boundary. */
export const SubagentWaitParameters = Type.Object(
	{
		sessionIds: Type.Array(Type.Integer({ minimum: 1 }), {
			minItems: 1,
			uniqueItems: true,
		}),
		timeoutMs: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
	},
	{ additionalProperties: false },
);

/** Describes a validated start request. */
export type SubagentStartRequest = Static<typeof SubagentStartParameters>;
/** Describes a validated steer request. */
export type SubagentSteerRequest = Static<typeof SubagentSteerParameters>;
/** Describes a validated wait request. */
export type SubagentWaitRequest = Static<typeof SubagentWaitParameters>;

/** Lists public normal results. */
export type SubagentNormalResult =
	| { readonly outcome: "accepted"; readonly sessionId: number }
	| ({ readonly outcome: "feedback"; readonly sessionId: number } & (
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
		super(`[${code}] ${message}`);
		this.name = "SubagentToolError";
		this.code = code;
		this.details = { code, message };
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
		typeof agentId !== "string" ||
		typeof taskName !== "string" ||
		codePointLength(taskName) < TASK_NAME_MIN_CODE_POINTS ||
		codePointLength(taskName) > TASK_NAME_MAX_CODE_POINTS ||
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
	if (
		outcome === "feedback" &&
		sessionId !== undefined &&
		status === "success" &&
		isExactRecord(value, ["outcome", "sessionId", "status", "output"])
	) {
		const output = readString(value, "output");
		if (output !== undefined) {
			return { outcome, sessionId, status, output };
		}
	}
	if (
		outcome === "feedback" &&
		sessionId !== undefined &&
		(status === "failure" || status === "abort") &&
		isExactRecord(value, ["outcome", "sessionId", "status", "error"])
	) {
		const error = readString(value, "error");
		if (error !== undefined) {
			return { outcome, sessionId, status, error };
		}
	}
	throw new SubagentToolError(
		"start_failed",
		"runtime returned an invalid result",
	);
}

/** Converts terminal feedback to its exact public wait result. */
export function feedbackResult(
	feedback: SubagentFeedback,
): SubagentNormalResult {
	const sessionId = feedback.sessionKey.ownerLocalSessionId;
	return feedback.status === "success"
		? {
				outcome: "feedback",
				sessionId,
				status: "success",
				output: feedback.output,
			}
		: {
				outcome: "feedback",
				sessionId,
				status: feedback.status,
				error: feedback.error,
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

/** Counts Unicode code points instead of UTF-16 code units or grapheme clusters. */
function codePointLength(value: string): number {
	return Array.from(value).length;
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
