import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import { projectionStableKey } from "../projection";
import { ManagementProjectionRuntime } from "./runtime";

/** Creates one deterministic displayable user entry. */
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

/** Creates one displayable custom response owned by the preceding user turn. */
function customMessageEntry(
	id: string,
	parentId: string,
	text: string,
): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		customType: "fixture",
		content: text,
		display: true,
	};
}

/** Creates one catalog session without depending on a persisted file format. */
function logicalSession(
	id: number,
	state: LogicalSession["state"] = "terminal-success",
): LogicalSession {
	return {
		key: { ownerPiSessionId: "root-owner", ownerLocalSessionId: id },
		childPiSessionId: `child-${id}`,
		childSessionDir: `/tmp/child-${id}`,
		childSessionFile: `/tmp/child-${id}/session.jsonl`,
		agentId: "SubAgentCoder",
		taskName: `Session ${id}`,
		creationOrder: id,
		invocationId: `invocation-${id}`,
		runtimeLeaseId: `runtime-${id}`,
		ownerRuntimeLeaseId: "root-runtime",
		invocationMetadata: { startedAtMs: 1, elapsedMs: 0 },
		state,
	};
}

/** Supplies immutable catalog facts without production coordinator ownership. */
class CatalogFake {
	public constructor(private readonly sessions: readonly LogicalSession[]) {}

	/** Returns every deterministic fixture session. */
	public listAll(): readonly LogicalSession[] {
		return this.sessions;
	}

	/** Keeps catalog updates inert for isolated loading tests. */
	public subscribe(_listener: (session: LogicalSession) => void): () => void {
		return () => undefined;
	}
}

/** Supplies deterministic active deltas and records incremental boundaries. */
class ActiveConversationsFake {
	public readonly since: Array<string | undefined> = [];
	public constructor(
		private readonly pages: Array<{
			readonly entries: readonly SessionEntry[];
			readonly leafId: string | null;
		}>,
	) {}

	/** Returns one queued page for each active selected-session read. */
	public async readActiveEntries(
		_invocationId: string,
		since?: string,
	): Promise<{
		readonly entries: readonly SessionEntry[];
		readonly leafId: string | null;
	}> {
		this.since.push(since);
		const page = this.pages.shift();
		if (page === undefined) {
			throw new Error("active conversation fixture has no queued page");
		}
		return page;
	}

	/** Keeps activity inert because these tests call refresh through its public boundary. */
	public subscribeActivity(
		_listener: (invocationId: string) => void,
	): () => void {
		return () => undefined;
	}
}

/** Creates one runtime around deterministic saved and active sources. */
function createRuntime(
	sessions: readonly LogicalSession[],
	active: ActiveConversationsFake = new ActiveConversationsFake([]),
	readInactiveBranch: (
		session: LogicalSession,
	) => Promise<readonly SessionEntry[]> | readonly SessionEntry[] = () => [],
): ManagementProjectionRuntime {
	return new ManagementProjectionRuntime({
		rootOwnerPiSessionId: "root-owner",
		catalog: new CatalogFake(sessions),
		activeConversations: active,
		readInactiveBranch,
		onError: (error) => {
			throw error;
		},
	});
}

/** Returns visible entry ids from the selected immutable projection. */
function selectedIds(runtime: ManagementProjectionRuntime): readonly string[] {
	return runtime.getView().selectedConversation.map((entry) => entry.id);
}

