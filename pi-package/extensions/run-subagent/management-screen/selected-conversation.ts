import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import { projectionStableKey } from "../projection";

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

/** Supplies a completed saved branch through the installed Pi SessionManager. */
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
	readonly readInactiveBranch: InactiveConversationReader;
}

/** Owns one selected session's active deltas and in-memory saved-branch pages. */
export class SelectedConversationLoader {
	public readonly stableKey: string;
	private readonly entriesById = new Map<string, SessionEntry>();
	private operation: Promise<void> = Promise.resolve();
	private lastEntryId: string | undefined;
	private leafId: string | null = null;
	private branch: readonly SessionEntry[] = Object.freeze([]);
	private inactiveBranch: readonly SessionEntry[] | undefined;
	private inactiveStartIndex = 0;
	private complete = false;
	private lastState: LogicalSession["state"];
	private disposed = false;

	private constructor(
		private readonly controller: AbortController,
		private readonly activeConversations: SelectedConversationActiveSource,
		private readonly readInactiveBranch: InactiveConversationReader,
		session: LogicalSession,
	) {
		this.stableKey = projectionStableKey(session.key);
		this.lastState = session.state;
	}

	/** Opens a complete active RPC branch or the latest saved user turn. */
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

	/** Reveals one preceding saved user turn from the in-memory branch. */
	public async loadEarlier(): Promise<boolean> {
		if (this.disposed || this.complete) {
			return true;
		}
		await this.enqueue(async () => {
			const entries = this.inactiveBranch;
			if (entries === undefined) {
				this.complete = true;
				return;
			}
			this.inactiveStartIndex = findPreviousTurnStart(
				entries,
				this.inactiveStartIndex,
			);
			this.complete = this.inactiveStartIndex === 0;
			this.branch = Object.freeze(entries.slice(this.inactiveStartIndex));
		});
		return this.disposed || this.complete;
	}

	/** Applies active append pages or replaces them with the final saved branch. */
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
			if (session.state !== "active") {
				return this.completeInactivePreview();
			}
			const page = await this.activeConversations.readActiveEntries(
				session.invocationId,
				this.lastEntryId,
			);
			let changed = mergeEntries(this.entriesById, page.entries, "child Pi");
			this.lastEntryId = page.entries.at(-1)?.id ?? this.lastEntryId;
			if (this.leafId !== page.leafId) {
				this.leafId = page.leafId;
				changed = true;
			}
			if (changed) {
				this.branch = this.resolveBranch();
			}
			return changed;
		});
	}

	/** Releases selected payload ownership without interrupting Pi migration. */
	public async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.controller.abort(
			new Error("management conversation selection released"),
		);
		this.entriesById.clear();
		this.branch = Object.freeze([]);
		this.inactiveBranch = undefined;
	}

	/** Selects a complete active RPC read or a saved SessionManager snapshot. */
	private async openInitial(session: LogicalSession): Promise<void> {
		if (session.state === "active") {
			await this.openActive(session);
			return;
		}
		const entries = await Promise.resolve(this.readInactiveBranch(session));
		this.openInactiveBranch(entries);
	}

	/** Loads all active entries through RPC so the session file remains untouched. */
	private async openActive(session: LogicalSession): Promise<void> {
		const page = await this.activeConversations.readActiveEntries(
			session.invocationId,
		);
		mergeEntries(this.entriesById, page.entries, "child Pi");
		this.lastEntryId = page.entries.at(-1)?.id;
		this.leafId = page.leafId;
		this.complete = true;
		this.branch = this.resolveBranch();
	}

	/** Publishes the retained saved root after initial viewport filling finishes. */
	private completeInactivePreview(): boolean {
		const entries = this.inactiveBranch;
		if (this.complete || entries === undefined) {
			return false;
		}
		this.inactiveStartIndex = 0;
		this.complete = true;
		this.branch = entries;
		return true;
	}

	/** Reloads the final saved branch after the active writer has stopped. */
	private async reloadTerminal(session: LogicalSession): Promise<boolean> {
		const entries = await Promise.resolve(this.readInactiveBranch(session));
		return this.replaceTerminalBranch(entries);
	}

	/** Retains a complete saved branch while exposing only its latest user turn. */
	private openInactiveBranch(entries: readonly SessionEntry[]): void {
		this.replaceCompleteBranch(entries);
		this.inactiveBranch = this.branch;
		this.inactiveStartIndex = findPreviousTurnStart(entries, entries.length);
		this.complete = this.inactiveStartIndex === 0;
		this.branch = Object.freeze(entries.slice(this.inactiveStartIndex));
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
		mergeEntries(this.entriesById, entries, "saved Pi session");
		this.leafId = entries.at(-1)?.id ?? null;
		this.lastEntryId = entries.at(-1)?.id ?? this.lastEntryId;
		this.inactiveBranch = undefined;
		this.inactiveStartIndex = 0;
		this.complete = true;
		this.branch = Object.freeze([...entries]);
	}

	/** Resolves a complete active root-to-leaf branch from append-order RPC data. */
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
				throw new Error("child Pi returned an unknown conversation leaf");
			}
			branch.unshift(entry);
			currentId = entry.parentId;
		}
		return Object.freeze(branch);
	}

	/** Serializes state changes while preserving each caller's result. */
	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operation.then(operation);
		this.operation = result.then(
			() => undefined,
			() => undefined,
		);
		return await result;
	}
}

/** Finds the nearest prior user boundary or the branch root. */
function findPreviousTurnStart(
	entries: readonly SessionEntry[],
	beforeIndex: number,
): number {
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry !== undefined && isUserMessageEntry(entry)) {
			return index;
		}
	}
	return 0;
}

/** Detects one user boundary inside a public Pi branch. */
function isUserMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
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

/** Adds one RPC or saved page while rejecting ambiguous duplicate topology. */
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
