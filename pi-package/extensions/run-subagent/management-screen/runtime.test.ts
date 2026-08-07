import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import type { LiveAgentStatus } from "../live-status";
import {
	type ManagementProjectionView,
	projectionStableKey,
} from "../projection";
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

/** Supplies controlled catalog facts without production coordinator ownership. */
class CatalogFake {
	private sessions: readonly LogicalSession[];
	private listener: ((session: LogicalSession) => void) | undefined;

	public constructor(sessions: readonly LogicalSession[]) {
		this.sessions = sessions;
	}

	/** Returns every deterministic fixture session. */
	public listAll(): readonly LogicalSession[] {
		return this.sessions;
	}

	/** Retains the runtime listener until the catalog subscription ends. */
	public subscribe(listener: (session: LogicalSession) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) {
				this.listener = undefined;
			}
		};
	}

	/** Replaces one logical revision before publishing its catalog fact. */
	public update(session: LogicalSession): void {
		this.sessions = this.sessions.map((candidate) =>
			candidate.key.ownerLocalSessionId === session.key.ownerLocalSessionId
				? session
				: candidate,
		);
		this.listener?.(session);
	}
}

/** Describes one deterministic response from the active conversation source. */
interface ActiveConversationPage {
	readonly entries: readonly SessionEntry[];
	readonly leafId: string | null;
	readonly liveStatus: LiveAgentStatus | undefined;
	readonly projectionSavedTokens: number | undefined;
	readonly notification: ManagementProjectionView["selectedNotification"];
}

/** Supplies controlled active deltas, activity events, and incremental boundaries. */
class ActiveConversationsFake {
	public readonly since: Array<string | undefined> = [];
	private activityListener: ((invocationId: string) => void) | undefined;

	public constructor(
		private readonly pages: Array<
			ActiveConversationPage | Promise<ActiveConversationPage>
		>,
	) {}

	/** Returns one queued page for each active selected-session read. */
	public async readActiveEntries(
		_invocationId: string,
		since?: string,
	): Promise<ActiveConversationPage> {
		this.since.push(since);
		const page = this.pages.shift();
		if (page === undefined) {
			throw new Error("active conversation fixture has no queued page");
		}
		return await page;
	}

	/** Retains the runtime listener until the active source subscription ends. */
	public subscribeActivity(
		listener: (invocationId: string) => void,
	): () => void {
		this.activityListener = listener;
		return () => {
			if (this.activityListener === listener) {
				this.activityListener = undefined;
			}
		};
	}

	/** Emits activity at a caller-controlled lifecycle boundary. */
	public emitActivity(invocationId: string): void {
		this.activityListener?.(invocationId);
	}
}

