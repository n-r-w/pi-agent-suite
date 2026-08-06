import type { LogicalSession } from "../domain";
import {
	HierarchyConversationProjection,
	type ManagementProjectionView,
	projectionStableKey,
} from "../projection";
import type { ManagementViewSource } from "./screen";
import type {
	InactiveConversationReader,
	SelectedConversationActiveSource,
} from "./selected-conversation";
import { SelectedConversationLoader } from "./selected-conversation";

/** Supplies accepted catalog facts without exposing mutation operations. */
interface ManagementCatalogSource {
	listAll(): readonly LogicalSession[];
	subscribe(listener: (session: LogicalSession) => void): () => void;
}

/** Adds activity notification ownership to selected-session active reads. */
interface ManagementActiveConversationSource
	extends SelectedConversationActiveSource {
	subscribeActivity(listener: (invocationId: string) => void): () => void;
}

/** Supplies deterministic runtime dependencies around the immutable projection. */
interface ManagementProjectionRuntimeOptions {
	readonly rootOwnerPiSessionId: string;
	readonly catalog: ManagementCatalogSource;
	readonly activeConversations: ManagementActiveConversationSource;
	readonly readInactiveBranch: InactiveConversationReader;
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
	/** Retains event activity until the asynchronously opened loader owns selection. */
	private openingRefreshRequested = false;
	private refreshPromise: Promise<void> | undefined;
	private selectedConversation: SelectedConversationLoader | undefined;
	private selectionController: AbortController | undefined;
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

	/** Selects by internal identity and publishes one recent turn before full hydration. */
	public async select(stableKey: string | null): Promise<void> {
		if (this.disposed) {
			return;
		}
		const node = this.projection
			.getView()
			.nodes.find((candidate) => candidate.stableKey === stableKey);
		const before = this.projection.getView();
		const next = this.projection.select(node?.key ?? null);
		if (before.selectedStableKey === next.selectedStableKey) {
			return;
		}

		const generation = this.selectionGeneration + 1;
		this.selectionGeneration = generation;
		// A different selection cannot inherit activity queued for the prior identity.
		this.refreshRequested = false;
		this.openingRefreshRequested = false;
		await this.releaseSelectedConversation();
		if (this.disposed || generation !== this.selectionGeneration) {
			return;
		}
		this.publishRevision(before, next);
		const session = this.selectedSession();
		if (session === undefined) {
			return;
		}

		const controller = new AbortController();
		this.selectionController = controller;
		let loader: SelectedConversationLoader | undefined;
		try {
			loader = await SelectedConversationLoader.open({
				session,
				controller,
				activeConversations: this.options.activeConversations,
				readInactiveBranch: this.options.readInactiveBranch,
			});
			if (!this.ownsOpeningSelection(session, generation)) {
				await loader.dispose();
				return;
			}
			this.selectedConversation = loader;
			this.publishConversation(session, loader);
			// Activity can arrive after the opening snapshot is captured but before
			// this loader takes ownership, so drain its retained incremental refresh.
			if (this.openingRefreshRequested) {
				this.openingRefreshRequested = false;
				this.requestRefreshAfterEvent();
			}
		} catch (error) {
			if (
				controller.signal.aborted ||
				generation !== this.selectionGeneration
			) {
				await loader?.dispose();
				return;
			}
			throw error;
		}
	}

	/** Loads one preceding user turn for viewport-driven preview expansion. */
	public async loadEarlierSelected(): Promise<boolean> {
		const loader = this.selectedConversation;
		const generation = this.selectionGeneration;
		const session = this.selectedSession();
		if (this.disposed || loader === undefined || session === undefined) {
			return true;
		}
		const before = loader.getSnapshot();
		let complete: boolean;
		try {
			complete = await loader.loadEarlier();
		} catch (error) {
			if (!this.ownsSelection(loader, session, generation)) {
				return true;
			}
			throw error;
		}
		const after = loader.getSnapshot();
		if (
			this.ownsSelection(loader, session, generation) &&
			(before.entries !== after.entries || before.complete !== after.complete)
		) {
			this.publishConversation(session, loader);
		}
		return this.selectedConversation !== loader || complete;
	}

	/** Coalesces background hydration and live updates into one selected read at a time. */
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
		this.refreshRequested = false;
		this.openingRefreshRequested = false;
		this.selectionController?.abort(
			new Error("management conversation selection was disposed"),
		);
		this.selectionController = undefined;
		const selected = this.selectedConversation;
		this.selectedConversation = undefined;
		if (selected !== undefined) {
			selected
				.dispose()
				.catch((error: unknown) => this.options.onError(toError(error)));
		}
		this.unsubscribeCatalog();
		this.unsubscribeActivity();
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

	/** Starts an event refresh or retains it until the selected loader is ready. */
	private requestRefreshAfterEvent(): void {
		if (this.selectedConversation === undefined) {
			this.openingRefreshRequested = true;
			return;
		}
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
		const loader = this.selectedConversation;
		if (session === undefined || loader === undefined) {
			return;
		}
		let changed: boolean;
		try {
			changed = await loader.refresh(session);
		} catch (error) {
			if (!this.ownsSelection(loader, session, generation)) {
				return this.runRefreshLoop();
			}
			throw error;
		}
		if (changed && this.ownsSelection(loader, session, generation)) {
			this.publishConversation(session, loader);
		}
		return this.runRefreshLoop();
	}

	/** Checks identity while a newly opened loader has not yet been installed. */
	private ownsOpeningSelection(
		session: LogicalSession,
		generation: number,
	): boolean {
		return (
			!this.disposed &&
			generation === this.selectionGeneration &&
			projectionStableKey(session.key) ===
				this.projection.getView().selectedStableKey
		);
	}

	/** Checks generation, stable identity, and loader ownership before publication. */
	private ownsSelection(
		loader: SelectedConversationLoader,
		session: LogicalSession,
		generation: number,
	): boolean {
		return (
			this.ownsOpeningSelection(session, generation) &&
			this.selectedConversation === loader &&
			loader.stableKey === projectionStableKey(session.key)
		);
	}

	/** Publishes one selected suffix or complete branch with a payload-free revision. */
	private publishConversation(
		session: LogicalSession,
		loader: SelectedConversationLoader,
	): void {
		const snapshot = loader.getSnapshot();
		const before = this.projection.getView();
		const next = this.projection.updateConversation({
			sessionKey: session.key,
			entries: snapshot.entries,
			version: this.nextConversationVersion(),
			complete: snapshot.complete,
			liveStatus: snapshot.liveStatus,
			projectionSavedTokens: snapshot.projectionSavedTokens,
			notification: snapshot.notification,
		});
		this.publishRevision(before, next);
	}

	/** Releases the prior selected loader before a new identity takes ownership. */
	private async releaseSelectedConversation(): Promise<void> {
		this.selectionController?.abort(
			new Error("management conversation selection changed"),
		);
		this.selectionController = undefined;
		const selected = this.selectedConversation;
		this.selectedConversation = undefined;
		await selected?.dispose();
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

/** Preserves Error identity for safe runtime reporting. */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
