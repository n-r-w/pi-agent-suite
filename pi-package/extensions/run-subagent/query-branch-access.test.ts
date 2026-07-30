import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession, OwnerIdentity } from "./domain";
import { QueryBranchAccess } from "./query-branch-access";
import { SessionCatalog } from "./session-catalog";
import { SessionSnapshotLoader } from "./session-snapshot-loader";

const OWNER: OwnerIdentity = {
	ownerPiSessionId: "owner",
	ownerSessionFile: "/tmp/owner.jsonl",
};
const FOREIGN_OWNER: OwnerIdentity = {
	ownerPiSessionId: "foreign",
	ownerSessionFile: "/tmp/foreign.jsonl",
};

/** Records saved-session loads and returns one configured branch or failure. */
class BranchLoaderFake {
	public readonly loadedFiles: string[] = [];

	public constructor(
		private readonly outcome: readonly SessionEntry[] | Error,
	) {}

	/** Returns the configured branch after recording the authorized path. */
	public load(sessionFile: string): Promise<readonly SessionEntry[]> {
		this.loadedFiles.push(sessionFile);
		return this.outcome instanceof Error
			? Promise.reject(this.outcome)
			: Promise.resolve(this.outcome);
	}
}

/** Creates one active logical session for an owner-local ID. */
function logicalSession(
	owner: OwnerIdentity,
	ownerLocalSessionId: number,
	childSessionFile = `/tmp/child-${ownerLocalSessionId}.jsonl`,
): LogicalSession {
	return {
		key: { ownerPiSessionId: owner.ownerPiSessionId, ownerLocalSessionId },
		childPiSessionId: `child-${ownerLocalSessionId}`,
		childSessionDir: "/tmp",
		childSessionFile,
		agentId: "SubAgentCoder",
		taskName: "Query branch",
		creationOrder: ownerLocalSessionId,
		invocationId: `invocation-${ownerLocalSessionId}`,
		runtimeLeaseId: `lease-${ownerLocalSessionId}`,
		invocationMetadata: { startedAtMs: 0, elapsedMs: 0 },
		state: "active",
	};
}

/** Creates one structurally valid saved conversation entry. */
function sessionEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-29T00:00:00.000Z",
		message: { role: "user", content: "saved", timestamp: 1 },
	};
}

describe("QueryBranchAccess", () => {
	test("loads and validates one directly owned saved branch", async () => {
		// Purpose: root branch access must authorize before loading and return one validated non-empty branch.
		// Input and expected output: a direct owner and valid saved entry produce an ok response with the same entry.
		// Edge case: only the child session path, never the owner session path, reaches the loader.
		// Dependencies: real SessionCatalog plus an isolated loader fake.
		const catalog = new SessionCatalog();
		catalog.add(logicalSession(OWNER, 1));
		const branch = [sessionEntry("entry-1")];
		const loader = new BranchLoaderFake(branch);
		const access = new QueryBranchAccess(catalog, loader);

		expect(await access.load(OWNER, 1)).toEqual({ kind: "ok", branch });
		expect(loader.loadedFiles).toEqual(["/tmp/child-1.jsonl"]);
	});

	test("preserves ownership failures without reading a session file", async () => {
		// Purpose: query access must use the same unknown_session and not_owner distinction as other operations.
		// Input and expected output: a foreign known ID returns not_owner and an absent ID returns unknown_session.
		// Edge case: authorization failure performs no saved-session I/O.
		// Dependencies: real SessionCatalog plus an isolated loader fake.
		const catalog = new SessionCatalog();
		catalog.add(logicalSession(FOREIGN_OWNER, 2));
		const loader = new BranchLoaderFake([sessionEntry("unused")]);
		const access = new QueryBranchAccess(catalog, loader);

		expect(await access.load(OWNER, 2)).toMatchObject({
			kind: "failed",
			failure: { code: "not_owner" },
		});
		expect(await access.load(OWNER, 3)).toMatchObject({
			kind: "failed",
			failure: { code: "unknown_session" },
		});
		expect(loader.loadedFiles).toEqual([]);
	});

	test("maps known branch defects to concise query failures", async () => {
		// Purpose: known conversation defects must stop before a model request without exposing storage implementation details.
		// Input and expected output: missing, empty, and structurally invalid conversations receive distinct stable messages.
		// Edge case: persisted entries are validated again before they cross the worker boundary.
		// Dependencies: real SessionCatalog, the production snapshot loader, and isolated branch fakes.
		const missingCatalog = new SessionCatalog();
		missingCatalog.add(
			logicalSession(
				OWNER,
				1,
				join(tmpdir(), `missing-subagent-${randomUUID()}.jsonl`),
			),
		);
		const missing = await new QueryBranchAccess(
			missingCatalog,
			new SessionSnapshotLoader(),
		).load(OWNER, 1);
		const catalog = new SessionCatalog();
		catalog.add(logicalSession(OWNER, 1));
		const empty = await new QueryBranchAccess(
			catalog,
			new BranchLoaderFake([]),
		).load(OWNER, 1);
		const invalid = await new QueryBranchAccess(
			catalog,
			new BranchLoaderFake([{ type: "message" } as SessionEntry]),
		).load(OWNER, 1);

		expect([missing, empty, invalid]).toEqual([
			{
				kind: "failed",
				failure: {
					code: "query_failed",
					message: "Subagent is not ready, please try again after some time",
				},
			},
			{
				kind: "failed",
				failure: {
					code: "query_failed",
					message: "Subagent has no conversation to query",
				},
			},
			{
				kind: "failed",
				failure: {
					code: "query_failed",
					message: "Subagent conversation is invalid",
				},
			},
		]);
	});

	test("preserves unknown branch errors after public sanitization", async () => {
		// Purpose: unknown read failures must retain useful diagnostics while remaining terminal-safe and bounded.
		// Input and expected output: raw ANSI, line controls, and oversized content produce one truncated public message.
		// Edge case: the generic query prefix and storage vocabulary are not added.
		// Dependencies: real QueryBranchAccess error boundary and one rejecting loader fake.
		const catalog = new SessionCatalog();
		catalog.add(logicalSession(OWNER, 1));
		const result = await new QueryBranchAccess(
			catalog,
			new BranchLoaderFake(
				new Error(`unknown\u001b[31m failure\u001b[0m\n${"x".repeat(2_100)}`),
			),
		).load(OWNER, 1);
		if (result.kind !== "failed") {
			throw new Error("unknown branch failure unexpectedly succeeded");
		}

		expect(result.failure.message).toStartWith("unknown failure ");
		expect(result.failure.message).toEndWith("…");
		expect(result.failure.message.length).toBeLessThanOrEqual(2_000);
		for (const control of ["\u001b", "\n", "\r", "\t"]) {
			expect(result.failure.message).not.toContain(control);
		}
	});
});
