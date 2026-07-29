import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Writes one append-only session fixture and returns its stable path. */
function writeSession(
	directory: string,
	name: string,
	entries: readonly SessionEntry[],
): string {
	const sessionFile = join(directory, `${name}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: `session-${name}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: directory,
	};
	writeFileSync(
		sessionFile,
		`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return sessionFile;
}

/** Creates one catalog session backed by an isolated persisted file. */
function logicalSession(
	id: number,
	sessionFile: string,
	state: LogicalSession["state"] = "terminal-success",
): LogicalSession {
	return {
		key: { ownerPiSessionId: "root-owner", ownerLocalSessionId: id },
		childPiSessionId: `child-${id}`,
		childSessionDir: join(sessionFile, ".."),
		childSessionFile: sessionFile,
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

/** Creates one runtime around deterministic catalog and active-conversation sources. */
function createRuntime(
	sessions: readonly LogicalSession[],
	active: ActiveConversationsFake = new ActiveConversationsFake([]),
): ManagementProjectionRuntime {
	return new ManagementProjectionRuntime({
		rootOwnerPiSessionId: "root-owner",
		catalog: new CatalogFake(sessions),
		activeConversations: active,
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
	test("publishes the latest turn before hydrating the selected terminal branch", async () => {
		// Purpose: switching sessions must expose a renderable suffix before the complete persisted history is read.
		// Input and expected output: three turns publish the newest turn on select, one older turn on demand, then the complete branch in background.
		// Edge case: every intermediate revision remains marked incomplete until the root turn is present.
		// Dependencies: system-temporary JSONL, production reverse cursor, projection, and runtime orchestration.
		const directory = mkdtempSync(join(tmpdir(), "subagent-runtime-preview-"));
		try {
			const firstUser = userEntry("first-user", null, "first");
			const firstReply = customMessageEntry("first-reply", firstUser.id, "one");
			const secondUser = userEntry("second-user", firstReply.id, "second");
			const secondReply = customMessageEntry(
				"second-reply",
				secondUser.id,
				"two",
			);
			const thirdUser = userEntry("third-user", secondReply.id, "third");
			const thirdReply = customMessageEntry(
				"third-reply",
				thirdUser.id,
				"three",
			);
			const session = logicalSession(
				1,
				writeSession(directory, "terminal", [
					firstUser,
					firstReply,
					secondUser,
					secondReply,
					thirdUser,
					thirdReply,
				]),
			);
			const runtime = createRuntime([session]);

			await runtime.select(projectionStableKey(session.key));
			expect(selectedIds(runtime)).toEqual(["third-user", "third-reply"]);
			expect(runtime.getView().selectedConversationComplete).toBe(false);

			const completeAfterEarlier = await runtime.loadEarlierSelected();
			expect(completeAfterEarlier).toBe(false);
			expect(selectedIds(runtime)).toEqual([
				"second-user",
				"second-reply",
				"third-user",
				"third-reply",
			]);

			await runtime.refreshSelected();
			expect(selectedIds(runtime)).toEqual([
				"first-user",
				"first-reply",
				"second-user",
				"second-reply",
				"third-user",
				"third-reply",
			]);
			expect(runtime.getView().selectedConversationComplete).toBe(true);
			runtime.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("merges active catch-up and later incremental entries around persisted preview", async () => {
		// Purpose: active previews must avoid a full get_entries response while retaining exact live branch updates.
		// Input and expected output: select queries after the persisted id, shows the appended turn, hydrates persisted ancestors, then appends one activity delta.
		// Edge case: the active leaf initially exists only in the RPC catch-up page, not in the file snapshot.
		// Dependencies: system-temporary JSONL, production reverse cursor, and a deterministic active RPC fake.
		const directory = mkdtempSync(join(tmpdir(), "subagent-runtime-active-"));
		try {
			const firstUser = userEntry("first-user", null, "first");
			const firstReply = customMessageEntry("first-reply", firstUser.id, "one");
			const secondUser = userEntry("second-user", firstReply.id, "second");
			const secondReply = customMessageEntry(
				"second-reply",
				secondUser.id,
				"two",
			);
			const thirdUser = userEntry("third-user", secondReply.id, "third");
			const thirdReply = customMessageEntry(
				"third-reply",
				thirdUser.id,
				"three",
			);
			const fourthUser = userEntry("fourth-user", thirdReply.id, "fourth");
			const fourthReply = customMessageEntry(
				"fourth-reply",
				fourthUser.id,
				"four",
			);
			const session = logicalSession(
				1,
				writeSession(directory, "active", [
					firstUser,
					firstReply,
					secondUser,
					secondReply,
				]),
				"active",
			);
			const active = new ActiveConversationsFake([
				{ entries: [thirdUser, thirdReply], leafId: thirdReply.id },
				{ entries: [], leafId: thirdReply.id },
				{ entries: [fourthUser, fourthReply], leafId: fourthReply.id },
			]);
			const runtime = createRuntime([session], active);

			await runtime.select(projectionStableKey(session.key));
			expect(active.since).toEqual(["second-reply"]);
			expect(selectedIds(runtime)).toEqual(["third-user", "third-reply"]);

			await runtime.refreshSelected();
			expect(selectedIds(runtime)).toEqual([
				"first-user",
				"first-reply",
				"second-user",
				"second-reply",
				"third-user",
				"third-reply",
			]);
			expect(active.since).toEqual(["second-reply", "third-reply"]);

			await runtime.refreshSelected();
			expect(active.since).toEqual([
				"second-reply",
				"third-reply",
				"third-reply",
			]);
			expect(selectedIds(runtime).slice(-2)).toEqual([
				"fourth-user",
				"fourth-reply",
			]);
			runtime.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("cancels obsolete background hydration without surfacing an error", async () => {
		// Purpose: normal navigation must abort the prior reverse cursor without reporting a selected-conversation failure.
		// Input and expected output: background hydration starts for one session, switching to another fulfills both operations and publishes only the second preview.
		// Edge case: the first cursor is already consuming unread ancestors when selection ownership changes.
		// Dependencies: two system-temporary JSONL files and production loader cancellation.
		const directory = mkdtempSync(
			join(tmpdir(), "subagent-runtime-hydration-"),
		);
		try {
			const firstRoot = userEntry("first-root", null, "first root");
			const firstMiddle = userEntry(
				"first-middle",
				firstRoot.id,
				"first middle",
			);
			const firstLeaf = userEntry("first-leaf", firstMiddle.id, "first leaf");
			const secondUser = userEntry("second-user", null, "second");
			const first = logicalSession(
				1,
				writeSession(directory, "first-hydration", [
					firstRoot,
					firstMiddle,
					firstLeaf,
				]),
			);
			const second = logicalSession(
				2,
				writeSession(directory, "second-hydration", [secondUser]),
			);
			const runtime = createRuntime([first, second]);
			await runtime.select(projectionStableKey(first.key));

			const earlier = runtime.loadEarlierSelected();
			const hydration = runtime.refreshSelected();
			const selection = runtime.select(projectionStableKey(second.key));
			const outcomes = await Promise.allSettled([
				earlier,
				hydration,
				selection,
			]);

			expect(outcomes.map((outcome) => outcome.status)).toEqual([
				"fulfilled",
				"fulfilled",
				"fulfilled",
			]);
			expect(selectedIds(runtime)).toEqual(["second-user"]);
			runtime.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("prevents an obsolete preview from replacing a newer selection", async () => {
		// Purpose: rapid navigation must preserve the latest stable key even when an earlier file open settles afterward.
		// Input and expected output: two selects start without awaiting each other and the second session owns the final preview.
		// Edge case: the first selection is cancelled while its asynchronous reverse reader is opening.
		// Dependencies: two system-temporary JSONL files and production selection-generation cancellation.
		const directory = mkdtempSync(join(tmpdir(), "subagent-runtime-race-"));
		try {
			const firstUser = userEntry("first-user", null, "first");
			const secondUser = userEntry("second-user", null, "second");
			const first = logicalSession(
				1,
				writeSession(directory, "first", [firstUser]),
			);
			const second = logicalSession(
				2,
				writeSession(directory, "second", [secondUser]),
			);
			const runtime = createRuntime([first, second]);

			const obsolete = runtime.select(projectionStableKey(first.key));
			const selected = runtime.select(projectionStableKey(second.key));
			await Promise.all([obsolete, selected]);

			expect(runtime.getView().selectedStableKey).toBe(
				projectionStableKey(second.key),
			);
			expect(selectedIds(runtime)).toEqual(["second-user"]);
			runtime.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
