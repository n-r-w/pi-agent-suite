import {
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { LogicalSession } from "../domain";
import {
	HierarchyConversationProjection,
	type ManagementProjectionView,
	projectionStableKey,
} from "../projection";
import type { ManagementViewSource } from "./screen";

/** Supplies accepted catalog facts without exposing mutation operations. */
interface ManagementCatalogSource {
	listAll(): readonly LogicalSession[];
	subscribe(listener: (session: LogicalSession) => void): () => void;
}

/** Supplies active Pi entry pages and child activity through public RPC. */
interface ManagementActiveConversationSource {
	readActiveEntries(
		invocationId: string,
		since?: string,
	): Promise<{
		readonly entries: readonly SessionEntry[];
		readonly leafId: string | null;
	}>;
	subscribeActivity(listener: (invocationId: string) => void): () => void;
}

/** Holds only the selected active session's append-order entries and derived branch. */
interface ActiveConversationCache {
	readonly invocationId: string;
	readonly entriesById: Map<string, SessionEntry>;
	lastEntryId: string | undefined;
	leafId: string | null;
	branch: readonly SessionEntry[];
	version: number;
}

/** Couples one branch with a payload-independent revision used by immutable projection. */
interface ConversationRead {
	readonly entries: readonly SessionEntry[];
	readonly version: number;
}

/** Supplies deterministic runtime dependencies around the immutable projection. */
interface ManagementProjectionRuntimeOptions {
	readonly rootOwnerPiSessionId: string;
	readonly catalog: ManagementCatalogSource;
	readonly activeConversations: ManagementActiveConversationSource;
	readonly readInactiveBranch?: (
		session: LogicalSession,
	) => Promise<readonly SessionEntry[]> | readonly SessionEntry[];
	readonly onError: (error: Error) => void;
}

/** Connects durable/live read sources to disposable management subscriptions. */
export class ManagementProjectionRuntime implements ManagementViewSource {
	private readonly projection: HierarchyConversationProjection;
	private readonly subscribers = new Set<
		(view: ManagementProjectionView) => void
	>();
	private readonly unsubscribeCatalog: () => void;
	private readonly unsubscribeActivity: () => void;
	private refreshRequested = false;
	private refreshPromise: Promise<void> | undefined;
	private activeConversation: ActiveConversationCache | undefined;
	private conversationVersion = 0;
	private selectionGeneration = 0;
	private disposed = false;

	public constructor(
		private readonly options: ManagementProjectionRuntimeOptions,
	) {
		this.projection = new HierarchyConversationProjection(
			options.rootOwnerPiSessionId,
		);
		this.projection.replace({
			journals: [],
			catalogSessions: options.catalog.listAll(),
			conversations: [],
		});
		this.unsubscribeCatalog = options.catalog.subscribe((session) =>
			this.updateSession(session),
		);
		this.unsubscribeActivity = options.activeConversations.subscribeActivity(
			(invocationId) => this.handleActivity(invocationId),
		);
	}

	/** Returns the latest immutable management revision. */
	public getView(): ManagementProjectionView {
		return this.projection.getView();
	}

	/** Selects by internal identity and loads only that logical session's active branch. */
	public async select(stableKey: string | null): Promise<void> {
		if (this.disposed) {
			return;
		}
		const node = this.projection
			.getView()
			.nodes.find((candidate) => candidate.stableKey === stableKey);
		const before = this.projection.getView();
		const next = this.projection.select(node?.key ?? null);
		if (before.selectedStableKey !== next.selectedStableKey) {
			this.activeConversation = undefined;
		}
		this.selectionGeneration += 1;
		this.publishRevision(before, next);
		await this.refreshSelected();
	}

	/** Coalesces live updates into one selected-branch read at a time. */
	public refreshSelected(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.refreshRequested = true;
		const activeRefresh = this.refreshPromise;
		if (activeRefresh === undefined) {
			return this.startRefresh();
		}
		// A request arriving as the active promise settles must start a new drain
		// after its cleanup instead of being stranded on an already-resolved promise.
		return activeRefresh.then(() =>
			this.refreshRequested ? this.startRefresh() : undefined,
		);
	}

	/** Subscribes one overlay instance to visible immutable revisions. */
	public subscribe(
		listener: (view: ManagementProjectionView) => void,
	): () => void {
		if (this.disposed) {
			return () => undefined;
		}
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	/** Releases root-runtime readers and prevents stale async publication. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.selectionGeneration += 1;
		this.unsubscribeCatalog();
		this.unsubscribeActivity();
		this.activeConversation = undefined;
		this.projection.select(null);
		this.subscribers.clear();
	}

	/** Applies one durability-approved catalog fact to the projection. */
	private updateSession(session: LogicalSession): void {
		if (this.disposed) {
			return;
		}
		const before = this.projection.getView();
		const stableKey = projectionStableKey(session.key);
		const previousState = before.nodes.find(
			(node) => node.stableKey === stableKey,
		)?.state;
		const next = this.projection.updateSession(session);
		this.publishRevision(before, next);
		// Metadata remains node-only; state transitions can change the conversation reader.
		if (
			next.selectedStableKey === stableKey &&
			previousState !== session.state
		) {
			this.requestRefreshAfterEvent();
		}
	}

	/** Refreshes only when activity belongs to the current selected invocation. */
	private handleActivity(invocationId: string): void {
		if (this.disposed) {
			return;
		}
		const selected = this.selectedSession();
		if (selected?.invocationId === invocationId) {
			this.requestRefreshAfterEvent();
		}
	}

	/** Starts an event-driven refresh while reporting, rather than hiding, failure. */
	private requestRefreshAfterEvent(): void {
		this.refreshSelected().catch((error: unknown) =>
			this.options.onError(toError(error)),
		);
	}

	/** Starts one tracked drain and releases ownership only for that exact promise. */
	private startRefresh(): Promise<void> {
		const refresh = this.runRefreshLoop();
		this.refreshPromise = refresh;
		return refresh.finally(() => {
			if (this.refreshPromise === refresh) {
				this.refreshPromise = undefined;
			}
		});
	}

	/** Drains refresh requests serially so bursty stream events cannot overlap reads. */
	private async runRefreshLoop(): Promise<void> {
		if (this.disposed || !this.refreshRequested) {
			return;
		}
		this.refreshRequested = false;
		const generation = this.selectionGeneration;
		const session = this.selectedSession();
		if (session === undefined) {
			return this.runRefreshLoop();
		}
		const conversation = await this.readConversation(session);
		if (
			!this.disposed &&
			generation === this.selectionGeneration &&
			projectionStableKey(session.key) ===
				this.projection.getView().selectedStableKey
		) {
			const before = this.projection.getView();
			const next = this.projection.updateConversation(
				session.key,
				conversation.entries,
				conversation.version,
			);
			this.publishRevision(before, next);
		}
		return this.runRefreshLoop();
	}

	/** Uses incremental RPC for the selected active writer and SessionManager after termination. */
	private async readConversation(
		session: LogicalSession,
	): Promise<ConversationRead> {
		if (session.state === "active") {
			return await this.readActiveConversation(session.invocationId);
		}
		this.activeConversation = undefined;
		const entries = await Promise.resolve(
			this.options.readInactiveBranch?.(session) ??
				SessionManager.open(
					session.childSessionFile,
					session.childSessionDir,
				).getBranch(),
		);
		return { entries, version: this.nextConversationVersion() };
	}

	/** Merges one get_entries delta and derives the selected root-to-leaf branch. */
	private async readActiveConversation(
		invocationId: string,
	): Promise<ConversationRead> {
		const cache =
			this.activeConversation ?? createActiveConversationCache(invocationId);
		if (cache.invocationId !== invocationId) {
			throw new Error(
				"selected active conversation identity changed unexpectedly",
			);
		}
		this.activeConversation = cache;
		const page = await this.options.activeConversations.readActiveEntries(
			invocationId,
			cache.lastEntryId,
		);
		const leafChanged = cache.leafId !== page.leafId;
		for (const entry of page.entries) {
			if (cache.entriesById.has(entry.id)) {
				throw new Error("child Pi returned duplicate conversation entry ids");
			}
			cache.entriesById.set(entry.id, entry);
		}
		cache.lastEntryId = page.entries.at(-1)?.id ?? cache.lastEntryId;
		cache.leafId = page.leafId;
		if (page.entries.length > 0 || leafChanged) {
			cache.branch = activeBranchFromCache(cache);
			cache.version = this.nextConversationVersion();
		}
		return { entries: cache.branch, version: cache.version };
	}

	/** Allocates one small revision without serializing complete conversation payloads. */
	private nextConversationVersion(): number {
		this.conversationVersion += 1;
		return this.conversationVersion;
	}

	/** Resolves the selected stable key back to the authoritative catalog fact. */
	private selectedSession(): LogicalSession | undefined {
		const selectedStableKey = this.projection.getView().selectedStableKey;
		if (selectedStableKey === null) {
			return undefined;
		}
		return this.options.catalog
			.listAll()
			.find(
				(session) => projectionStableKey(session.key) === selectedStableKey,
			);
	}

	/** Publishes only visible projection revision changes. */
	private publishRevision(
		before: ManagementProjectionView,
		next: ManagementProjectionView,
	): void {
		if (this.disposed || before.revision === next.revision) {
			return;
		}
		for (const subscriber of this.subscribers) {
			subscriber(next);
		}
	}
}

/** Creates the only in-memory entry cache owned by the current management selection. */
function createActiveConversationCache(
	invocationId: string,
): ActiveConversationCache {
	return {
		invocationId,
		entriesById: new Map(),
		lastEntryId: undefined,
		leafId: null,
		branch: Object.freeze([]),
		version: 0,
	};
}

/** Resolves one cached active leaf while rejecting incomplete or cyclic RPC topology. */
function activeBranchFromCache(
	cache: ActiveConversationCache,
): readonly SessionEntry[] {
	if (cache.leafId === null) {
		return Object.freeze([]);
	}
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let currentId: string | null = cache.leafId;
	while (currentId !== null) {
		if (visited.has(currentId)) {
			throw new Error("child Pi returned a cyclic conversation branch");
		}
		visited.add(currentId);
		const entry = cache.entriesById.get(currentId);
		if (entry === undefined) {
			throw new Error("child Pi returned an unknown conversation leaf");
		}
		branch.unshift(entry);
		currentId = entry.parentId;
	}
	return Object.freeze(branch);
}

/** Preserves Error identity for safe runtime reporting. */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
