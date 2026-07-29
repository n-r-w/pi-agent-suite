import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import { projectionStableKey } from "../projection";
import {
	openSessionBranchCursor,
	readLatestSessionEntryId,
	type SessionBranchCursor,
} from "../session-branch-loader";

/** Supplies active Pi entry pages without exposing process ownership. */
export interface SelectedConversationActiveSource {
	readActiveEntries(
		invocationId: string,
		since?: string,
	): Promise<{
		readonly entries: readonly SessionEntry[];
		readonly leafId: string | null;
	}>;
}

/** Supplies a completed branch when the caller already owns an inactive reader. */
export type InactiveConversationReader = (
	session: LogicalSession,
) => Promise<readonly SessionEntry[]> | readonly SessionEntry[];

/** Exposes the selected suffix without leaking mutable loader state. */
export interface SelectedConversationSnapshot {
	readonly entries: readonly SessionEntry[];
	readonly complete: boolean;
}

/** Configures one selected-only progressive branch loader. */
interface SelectedConversationLoaderOptions {
	readonly session: LogicalSession;
	readonly controller: AbortController;
	readonly activeConversations: SelectedConversationActiveSource;
	readonly readInactiveBranch?: InactiveConversationReader;
}

/** Owns one selected session's reverse cursor, active deltas, and branch suffix. */
export class SelectedConversationLoader {
	public readonly stableKey: string;
	private readonly entriesById = new Map<string, SessionEntry>();
	private operation: Promise<void> = Promise.resolve();
	private cursor: SessionBranchCursor | undefined;
	private lastEntryId: string | undefined;
	private leafId: string | null = null;
	private branch: readonly SessionEntry[] = Object.freeze([]);
	private complete = false;
	private lastState: LogicalSession["state"];
	private disposed = false;

	private constructor(
		private readonly controller: AbortController,
		private readonly activeConversations: SelectedConversationActiveSource,
		private readonly readInactiveBranch: InactiveConversationReader | undefined,
		session: LogicalSession,
	) {
		this.stableKey = projectionStableKey(session.key);
		this.lastState = session.state;
	}

	/** Opens a recent renderable turn or one already supplied complete branch. */
	public static async open(
		options: SelectedConversationLoaderOptions,
	): Promise<SelectedConversationLoader> {
		const loader = new SelectedConversationLoader(
			options.controller,
			options.activeConversations,
			options.readInactiveBranch,
			options.session,
		);
		try {
			await loader.openInitial(options.session);
			return loader;
		} catch (error) {
			await loader.dispose();
			throw error;
		}
	}

	/** Returns the current root-to-leaf suffix and its ancestry state. */
	public getSnapshot(): SelectedConversationSnapshot {
		return { entries: this.branch, complete: this.complete };
	}

	/** Loads one preceding user turn and reports whether the root is now present. */
	public async loadEarlier(): Promise<boolean> {
		if (this.disposed || this.complete) {
			return true;
		}
		await this.enqueue(async () => {
			const cursor = this.cursor;
			if (cursor === undefined) {
				this.complete = true;
				return;
			}
			const entries = await cursor.readPreviousTurn();
			mergeEntries(this.entriesById, entries, "child Pi session file");
			this.complete = cursor.complete;
			if (cursor.complete) {
				await cursor.dispose();
				this.cursor = undefined;
			}
			this.branch = this.resolveBranch();
		});
		return this.disposed || this.complete;
	}

