import type { LogicalSession, OwnerIdentity } from "./domain";
import type { RuntimeChannelFailure } from "./runtime-bridge";

/** Exposes coordinator operations shared by both closure recovery paths. */
interface ClosureRecoveryCoordinator {
	persistDeferredTerminals(owner: OwnerIdentity): Promise<void>;
	applyReconciledSessions(sessions: readonly LogicalSession[]): Promise<void>;
}

/** Exposes the coordinator runtime-failure boundary needed by recovery ordering. */
interface RuntimeFailureCoordinator extends ClosureRecoveryCoordinator {
	observeRuntimeFailure(
		failure: RuntimeChannelFailure,
	): Promise<readonly string[]>;
}

/** Exposes the coordinator graceful-shutdown boundary needed by recovery ordering. */
interface OwnerShutdownCoordinator extends ClosureRecoveryCoordinator {
	shutdown(owner: OwnerIdentity): Promise<readonly string[]>;
}

/** Exposes writer release and offline reconciliation after process cessation. */
interface RuntimeFailureStore {
	releaseRemoteLease(runtimeLeaseId: string): readonly OwnerIdentity[];
	reconcileOffline(owner: OwnerIdentity): Promise<readonly LogicalSession[]>;
}

/** Stops one failed lease closure before releasing and reconciling its remote writers. */
export async function recoverRuntimeFailure(
	coordinator: RuntimeFailureCoordinator,
	store: RuntimeFailureStore,
	failure: RuntimeChannelFailure,
): Promise<void> {
	const affectedLeaseIds = await coordinator.observeRuntimeFailure(failure);
	await releaseAndReconcileClosure({
		coordinator,
		store,
		affectedLeaseIds,
		mandatoryOwners: [],
	});
}

/** Completes top-level root descendant recovery before active-writer disposal. */
export async function recoverRootShutdown({
	coordinator,
	store,
	owner,
}: {
	readonly coordinator: OwnerShutdownCoordinator;
	readonly store: RuntimeFailureStore;
	readonly owner: OwnerIdentity;
}): Promise<void> {
	const affectedLeaseIds = await coordinator.shutdown(owner);
	await releaseAndReconcileClosure({
		coordinator,
		store,
		affectedLeaseIds,
		mandatoryOwners: [],
	});
}

/** Completes graceful descendant and stopping-owner recovery before acknowledgment. */
export async function recoverOwnerShutdown({
	coordinator,
	store,
	owner,
	stoppingRuntimeLeaseId,
}: {
	readonly coordinator: OwnerShutdownCoordinator;
	readonly store: RuntimeFailureStore;
	readonly owner: OwnerIdentity;
	readonly stoppingRuntimeLeaseId: string;
}): Promise<void> {
	const descendantLeaseIds = await coordinator.shutdown(owner);
	await releaseAndReconcileClosure({
		coordinator,
		store,
		affectedLeaseIds: [
			...new Set([...descendantLeaseIds, stoppingRuntimeLeaseId]),
		],
		mandatoryOwners: [owner],
	});
}

/** Releases every selected writer before any owner enters offline reconciliation. */
async function releaseAndReconcileClosure({
	coordinator,
	store,
	affectedLeaseIds,
	mandatoryOwners,
}: {
	readonly coordinator: ClosureRecoveryCoordinator;
	readonly store: RuntimeFailureStore;
	readonly affectedLeaseIds: readonly string[];
	readonly mandatoryOwners: readonly OwnerIdentity[];
}): Promise<void> {
	// Mandatory owners remain recoverable even when their writer registration is already absent.
	const releasedOwners = new Map(
		mandatoryOwners.map((owner) => [owner.ownerPiSessionId, owner]),
	);
	for (const runtimeLeaseId of affectedLeaseIds) {
		for (const owner of store.releaseRemoteLease(runtimeLeaseId)) {
			// One owner identity reconciles once even if repeated lease facts select it.
			releasedOwners.set(owner.ownerPiSessionId, owner);
		}
	}
	await Promise.all(
		[...releasedOwners.values()].map(async (owner) => {
			// Complete closure release makes the public offline session the sole durable writer.
			await coordinator.persistDeferredTerminals(owner);
			const sessions = await store.reconcileOffline(owner);
			await coordinator.applyReconciledSessions(sessions);
		}),
	);
}
