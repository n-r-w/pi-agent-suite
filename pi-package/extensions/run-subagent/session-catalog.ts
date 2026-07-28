import {
	type LogicalSession,
	type OwnerIdentity,
	type SessionKey,
	sessionMapKey as stableKey,
} from "./domain";

/** Exposes read-only session resolution to coordination consumers. */
export interface SessionCatalogQuery {
	get(
		owner: OwnerIdentity,
		ownerLocalSessionId: number,
	): LogicalSession | undefined;
	findByLocalId(ownerLocalSessionId: number): readonly LogicalSession[];
	list(owner: OwnerIdentity): readonly LogicalSession[];
}

/** Adds coordinator-only mutation operations to the read-only catalog contract. */
export interface SessionCatalogState extends SessionCatalogQuery {
	add(session: LogicalSession): void;
	replace(session: LogicalSession): void;
	update(
		key: SessionKey,
		update: Partial<
			Pick<
				LogicalSession,
				| "invocationId"
				| "runtimeLeaseId"
				| "ownerRuntimeLeaseId"
				| "invocationMetadata"
				| "state"
			>
		>,
	): void;
}

/** Owns the live derived logical-session catalog. */
export class SessionCatalog implements SessionCatalogState {
	private readonly sessions = new Map<string, LogicalSession>();
	private readonly listeners = new Set<(session: LogicalSession) => void>();

	/** Adds one accepted logical session exactly once. */
	public add(session: LogicalSession): void {
		const key = stableKey(session.key);
		if (this.sessions.has(key)) {
			throw new Error(`logical session ${key} already exists`);
		}
		this.sessions.set(key, session);
		this.publish(session);
	}

	/** Replaces one reconstructed logical session by its complete stable key. */
	public replace(session: LogicalSession): void {
		const key = stableKey(session.key);
		if (!this.sessions.has(key)) {
			throw new Error(`logical session ${key} is unknown`);
		}
		this.sessions.set(key, session);
		this.publish(session);
	}

	/** Resolves one direct-owned logical session. */
	public get(
		owner: OwnerIdentity,
		ownerLocalSessionId: number,
	): LogicalSession | undefined {
		return this.sessions.get(
			stableKey({
				ownerPiSessionId: owner.ownerPiSessionId,
				ownerLocalSessionId,
			}),
		);
	}

	/** Finds sessions that share one owner-local numeric ID. */
	public findByLocalId(ownerLocalSessionId: number): readonly LogicalSession[] {
		return [...this.sessions.values()].filter(
			(session) => session.key.ownerLocalSessionId === ownerLocalSessionId,
		);
	}

	/** Lists one owner's logical sessions in creation order. */
	public list(owner: OwnerIdentity): readonly LogicalSession[] {
		return [...this.sessions.values()]
			.filter(
				(session) => session.key.ownerPiSessionId === owner.ownerPiSessionId,
			)
			.sort((left, right) => left.creationOrder - right.creationOrder);
	}

	/** Lists every logical session in deterministic owner and creation order. */
	public listAll(): readonly LogicalSession[] {
		return [...this.sessions.values()].sort((left, right) => {
			const ownerOrder = left.key.ownerPiSessionId.localeCompare(
				right.key.ownerPiSessionId,
			);
			return ownerOrder === 0
				? left.creationOrder - right.creationOrder
				: ownerOrder;
		});
	}

	/** Subscribes one read-only projection listener to accepted catalog changes. */
	public subscribe(listener: (session: LogicalSession) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Replaces the current invocation facts for one stable session key. */
	public update(
		key: SessionKey,
		update: Partial<
			Pick<
				LogicalSession,
				| "invocationId"
				| "runtimeLeaseId"
				| "ownerRuntimeLeaseId"
				| "invocationMetadata"
				| "state"
			>
		>,
	): void {
		const encodedKey = stableKey(key);
		const current = this.sessions.get(encodedKey);
		if (current === undefined) {
			throw new Error(`logical session ${encodedKey} is unknown`);
		}
		const next = { ...current, ...update };
		this.sessions.set(encodedKey, next);
		this.publish(next);
	}

	/** Publishes immutable session facts without granting mutation authority. */
	private publish(session: LogicalSession): void {
		for (const listener of this.listeners) {
			listener(session);
		}
	}
}
