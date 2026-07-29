import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import { SelectedConversationLoader } from "./selected-conversation";

/** Creates one user entry for selected-loader lifecycle transitions. */
function userEntry(
	id: string,
	parentId: string | null,
	text: string,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

/** Creates one logical-session revision with stable identity and changing invocation state. */
function sessionRevision(
	state: LogicalSession["state"],
	invocationId: string,
): LogicalSession {
	return {
		key: { ownerPiSessionId: "root-owner", ownerLocalSessionId: 1 },
		childPiSessionId: "child-session",
		childSessionDir: "/tmp/non-persisted-selected-conversation",
		childSessionFile: "/tmp/non-persisted-selected-conversation/session.jsonl",
		agentId: "SubAgentCoder",
		taskName: "Continue twice",
		creationOrder: 1,
		invocationId,
		runtimeLeaseId: `runtime-${invocationId}`,
		ownerRuntimeLeaseId: "root-runtime",
		invocationMetadata: { startedAtMs: 1, elapsedMs: 0 },
		state,
	};
}

test("reloads each terminal file revision after repeated continuations", async () => {
	// Purpose: every active-to-terminal transition must replace RPC state with the final persisted branch, including later continuations.
	// Input and expected output: active, terminal, active continuation, and second terminal revisions invoke the inactive reader twice and retain the second terminal entry.
	// Edge case: stable logical identity and one loader survive both invocation state cycles.
	// Dependencies: deterministic active pages and an injected inactive branch reader; no real user file is accessed.
	const first = userEntry("first", null, "first");
	const continued = userEntry("continued", first.id, "continued");
	const finalized = userEntry("finalized", continued.id, "finalized");
	const pages = [
		{ entries: [first], leafId: first.id },
		{ entries: [continued], leafId: continued.id },
	];
	let terminalReads = 0;
	let terminalBranch: readonly SessionEntry[] = [first];
	const activeConversations = {
		/** Returns one page for the current active invocation. */
		async readActiveEntries() {
			const page = pages.shift();
			if (page === undefined) {
				throw new Error("selected conversation page queue is exhausted");
			}
			return page;
		},
	};
	const controller = new AbortController();
	const loader = await SelectedConversationLoader.open({
		session: sessionRevision("active", "first-invocation"),
		controller,
		activeConversations,
		readInactiveBranch: () => {
			terminalReads += 1;
			return terminalBranch;
		},
	});

	await loader.refresh(sessionRevision("terminal-success", "first-invocation"));
	await loader.refresh(sessionRevision("active", "continued-invocation"));
	terminalBranch = [first, continued, finalized];
	await loader.refresh(
		sessionRevision("terminal-success", "continued-invocation"),
	);

	expect(terminalReads).toBe(2);
	expect(loader.getSnapshot().entries.map((entry) => entry.id)).toEqual([
		"first",
		"continued",
		"finalized",
	]);
	await loader.dispose();
});
