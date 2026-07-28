import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../../../test/support/persisted-session.ts";
import { SubagentCoordinator } from "./coordinator";
import type { LogicalSession } from "./domain";
import type { InvocationControl } from "./invocation-contracts";
import {
	SUBAGENT_HISTORY_CUSTOM_TYPE,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
	V2SessionStore,
} from "./persistence";
import { recoverRuntimeFailure } from "./runtime-failure";
import { SessionCatalog } from "./session-catalog";
import { WaitCoordinator } from "./wait-coordinator";

/** Reads durable terminal and history facts from one public session branch. */
function readRecoveryFacts(manager: SessionManager): {
	readonly state: LogicalSession["state"] | undefined;
	readonly terminalStates: unknown[];
	readonly forcedAbortCount: number;
	readonly historyCount: number;
} {
	const branch = manager.getBranch();
	const terminalRecords = branch.flatMap((entry) => {
		if (
			entry.type !== "custom" ||
			entry.customType !== SUBAGENT_JOURNAL_CUSTOM_TYPE ||
			typeof entry.data !== "object" ||
			entry.data === null ||
			Reflect.get(entry.data, "kind") !== "terminal"
		) {
			return [];
		}
		return [entry.data];
	});
	const store = new V2SessionStore();
	return {
		state: store.fold(branch).sessions[0]?.state,
		terminalStates: terminalRecords.map((record) =>
			Reflect.get(record, "state"),
		),
		forcedAbortCount: terminalRecords.filter(
			(record) =>
				Reflect.get(record, "disposition") === "withheld-forced-abort",
		).length,
		historyCount: branch.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
		).length,
	};
}

test("does not release writers when process teardown rejects", async () => {
	// Purpose: offline persistence cannot begin unless authoritative process teardown completes.
	// Input and expected output: coordinator rejection propagates with zero release and reconciliation calls.
	// Edge case: the runtime failure itself is valid and would otherwise identify one remote lease.
	// Dependencies: production recovery ordering and deterministic boundary fakes.
	// Arrange.
	let releases = 0;
	let reconciliations = 0;
	const coordinator = {
		observeRuntimeFailure: async () => {
			throw new Error("process remained active");
		},
		persistDeferredTerminals: async () => undefined,
		applyReconciledSessions: async () => undefined,
	};
	const store = {
		releaseRemoteLease: () => {
			releases += 1;
			return [];
		},
		reconcileOffline: async () => {
			reconciliations += 1;
			return [];
		},
	};

	// Act.
	let error = "";
	try {
		await recoverRuntimeFailure(
			coordinator,
			store,
			{ runtimeLeaseId: "failed-lease", reason: "channel_disconnected" },
			2,
		);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}

	// Assert.
	expect({ error, releases, reconciliations }).toEqual({
		error: "process remained active",
		releases: 0,
		reconciliations: 0,
	});
});

