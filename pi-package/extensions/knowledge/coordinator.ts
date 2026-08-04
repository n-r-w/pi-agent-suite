import { randomUUID } from "node:crypto";
import type {
	KnowledgeMutationLease,
	KnowledgeScope,
	KnowledgeSnapshots,
} from "../../shared/knowledge-runtime";

/** Reads the current stored knowledge for one resolved scope. */
type KnowledgeSnapshotReader = (
	scope: KnowledgeScope,
) => Promise<KnowledgeSnapshots>;

/** Keeps root-owned authorization data out of the child mutation lease. */
interface ActiveKnowledgeMutationLease extends KnowledgeMutationLease {
	readonly ownerId: string;
	readonly scope: KnowledgeScope;
}

/** One queued mutation whose storage snapshot must be captured before it is granted. */
interface QueuedMutation {
	readonly ownerId: string;
	readonly scope: KnowledgeScope;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (lease: KnowledgeMutationLease) => void;
	readonly reject: (error: Error) => void;
	readonly onAbort: () => void;
	cancelled: boolean;
}

/** Serializes complete knowledge mutations for one root Pi hierarchy. */
export class KnowledgeMutationCoordinator {
	/** Supplies current storage only while no matching mutation snapshot is active. */
	readonly #readSnapshots: KnowledgeSnapshotReader;
	/** Preserves root-hierarchy request order across every project and branch. */
	readonly #queue: QueuedMutation[] = [];
	/** Identifies the only mutation allowed to read sources, call an LLM, and write. */
	#active: ActiveKnowledgeMutationLease | undefined;
	/** Prevents another drain from passing a snapshot read that is still granting the FIFO head. */
	#granting: QueuedMutation | undefined;
	/** Closes mutation admission during root shutdown. */
	#closed = false;

	/** Creates a coordinator around the knowledge owner's current-file reader. */
	public constructor(readSnapshots: KnowledgeSnapshotReader) {
		this.#readSnapshots = readSnapshots;
	}

	/** Grants one FIFO mutation lease after capturing pre-mutation snapshots. */
	public acquire(
		ownerId: string,
		scope: KnowledgeScope,
		signal?: AbortSignal,
	): Promise<KnowledgeMutationLease> {
		if (this.#closed) {
			return Promise.reject(new Error("knowledge coordinator is closed"));
		}
		if (signal?.aborted) {
			return Promise.reject(cancellationError(signal));
		}

		return new Promise<KnowledgeMutationLease>((resolve, reject) => {
			let item: QueuedMutation;
			const onAbort = (): void => {
				item.cancelled = true;
				this.#removeQueued(item);
				reject(cancellationError(signal));
			};
			item = {
				ownerId,
				scope,
				signal,
				resolve,
				reject,
				onAbort,
				cancelled: false,
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#queue.push(item);
			this.#drain();
		});
	}

	/** Reads active snapshots for the matching scope or current storage otherwise. */
	public async read(scope: KnowledgeScope): Promise<KnowledgeSnapshots> {
		if (this.#active !== undefined && scopesEqual(this.#active.scope, scope)) {
			return this.#active.snapshots;
		}
		return this.#readSnapshots(scope);
	}

	/** Releases the active lease owned by the caller and grants the next queue item. */
	public async release(ownerId: string, leaseId: string): Promise<void> {
		if (this.#active === undefined) {
			return;
		}
		if (this.#active.ownerId !== ownerId || this.#active.leaseId !== leaseId) {
			throw new Error("knowledge mutation lease is not owned by caller");
		}
		this.#active = undefined;
		this.#drain();
	}

	/** Removes queued work and releases active work for one unavailable owner. */
	public cancelOwner(ownerId: string): void {
		for (const item of [...this.#queue]) {
			if (item.ownerId === ownerId) {
				this.#cancelQueued(item);
			}
		}
		if (this.#granting?.ownerId === ownerId) {
			this.#granting.cancelled = true;
			this.#granting.reject(new Error("knowledge mutation cancelled"));
		}
		if (this.#active?.ownerId === ownerId) {
			this.#active = undefined;
		}
		this.#drain();
	}

	/** Rejects queued work, releases active state, and closes future admission. */
	public shutdown(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		for (const item of [...this.#queue]) {
			this.#cancelQueued(item, new Error("knowledge coordinator is closed"));
		}
		if (this.#granting !== undefined) {
			this.#granting.cancelled = true;
			this.#granting.reject(new Error("knowledge coordinator is closed"));
		}
		this.#active = undefined;
	}

	/** Captures the FIFO head's snapshot before exposing its lease. */
	#drain(): void {
		if (
			this.#closed ||
			this.#active !== undefined ||
			this.#granting !== undefined
		) {
			return;
		}
		const item = this.#queue.shift();
		if (item === undefined) {
			return;
		}
		this.#granting = item;
		this.#grant(item).catch(() => undefined);
	}

	/** Completes one snapshot read and advances past cancelled or failed grants. */
	async #grant(item: QueuedMutation): Promise<void> {
		try {
			const captured = await this.#readSnapshots(item.scope);
			if (item.cancelled || this.#closed) {
				return;
			}
			const lease: KnowledgeMutationLease = {
				leaseId: randomUUID(),
				snapshots: captured,
			};
			this.#active = {
				...lease,
				ownerId: item.ownerId,
				scope: item.scope,
			};
			item.signal?.removeEventListener("abort", item.onAbort);
			item.resolve(lease);
		} catch (error) {
			if (!item.cancelled) {
				item.reject(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			if (this.#granting === item) {
				this.#granting = undefined;
			}
			this.#drain();
		}
	}

	/** Rejects and detaches one item that has not started snapshot capture. */
	#cancelQueued(
		item: QueuedMutation,
		error = new Error("knowledge mutation cancelled"),
	): void {
		item.cancelled = true;
		this.#removeQueued(item);
		item.signal?.removeEventListener("abort", item.onAbort);
		item.reject(error);
	}

	/** Removes one queued item without changing unrelated FIFO order. */
	#removeQueued(item: QueuedMutation): void {
		const index = this.#queue.indexOf(item);
		if (index >= 0) {
			this.#queue.splice(index, 1);
		}
	}
}

/** Compares the complete scope identity used by active snapshot visibility. */
function scopesEqual(left: KnowledgeScope, right: KnowledgeScope): boolean {
	return (
		left.projectDirectoryName === right.projectDirectoryName &&
		left.branchName === right.branchName
	);
}

/** Preserves an explicit cancellation reason without exposing scope or knowledge data. */
function cancellationError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("knowledge mutation cancelled");
}