/** Creates one runtime around deterministic saved and active sources. */
function createRuntime(
	sessions: readonly LogicalSession[] | CatalogFake,
	active: ActiveConversationsFake = new ActiveConversationsFake([]),
	readInactiveBranch: (
		session: LogicalSession,
	) => Promise<readonly SessionEntry[]> | readonly SessionEntry[] = () => [],
): ManagementProjectionRuntime {
	return new ManagementProjectionRuntime({
		rootOwnerPiSessionId: "root-owner",
		catalog:
			sessions instanceof CatalogFake ? sessions : new CatalogFake(sessions),
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
		// Edge case: a non-event refresh during opening cannot bypass the incomplete viewport preview.
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
		let resolveBranch = (_entries: readonly SessionEntry[]): void => undefined;
		const branchRead = new Promise<readonly SessionEntry[]>((resolve) => {
			resolveBranch = resolve;
		});
		const runtime = createRuntime([session], undefined, () => branchRead);

		const opening = runtime.select(projectionStableKey(session.key));
		await runtime.refreshSelected();
		resolveBranch(branch);
		await opening;
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
			{
				entries: initial,
				leafId: thirdReply.id,
				liveStatus: { kind: "working" },
				projectionSavedTokens: undefined,
				notification: undefined,
			},
			{
				entries: [fourthUser, fourthReply],
				leafId: fourthReply.id,
				liveStatus: {
					kind: "retrying",
					attempt: 2,
					maxAttempts: 3,
					deadlineAtMs: 5_000,
				},
				projectionSavedTokens: undefined,
				notification: undefined,
			},
		]);
		const runtime = createRuntime([session], active);

		await runtime.select(projectionStableKey(session.key));
		expect(active.since).toEqual([undefined]);
		expect(selectedIds(runtime)).toEqual(initial.map((entry) => entry.id));
		expect(runtime.getView().selectedConversationComplete).toBe(true);
		expect(runtime.getView().selectedLiveStatus).toEqual({ kind: "working" });

		await runtime.refreshSelected();
		expect(active.since).toEqual([undefined, "third-reply"]);
		expect(selectedIds(runtime).slice(-2)).toEqual([
			"fourth-user",
			"fourth-reply",
		]);
		expect(runtime.getView().selectedLiveStatus).toEqual({
			kind: "retrying",
			attempt: 2,
			maxAttempts: 3,
			deadlineAtMs: 5_000,
		});
		runtime.dispose();
	});

	test("catches up activity that arrives while an active selection opens", async () => {
		// Purpose: a committed active append must not wait for another event when selection is still opening.
		// Input and expected output: activity arrives while the initial snapshot is pending, then one incremental page follows its final id.
		// Edge case: the selected loader does not own the initial snapshot until after the activity refresh attempts to run.
		// Dependencies: a controlled active RPC page and the production refresh coalescer.
		const firstUser = userEntry("first-user", null, "first");
		const firstReply = customMessageEntry("first-reply", firstUser.id, "one");
		const secondUser = userEntry("second-user", firstReply.id, "second");
		const secondReply = customMessageEntry(
			"second-reply",
			secondUser.id,
			"two",
		);
		let resolveInitial = (_page: ActiveConversationPage): void => undefined;
		const initialRead = new Promise<ActiveConversationPage>((resolve) => {
			resolveInitial = resolve;
		});
		const session = logicalSession(1, "active");
		const active = new ActiveConversationsFake([
			initialRead,
			{
				entries: [secondUser, secondReply],
				leafId: secondReply.id,
				liveStatus: undefined,
				projectionSavedTokens: undefined,
				notification: undefined,
			},
		]);
		const runtime = createRuntime([session], active);

		const opening = runtime.select(projectionStableKey(session.key));
		await Promise.resolve();
		expect(active.since).toEqual([undefined]);
		active.emitActivity(session.invocationId);
		resolveInitial({
			entries: [firstUser, firstReply],
			leafId: firstReply.id,
			liveStatus: undefined,
			projectionSavedTokens: undefined,
			notification: undefined,
		});
		await opening;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(active.since).toEqual([undefined, firstReply.id]);
		expect(selectedIds(runtime)).toEqual([
			firstUser.id,
			firstReply.id,
			secondUser.id,
			secondReply.id,
		]);
		runtime.dispose();
	});

	test("does not transfer opening activity to a newer selection", async () => {
		// Purpose: activity ownership must remain bound to the selection that observed it.
		// Input and expected output: the first active read remains pending while a second active session opens without an incremental request.
		// Edge case: the obsolete read settles only after the newer loader owns the projection.
		// Dependencies: two controlled active snapshots and production selection generations.
		const firstSession = logicalSession(1, "active");
		const secondSession = logicalSession(2, "active");
		const firstUser = userEntry("first-user", null, "first");
		const secondUser = userEntry("second-user", null, "second");
		let resolveFirst = (_page: ActiveConversationPage): void => undefined;
		const firstRead = new Promise<ActiveConversationPage>((resolve) => {
			resolveFirst = resolve;
		});
		const active = new ActiveConversationsFake([
			firstRead,
			{
				entries: [secondUser],
				leafId: secondUser.id,
				liveStatus: undefined,
				projectionSavedTokens: undefined,
				notification: undefined,
			},
		]);
		const runtime = createRuntime([firstSession, secondSession], active);

		const obsolete = runtime.select(projectionStableKey(firstSession.key));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(active.since).toEqual([undefined]);
		active.emitActivity(firstSession.invocationId);
		await runtime.select(projectionStableKey(secondSession.key));
		resolveFirst({
			entries: [firstUser],
			leafId: firstUser.id,
			liveStatus: undefined,
			projectionSavedTokens: undefined,
			notification: undefined,
		});
		await obsolete;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(active.since).toEqual([undefined, undefined]);
		expect(runtime.getView().selectedStableKey).toBe(
			projectionStableKey(secondSession.key),
		);
		expect(selectedIds(runtime)).toEqual([secondUser.id]);
		runtime.dispose();
	});

	test("discards opening activity when the runtime is disposed", async () => {
		// Purpose: closing management must release a pending catch-up without reading or publishing again.
		// Input and expected output: activity arrives during a pending active snapshot, then disposal leaves only the initial RPC call.
		// Edge case: the non-cancellable RPC response settles after runtime ownership ends.
		// Dependencies: a controlled active snapshot and production runtime disposal.
		const session = logicalSession(1, "active");
		const firstUser = userEntry("first-user", null, "first");
		let resolveInitial = (_page: ActiveConversationPage): void => undefined;
		const initialRead = new Promise<ActiveConversationPage>((resolve) => {
			resolveInitial = resolve;
		});
		const active = new ActiveConversationsFake([initialRead]);
		const runtime = createRuntime([session], active);

		const opening = runtime.select(projectionStableKey(session.key));
		await new Promise<void>((resolve) => setImmediate(resolve));
		active.emitActivity(session.invocationId);
		runtime.dispose();
		resolveInitial({
			entries: [firstUser],
			leafId: firstUser.id,
			liveStatus: undefined,
			projectionSavedTokens: undefined,
			notification: undefined,
		});
		await opening;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(active.since).toEqual([undefined]);
		expect(runtime.getView().selectedConversation).toEqual([]);
	});

	test("reloads a terminal snapshot when state changes during active opening", async () => {
		// Purpose: a terminal transition during opening must replace the active snapshot without waiting for another catalog event.
		// Input and expected output: the catalog becomes terminal before the active read settles, then the saved final branch is published.
		// Edge case: the pending refresh changes reader type after the new loader takes ownership.
		// Dependencies: a controlled catalog revision, active RPC page, and saved branch reader.
		const activeSession = logicalSession(1, "active");
		const terminalSession = logicalSession(1, "terminal-success");
		const firstUser = userEntry("first-user", null, "first");
		const finalReply = customMessageEntry("final-reply", firstUser.id, "done");
		let resolveInitial = (_page: ActiveConversationPage): void => undefined;
		const initialRead = new Promise<ActiveConversationPage>((resolve) => {
			resolveInitial = resolve;
		});
		const active = new ActiveConversationsFake([initialRead]);
		const catalog = new CatalogFake([activeSession]);
		let terminalReads = 0;
		const runtime = createRuntime(catalog, active, () => {
			terminalReads += 1;
			return [firstUser, finalReply];
		});

		const opening = runtime.select(projectionStableKey(activeSession.key));
		await Promise.resolve();
		catalog.update(terminalSession);
		resolveInitial({
			entries: [firstUser],
			leafId: firstUser.id,
			liveStatus: undefined,
			projectionSavedTokens: undefined,
			notification: undefined,
		});
		await opening;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(active.since).toEqual([undefined]);
		expect(terminalReads).toBe(1);
		expect(selectedIds(runtime)).toEqual([firstUser.id, finalReply.id]);
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