	/** Completes persisted ancestry and applies any later active append page. */
	public async refresh(session: LogicalSession): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		return await this.enqueue(async () => {
			const becameTerminal =
				this.lastState === "active" && session.state !== "active";
			this.lastState = session.state;
			if (becameTerminal) {
				return await this.reloadTerminal(session);
			}
			let changed = false;
			const cursor = this.cursor;
			if (cursor !== undefined) {
				const entries = await cursor.readRemaining();
				changed =
					mergeEntries(this.entriesById, entries, "child Pi session file") ||
					changed;
				await cursor.dispose();
				this.cursor = undefined;
				this.complete = true;
				changed = true;
			}
			if (session.state === "active") {
				const page = await this.activeConversations.readActiveEntries(
					session.invocationId,
					this.lastEntryId,
				);
				changed =
					mergeEntries(this.entriesById, page.entries, "child Pi") || changed;
				this.lastEntryId = page.entries.at(-1)?.id ?? this.lastEntryId;
				if (this.leafId !== page.leafId) {
					this.leafId = page.leafId;
					changed = true;
				}
			}
			if (changed) {
				this.branch = this.resolveBranch();
			}
			return changed;
		});
	}

	/** Aborts file work and releases selected payload ownership. */
	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.controller.abort(
			new Error("management conversation selection released"),
		);
		await this.cursor?.dispose();
		this.cursor = undefined;
		this.entriesById.clear();
		this.branch = Object.freeze([]);
	}

	/** Selects the injected terminal reader, active catch-up, or persisted cursor. */
	private async openInitial(session: LogicalSession): Promise<void> {
		if (session.state !== "active" && this.readInactiveBranch !== undefined) {
			const entries = await Promise.resolve(this.readInactiveBranch(session));
			this.replaceCompleteBranch(entries);
			return;
		}
		if (session.state === "active") {
			await this.openActive(session);
			return;
		}
		const cursor = await openSessionBranchCursor({
			sessionFile: session.childSessionFile,
			signal: this.controller.signal,
		});
		const entries = await cursor.readPreviousTurn();
		this.cursor = cursor.complete ? undefined : cursor;
		mergeEntries(this.entriesById, entries, "child Pi session file");
		this.leafId = entries.at(-1)?.id ?? null;
		this.complete = cursor.complete;
		this.branch = this.resolveBranch();
		if (cursor.complete) {
			await cursor.dispose();
		}
	}

	/** Combines persisted ancestry with entries appended after its file boundary. */
	private async openActive(session: LogicalSession): Promise<void> {
		const persistedId = await readPersistedBoundary(
			session.childSessionFile,
			this.controller.signal,
		);
		const page = await this.activeConversations.readActiveEntries(
			session.invocationId,
			persistedId,
		);
		mergeEntries(this.entriesById, page.entries, "child Pi");
		this.lastEntryId = page.entries.at(-1)?.id ?? persistedId;
		this.leafId = page.leafId;

		if (persistedId === undefined) {
			this.complete = true;
			this.branch = this.resolveBranch();
			return;
		}
		const unresolvedId = unresolvedAncestorId(this.entriesById, this.leafId);
		if (unresolvedId === null) {
			this.complete = true;
			this.branch = this.resolveBranch();
			return;
		}
		const cursor = await openSessionBranchCursor({
			sessionFile: session.childSessionFile,
			leafId: unresolvedId,
			signal: this.controller.signal,
		});
		this.cursor = cursor;
		this.branch = this.resolveBranch();
		if (!this.branch.some(isUserMessageEntry)) {
			const entries = await cursor.readPreviousTurn();
			mergeEntries(this.entriesById, entries, "child Pi session file");
			this.complete = cursor.complete;
			this.branch = this.resolveBranch();
			if (cursor.complete) {
				await cursor.dispose();
				this.cursor = undefined;
			}
		}
	}

	/** Reopens the final file because the active cursor used an earlier size snapshot. */
	private async reloadTerminal(session: LogicalSession): Promise<boolean> {
		if (this.readInactiveBranch !== undefined) {
			const entries = await Promise.resolve(this.readInactiveBranch(session));
			return this.replaceTerminalBranch(entries);
		}
		const cursor = await openSessionBranchCursor({
			sessionFile: session.childSessionFile,
			signal: this.controller.signal,
		});
		try {
			return this.replaceTerminalBranch(await cursor.readRemaining());
		} finally {
			await cursor.dispose();
		}
	}

	/** Replaces terminal content only when append-only entry identities changed. */
	private replaceTerminalBranch(entries: readonly SessionEntry[]): boolean {
		const changed =
			!this.complete || !branchesHaveSameEntryIds(this.branch, entries);
		if (changed) {
			this.replaceCompleteBranch(entries);
		}
		return changed;
	}

	/** Replaces cache topology with one complete root-to-leaf branch. */
	private replaceCompleteBranch(entries: readonly SessionEntry[]): void {
		this.entriesById.clear();
		mergeEntries(this.entriesById, entries, "child Pi session file");
		this.leafId = entries.at(-1)?.id ?? null;
		this.lastEntryId = entries.at(-1)?.id ?? this.lastEntryId;
		this.complete = true;
		this.branch = Object.freeze([...entries]);
	}

	/** Resolves a suffix and requires the root only after hydration completes. */
	private resolveBranch(): readonly SessionEntry[] {
		if (this.leafId === null) {
			return Object.freeze([]);
		}
		const branch: SessionEntry[] = [];
		const visited = new Set<string>();
		let currentId: string | null = this.leafId;
		while (currentId !== null) {
			if (visited.has(currentId)) {
				throw new Error("child Pi returned a cyclic conversation branch");
			}
			visited.add(currentId);
			const entry = this.entriesById.get(currentId);
			if (entry === undefined) {
				if (this.complete) {
					throw new Error("child Pi returned an unknown conversation leaf");
				}
				break;
			}
			branch.unshift(entry);
			currentId = entry.parentId;
		}
		return Object.freeze(branch);
	}

	/** Serializes cursor access while preserving each caller's own result. */
	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operation.then(operation);
		this.operation = result.then(
			() => undefined,
			() => undefined,
		);
		return await result;
	}
}

/** Compares immutable append-only branch identities without serializing payloads. */
function branchesHaveSameEntryIds(
	left: readonly SessionEntry[],
	right: readonly SessionEntry[],
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry.id === right[index]?.id)
	);
}

/** Adds one append or persisted page while rejecting ambiguous duplicate topology. */
function mergeEntries(
	target: Map<string, SessionEntry>,
	entries: readonly SessionEntry[],
	source: string,
): boolean {
	for (const entry of entries) {
		if (target.has(entry.id)) {
			throw new Error(`${source} returned duplicate conversation entry ids`);
		}
		target.set(entry.id, entry);
	}
	return entries.length > 0;
}

/** Finds the first parent that must be loaded from the persisted reverse cursor. */
function unresolvedAncestorId(
	entriesById: ReadonlyMap<string, SessionEntry>,
	leafId: string | null,
): string | null {
	const visited = new Set<string>();
	let currentId = leafId;
	while (currentId !== null) {
		if (visited.has(currentId)) {
			throw new Error("child Pi returned a cyclic conversation branch");
		}
		visited.add(currentId);
		const entry = entriesById.get(currentId);
		if (entry === undefined) {
			return currentId;
		}
		currentId = entry.parentId;
	}
	return null;
}

/** Detects a dependency-complete user boundary inside one active catch-up suffix. */
function isUserMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** Reads the persisted boundary absent only before an active session flushes. */
async function readPersistedBoundary(
	sessionFile: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		return await readLatestSessionEntryId(sessionFile, signal);
	} catch (error) {
		if (isFileNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

/** Recognizes the missing-file state before the first assistant is persisted. */
function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}