describe("management projection runtime progressive loading", () => {
	test("paginates a complete saved branch without reading its storage", async () => {
		// Purpose: selection must reveal complete user turns while SessionManager remains the sole storage interpreter.
		// Input and expected output: three saved turns publish the newest turn first and prepend one turn per explicit request.
		// Edge case: every intermediate revision stays incomplete until the root turn is visible.
		// Dependencies: an injected immutable SessionManager branch and production projection orchestration.
		const firstUser = userEntry("first-user", null, "first");
		const firstReply = customMessageEntry("first-reply", firstUser.id, "one");
		const secondUser = userEntry("second-user", firstReply.id, "second");
		const secondReply = customMessageEntry(
			"second-reply",
			secondUser.id,
			"two",
		);
		const thirdUser = userEntry("third-user", secondReply.id, "third");
		const thirdReply = customMessageEntry("third-reply", thirdUser.id, "three");
		const branch = [
			firstUser,
			firstReply,
			secondUser,
			secondReply,
			thirdUser,
			thirdReply,
		];
		const session = logicalSession(1);
		const runtime = createRuntime([session], undefined, () => branch);

		await runtime.select(projectionStableKey(session.key));
		expect(selectedIds(runtime)).toEqual(["third-user", "third-reply"]);
		expect(runtime.getView().selectedConversationComplete).toBe(false);

		expect(await runtime.loadEarlierSelected()).toBe(false);
		expect(selectedIds(runtime)).toEqual([
			"second-user",
			"second-reply",
			"third-user",
			"third-reply",
		]);

		expect(await runtime.loadEarlierSelected()).toBe(true);
		expect(selectedIds(runtime)).toEqual(branch.map((entry) => entry.id));
		expect(runtime.getView().selectedConversationComplete).toBe(true);
		runtime.dispose();
	});

	test("opens a complete active RPC branch before applying deltas", async () => {
		// Purpose: active selection must never inspect the concurrently written Pi session file.
		// Input and expected output: initial get_entries returns the full branch without since, then one incremental page follows the last append id.
		// Edge case: the active leaf and its complete ancestry exist only in RPC data.
		// Dependencies: a deterministic active RPC fake and production branch resolution.
		const firstUser = userEntry("first-user", null, "first");
		const firstReply = customMessageEntry("first-reply", firstUser.id, "one");
		const secondUser = userEntry("second-user", firstReply.id, "second");
		const secondReply = customMessageEntry(
			"second-reply",
			secondUser.id,
			"two",
		);
		const thirdUser = userEntry("third-user", secondReply.id, "third");
		const thirdReply = customMessageEntry("third-reply", thirdUser.id, "three");
		const initial = [
			firstUser,
			firstReply,
			secondUser,
			secondReply,
			thirdUser,
			thirdReply,
		];
		const fourthUser = userEntry("fourth-user", thirdReply.id, "fourth");
		const fourthReply = customMessageEntry(
			"fourth-reply",
			fourthUser.id,
			"four",
		);
		const session = logicalSession(1, "active");
		const active = new ActiveConversationsFake([
			{ entries: initial, leafId: thirdReply.id },
			{ entries: [fourthUser, fourthReply], leafId: fourthReply.id },
		]);
		const runtime = createRuntime([session], active);

		await runtime.select(projectionStableKey(session.key));
		expect(active.since).toEqual([undefined]);
		expect(selectedIds(runtime)).toEqual(initial.map((entry) => entry.id));
		expect(runtime.getView().selectedConversationComplete).toBe(true);

		await runtime.refreshSelected();
		expect(active.since).toEqual([undefined, "third-reply"]);
		expect(selectedIds(runtime).slice(-2)).toEqual([
			"fourth-user",
			"fourth-reply",
		]);
		runtime.dispose();
	});

	test("ignores a saved snapshot that settles after a newer selection", async () => {
		// Purpose: safe non-termination of a migrating worker must not let stale data replace the current selection.
		// Input and expected output: the first delayed reader resolves after the second selection, but only the second branch remains published.
		// Edge case: the obsolete read cannot be cancelled because SessionManager may be rewriting a migrated file.
		// Dependencies: two catalog sessions and a controlled asynchronous inactive reader.
		const first = logicalSession(1);
		const second = logicalSession(2);
		const firstUser = userEntry("first-user", null, "first");
		const secondUser = userEntry("second-user", null, "second");
		let resolveFirst = (_entries: readonly SessionEntry[]): void => undefined;
		const firstRead = new Promise<readonly SessionEntry[]>((resolve) => {
			resolveFirst = resolve;
		});
		const runtime = createRuntime([first, second], undefined, (session) =>
			session.key.ownerLocalSessionId === 1 ? firstRead : [secondUser],
		);

		const obsolete = runtime.select(projectionStableKey(first.key));
		await Promise.resolve();
		const selected = runtime.select(projectionStableKey(second.key));
		await selected;
		resolveFirst([firstUser]);
		await obsolete;

		expect(runtime.getView().selectedStableKey).toBe(
			projectionStableKey(second.key),
		);
		expect(selectedIds(runtime)).toEqual(["second-user"]);
		runtime.dispose();
	});
});
