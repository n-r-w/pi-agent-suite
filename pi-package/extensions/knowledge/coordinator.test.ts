import { describe, expect, test } from "bun:test";
import type {
	KnowledgeScope,
	KnowledgeSnapshots,
} from "../../shared/knowledge-runtime";
import { KnowledgeMutationCoordinator } from "./coordinator";

const FEATURE_SCOPE: KnowledgeScope = {
	projectDirectoryName: "project-a-digest",
	branchName: "feature/a",
};
const OTHER_SCOPE: KnowledgeScope = {
	projectDirectoryName: "project-b-digest",
	branchName: "feature/b",
};

/** Creates snapshots whose values expose the storage revision used by a grant or read. */
function snapshots(revision: string): KnowledgeSnapshots {
	return {
		global: `global-${revision}`,
		local: `local-${revision}`,
	};
}

describe("knowledge mutation coordinator", () => {
	/**
	 * Proves one FIFO serializes all root-hierarchy mutations and preserves active-scope snapshots.
	 * Inputs and expected outputs: two same-scope owners and one different-scope owner receive grants in request order.
	 * Edge cases: same-scope active reads use the pre-grant snapshot while different-scope and idle reads use current storage.
	 * Dependencies: an injected storage reader records exact scope reads without real files.
	 */
	test("serializes hierarchy mutations and serves active last-completed snapshots", async () => {
		// Arrange: storage revisions change independently from the coordinator's active snapshot.
		let revision = "before";
		const storageReads: KnowledgeScope[] = [];
		const coordinator = new KnowledgeMutationCoordinator(async (scope) => {
			storageReads.push(scope);
			return snapshots(revision);
		});

		// Act: the first lease becomes active while later root-hierarchy requests remain queued.
		const first = await coordinator.acquire("root", FEATURE_SCOPE);
		const secondPromise = coordinator.acquire("child-1", FEATURE_SCOPE);
		const thirdPromise = coordinator.acquire("child-2", OTHER_SCOPE);
		revision = "external";
		const sameScopeRead = await coordinator.read(FEATURE_SCOPE);
		const otherScopeRead = await coordinator.read(OTHER_SCOPE);
		await coordinator.release("root", first.leaseId);
		const second = await secondPromise;
		await coordinator.release("child-1", second.leaseId);
		const third = await thirdPromise;
		await coordinator.release("child-2", third.leaseId);
		const idleRead = await coordinator.read(FEATURE_SCOPE);

		// Assert: snapshots are captured immediately before each FIFO grant and never cached while idle.
		expect(first.snapshots).toEqual(snapshots("before"));
		expect(sameScopeRead).toEqual(snapshots("before"));
		expect(otherScopeRead).toEqual(snapshots("external"));
		expect(second.snapshots).toEqual(snapshots("external"));
		expect(third.snapshots).toEqual(snapshots("external"));
		expect(idleRead).toEqual(snapshots("external"));
		expect(storageReads).toEqual([
			FEATURE_SCOPE,
			OTHER_SCOPE,
			FEATURE_SCOPE,
			OTHER_SCOPE,
			FEATURE_SCOPE,
		]);
	});

	/**
	 * Proves cancellation and owner failure cannot strand queued or active work.
	 * Inputs and expected outputs: an aborted queued request rejects, owner cleanup releases an active lease, and the next owner is granted.
	 * Edge case: cleanup is idempotent after the aborted request has already left the queue.
	 * Dependencies: AbortController supplies deterministic cancellation without timers.
	 */
	test("removes cancelled work and releases an active failed owner", async () => {
		// Arrange: one active owner blocks an abortable request and one later survivor.
		const coordinator = new KnowledgeMutationCoordinator(async () =>
			snapshots("one"),
		);
		const active = await coordinator.acquire("child-active", FEATURE_SCOPE);
		const abortController = new AbortController();
		const cancelled = coordinator.acquire(
			"child-cancelled",
			FEATURE_SCOPE,
			abortController.signal,
		);
		const survivor = coordinator.acquire("child-survivor", FEATURE_SCOPE);

		// Act: cancel queued work, then report the active owner unavailable.
		abortController.abort(new Error("cancelled by caller"));
		await expect(cancelled).rejects.toThrow("cancelled by caller");
		coordinator.cancelOwner("child-cancelled");
		coordinator.cancelOwner("child-active");
		const granted = await survivor;

		// Assert: the cancelled entry never receives the released FIFO slot.
		expect(granted.snapshots).toEqual(snapshots("one"));
		expect(granted.leaseId).not.toBe(active.leaseId);
		await coordinator.release("child-survivor", granted.leaseId);
	});

	/**
	 * Proves root shutdown rejects queued work, releases active state, and closes future admission.
	 * Inputs and expected outputs: active and queued leases are removed and later acquisition fails with one safe message.
	 * Edge case: release after shutdown is harmless because the coordinator already owns cleanup.
	 * Dependencies: no process or filesystem state is required.
	 */
	test("closes admission and releases all work on root shutdown", async () => {
		// Arrange: one active mutation and one queued descendant mutation exist.
		const coordinator = new KnowledgeMutationCoordinator(async () =>
			snapshots("one"),
		);
		const active = await coordinator.acquire("root", FEATURE_SCOPE);
		const queued = coordinator.acquire("child", FEATURE_SCOPE);

		// Act: root shutdown closes the complete queue.
		coordinator.shutdown();

		// Assert: pending and future work fail without exposing scope content.
		await expect(queued).rejects.toThrow("knowledge coordinator is closed");
		await expect(coordinator.acquire("later", FEATURE_SCOPE)).rejects.toThrow(
			"knowledge coordinator is closed",
		);
		await coordinator.release("root", active.leaseId);
		expect(await coordinator.read(FEATURE_SCOPE)).toEqual(snapshots("one"));
	});
});
