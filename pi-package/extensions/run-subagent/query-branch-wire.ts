import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { hasExactKeys, readField } from "./boundary-validation";
import type { SubagentFailureDetails } from "./contracts";
import { parseConversationSessionEntry } from "./session-entry-validation";

type QueryBranchFailureCode = Extract<
	SubagentFailureDetails["code"],
	"unknown_session" | "not_owner" | "query_failed"
>;

/** Restricts process-visible query failures to ownership and branch loading. */
interface QueryBranchFailureDetails {
	readonly code: QueryBranchFailureCode;
	readonly message: string;
}

/** Carries the only operation-specific field needed for branch access. */
export interface QueryBranchRequest {
	readonly sessionId: number;
}

/** Carries one validated saved branch or an ownership/loading failure. */
export type QueryBranchResponse =
	| { readonly kind: "ok"; readonly branch: readonly SessionEntry[] }
	| {
			readonly kind: "failed";
			readonly failure: QueryBranchFailureDetails;
	  };

/** Parses one closed worker-to-root branch request. */
export function parseQueryBranchRequest(value: unknown): QueryBranchRequest {
	const sessionId = readField(value, "sessionId");
	if (
		!hasExactKeys(value, ["sessionId"]) ||
		typeof sessionId !== "number" ||
		!Number.isInteger(sessionId) ||
		sessionId <= 0
	) {
		throw new Error("worker sent an invalid query branch request");
	}
	return { sessionId };
}

/** Parses one closed root-to-worker branch response. */
export function parseQueryBranchResponse(value: unknown): QueryBranchResponse {
	const kind = readField(value, "kind");
	if (kind === "ok") {
		return parseSuccessfulResponse(value);
	}
	if (kind === "failed") {
		return parseFailedResponse(value);
	}
	throw new Error("root returned an invalid query branch response");
}

/** Validates every saved entry before returning a non-empty branch. */
function parseSuccessfulResponse(value: unknown): QueryBranchResponse {
	const branch = readField(value, "branch");
	if (
		!hasExactKeys(value, ["kind", "branch"]) ||
		!Array.isArray(branch) ||
		branch.length === 0
	) {
		throw new Error("root returned an invalid query branch response");
	}
	return {
		kind: "ok",
		branch: Object.freeze(
			branch.map((entry, index) =>
				parseConversationSessionEntry(entry, `query branch entry ${index}`),
			),
		),
	};
}

/** Restricts branch failures to ownership and saved-session loading codes. */
function parseFailedResponse(value: unknown): QueryBranchResponse {
	const failure = readField(value, "failure");
	const code = readField(failure, "code");
	const message = readField(failure, "message");
	if (
		!hasExactKeys(value, ["kind", "failure"]) ||
		!hasExactKeys(failure, ["code", "message"]) ||
		!isQueryBranchFailureCode(code) ||
		typeof message !== "string"
	) {
		throw new Error("root returned an invalid query branch response");
	}
	return {
		kind: "failed",
		failure: { code, message },
	};
}

/** Narrows one failure code to the query branch response contract. */
function isQueryBranchFailureCode(
	value: unknown,
): value is QueryBranchFailureCode {
	return (
		value === "unknown_session" ||
		value === "not_owner" ||
		value === "query_failed"
	);
}
