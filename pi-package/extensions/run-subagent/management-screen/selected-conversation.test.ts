import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../../../../test/support/persisted-session";
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
	sessionFile = "/tmp/non-persisted-selected-conversation/session.jsonl",
): LogicalSession {
	return {
		key: { ownerPiSessionId: "root-owner", ownerLocalSessionId: 1 },
		childPiSessionId: "child-session",
		childSessionDir: dirname(sessionFile),
		childSessionFile: sessionFile,
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

test("opens an active conversation from one complete RPC snapshot", async () => {
	// Purpose: active conversation loading must avoid direct reads of the concurrently written Pi session file.
	// Input and expected output: an existing persisted file still causes the initial get_entries request to omit since and return a complete branch.
	// Edge case: the persisted file already has a latest entry that the legacy loader would have used as an RPC boundary.
	// Dependencies: a temporary public SessionManager fixture and an isolated active-conversation source.
	const directory = mkdtempSync(
		join(tmpdir(), "selected-active-conversation-"),
	);
	try {
		const manager = createPersistedSession(directory, {
			id: "selected-active",
			text: "complete active branch",
		});
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) {
			throw new Error("persisted session fixture did not create a file");
		}
		const branch = manager.getBranch();
		const leafId = branch.at(-1)?.id ?? null;
		const boundaries: Array<string | undefined> = [];
		const activeConversations = {
			/** Records the initial RPC boundary and returns the complete public branch. */
			async readActiveEntries(_invocationId: string, since?: string) {
				boundaries.push(since);
				return { entries: branch, leafId };
			},
		};
		const loader = await SelectedConversationLoader.open({
			session: sessionRevision("active", "active-invocation", sessionFile),
			controller: new AbortController(),
			activeConversations,
			readInactiveBranch: () => branch,
		});

		expect(boundaries).toEqual([undefined]);
		expect(loader.getSnapshot()).toEqual({ entries: branch, complete: true });
		await loader.dispose();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("paginates an inactive branch in memory by complete user turns", async () => {
	// Purpose: moving SessionManager work off-thread must preserve the management screen's incremental history disclosure.
	// Input and expected output: a complete three-turn snapshot initially shows the latest turn and prepends one prior turn per request.
	// Edge case: the complete flag changes only when the root turn becomes visible.
	// Dependencies: an injected full inactive branch; no real user file or active child process is accessed.
	const first = userEntry("first", null, "first");
	const second = userEntry("second", first.id, "second");
	const third = userEntry("third", second.id, "third");
	const branch = [first, second, third];
	const loader = await SelectedConversationLoader.open({
		session: sessionRevision("terminal-success", "terminal-invocation"),
		controller: new AbortController(),
		activeConversations: {
			/** Rejects unexpected active reads for one terminal fixture. */
			async readActiveEntries() {
				throw new Error("terminal fixture requested active entries");
			},
		},
		readInactiveBranch: () => branch,
	});

	expect(loader.getSnapshot()).toEqual({ entries: [third], complete: false });
	expect(await loader.loadEarlier()).toBe(false);
	expect(loader.getSnapshot()).toEqual({
		entries: [second, third],
		complete: false,
	});
	expect(await loader.loadEarlier()).toBe(true);
	expect(loader.getSnapshot()).toEqual({ entries: branch, complete: true });
	await loader.dispose();
});

test("completes an inactive preview during background refresh", async () => {
	// Purpose: the loading indicator must disappear after the screen requests background hydration of an in-memory saved branch.
	// Input and expected output: a three-turn terminal preview starts incomplete, then one refresh publishes the full branch and reports a change.
	// Edge case: no new terminal revision or file read is required because SessionManager already returned the complete branch.
	// Dependencies: an injected full inactive branch and the production refresh boundary.
	const first = userEntry("first", null, "first");
	const second = userEntry("second", first.id, "second");
	const third = userEntry("third", second.id, "third");
	const branch = [first, second, third];
	const session = sessionRevision("terminal-success", "terminal-invocation");
	const loader = await SelectedConversationLoader.open({
		session,
		controller: new AbortController(),
		activeConversations: {
			/** Rejects unexpected active reads for one terminal fixture. */
			async readActiveEntries() {
				throw new Error("terminal fixture requested active entries");
			},
		},
		readInactiveBranch: () => branch,
	});

	expect(await loader.refresh(session)).toBe(true);
	expect(loader.getSnapshot()).toEqual({ entries: branch, complete: true });
	await loader.dispose();
});