test("preserves normal-first terminal feedback through offline recovery", async () => {
	// Purpose: a selected normal terminal outcome must survive failed remote durability and later channel fail-stop.
	// Input and expected output: terminal success is selected first, its remote append writes then rejects, process teardown and writer release finish, then offline recovery persists success and one history destination.
	// Edge case: duplicate normal-terminal evidence from delivery uncertainty still yields one destination, and repeated reconciliation adds nothing.
	// Dependencies: production coordinator ordering, runtime-failure recovery, public SessionManager persistence, and remote-writer release.
	// Arrange.
	const directory = mkdtempSync(
		join(tmpdir(), "subagents-v2-normal-recovery-"),
	);
	try {
		const manager = createPersistedSession(directory, {
			id: "nested-owner",
			text: "nested owner seed",
		});
		const ownerSessionFile = manager.getSessionFile();
		if (ownerSessionFile === undefined) {
			throw new Error(
				"nested owner SessionManager did not create a session file",
			);
		}
		const owner = {
			ownerPiSessionId: manager.getSessionId(),
			ownerSessionFile,
		};
		const session: LogicalSession = {
			key: {
				ownerPiSessionId: owner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "nested-child",
			childSessionDir: join(directory, "child"),
			childSessionFile: join(directory, "child", "session.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Preserve normal terminal",
			creationOrder: 1,
			invocationId: "nested-invocation",
			runtimeLeaseId: "nested-child-lease",
			ownerRuntimeLeaseId: "nested-owner-lease",
			invocationMetadata: {
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 1_000,
			},
			state: "active",
		};
		manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session,
		});
		let remoteAppendCount = 0;
		const store = new V2SessionStore({
			append: async (_remoteOwner, record) => {
				remoteAppendCount += 1;
				manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				throw new Error("controlled delivery unknown");
			},
			appendHistory: async () => {
				throw new Error("remote history must not run after writer release");
			},
		});
		store.registerRemote(owner, "nested-owner-lease");
		const catalog = new SessionCatalog();
		catalog.add(session);
		let processClosed = false;
		const terminatedLeases: string[] = [];
		const invocations: InvocationControl = {
			start: async () => {
				throw new Error("start is not used by recovery");
			},
			continue: async () => {
				throw new Error("continue is not used by recovery");
			},
			steer: async () => {
				throw new Error("steer is not used by recovery");
			},
			terminateLease: async (runtimeLeaseId) => {
				terminatedLeases.push(runtimeLeaseId);
				processClosed = true;
			},
		};
		const coordinator = new SubagentCoordinator({
			catalog,
			invocations,
			waits: new WaitCoordinator(),
			store,
			clock: { monotonicNow: () => 1, wallNow: () => 1 },
			isAgentAvailable: () => true,
		});
		coordinator.registerOwner(owner);
		let terminalRejected = false;

		// Act.
		try {
			await coordinator.observeInvocation({
				kind: "terminal",
				invocationId: session.invocationId,
				status: "success",
				text: "normal output",
			});
		} catch {
			terminalRejected = true;
		}
		const afterTerminal = catalog.get(owner, 1)?.state;
		let releasedAfterProcessClose = false;
		let reconciledAfterRelease = false;
		let writerReleased = false;
		await recoverRuntimeFailure(
			coordinator,
			{
				releaseRemoteLease: (runtimeLeaseId) => {
					releasedAfterProcessClose = processClosed;
					const released = store.releaseRemoteLease(runtimeLeaseId);
					writerReleased ||= released.length === 1;
					return released;
				},
				reconcileOffline: async (releasedOwner, maxDepth) => {
					reconciledAfterRelease = writerReleased;
					return store.reconcileOffline(releasedOwner, maxDepth);
				},
			},
			{
				runtimeLeaseId: "nested-owner-lease",
				reason: "channel_disconnected",
			},
			2,
		);
		const reopened = SessionManager.open(
			ownerSessionFile,
			directory,
			directory,
		);
		const firstRecovery = readRecoveryFacts(reopened);
		await store.reconcileOffline(owner, 2);
		const repeatedRecovery = readRecoveryFacts(
			SessionManager.open(ownerSessionFile, directory, directory),
		);

		// Assert.
		expect({
			terminalRejected,
			afterTerminal,
			afterRecovery: catalog.get(owner, 1)?.state,
			terminatedLeases,
			releasedAfterProcessClose,
			reconciledAfterRelease,
			remoteAppendCount,
			firstRecovery,
			repeatedRecovery,
		}).toEqual({
			terminalRejected: true,
			afterTerminal: "terminal-success",
			afterRecovery: "terminal-success",
			terminatedLeases: ["nested-owner-lease"],
			releasedAfterProcessClose: true,
			reconciledAfterRelease: true,
			remoteAppendCount: 1,
			firstRecovery: {
				state: "terminal-success",
				terminalStates: ["terminal-success", "terminal-success"],
				forcedAbortCount: 0,
				historyCount: 1,
			},
			repeatedRecovery: {
				state: "terminal-success",
				terminalStates: ["terminal-success", "terminal-success"],
				forcedAbortCount: 0,
				historyCount: 1,
			},
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
