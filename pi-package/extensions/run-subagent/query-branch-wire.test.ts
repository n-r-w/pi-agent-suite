import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	parseQueryBranchRequest,
	parseQueryBranchResponse,
} from "./query-branch-wire";

const ENTRY = {
	type: "message",
	id: "entry-1",
	parentId: null,
	timestamp: "2026-07-29T00:00:00.000Z",
	message: { role: "user", content: "saved", timestamp: 1 },
} satisfies SessionEntry;

describe("query branch wire", () => {
	test("parses the closed request and response variants", () => {
		// Purpose: the process boundary must carry only a session ID and either one branch or one stable failure.
		// Input and expected output: exact request, success, and allowed failure variants round-trip unchanged.
		// Edge case: all ownership and loading failures share the same closed response parser.
		// Dependencies: production query branch boundary parsers only.
		expect({
			request: parseQueryBranchRequest({ sessionId: 7 }),
			success: parseQueryBranchResponse({ kind: "ok", branch: [ENTRY] }),
			unknown: parseQueryBranchResponse({
				kind: "failed",
				failure: { code: "unknown_session", message: "unknown" },
			}),
			notOwner: parseQueryBranchResponse({
				kind: "failed",
				failure: { code: "not_owner", message: "foreign" },
			}),
			queryFailed: parseQueryBranchResponse({
				kind: "failed",
				failure: { code: "query_failed", message: "unavailable" },
			}),
		}).toEqual({
			request: { sessionId: 7 },
			success: { kind: "ok", branch: [ENTRY] },
			unknown: {
				kind: "failed",
				failure: { code: "unknown_session", message: "unknown" },
			},
			notOwner: {
				kind: "failed",
				failure: { code: "not_owner", message: "foreign" },
			},
			queryFailed: {
				kind: "failed",
				failure: { code: "query_failed", message: "unavailable" },
			},
		});
	});

	test("rejects extra fields, empty branches, invalid entries, and foreign codes", () => {
		// Purpose: untrusted process messages must fail before they reach query execution.
		// Input and expected output: each malformed request or response throws a boundary error.
		// Edge case: a structurally valid failure with an unrelated Subagents V2 code is still rejected.
		// Dependencies: production query branch boundary parsers only.
		const operations = [
			() => parseQueryBranchRequest({ sessionId: 1, question: "leak" }),
			() => parseQueryBranchRequest({ sessionId: 0 }),
			() => parseQueryBranchResponse({ kind: "ok", branch: [] }),
			() =>
				parseQueryBranchResponse({
					kind: "ok",
					branch: [{ type: "message" }],
				}),
			() =>
				parseQueryBranchResponse({
					kind: "failed",
					failure: { code: "start_failed", message: "wrong boundary" },
				}),
		];

		for (const operation of operations) {
			expect(operation).toThrow();
		}
	});
});
