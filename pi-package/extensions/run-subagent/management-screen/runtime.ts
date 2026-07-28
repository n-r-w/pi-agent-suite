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

/** Supplies active Pi branches and child activity through public RPC. */
interface ManagementActiveConversationSource {
	readActiveBranch(invocationId: string): Promise<readonly SessionEntry[]>;
	subscribeActivity(listener: (invocationId: string) => void): () => void;
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
		const entries = await this.readConversation(session);
		if (
			!this.disposed &&
			generation === this.selectionGeneration &&
			projectionStableKey(session.key) ===
				this.projection.getView().selectedStableKey
		) {
			const before = this.projection.getView();
			const next = this.projection.updateConversation(session.key, entries);
			this.publishRevision(before, next);
		}
		return this.runRefreshLoop();
	}

	/** Uses RPC for active writers and public SessionManager for inactive sessions. */
	private readConversation(
		session: LogicalSession,
	): Promise<readonly SessionEntry[]> {
		if (session.state === "active") {
			return this.options.activeConversations.readActiveBranch(
				session.invocationId,
			);
		}
		return Promise.resolve(
			this.options.readInactiveBranch?.(session) ??
				SessionManager.open(
					session.childSessionFile,
					session.childSessionDir,
				).getBranch(),
		);
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

/** Preserves Error identity for safe runtime reporting. */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
