import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "../../pi-package/extensions/run-subagent/coordinator";
import type {
	LogicalSession,
	OwnerIdentity,
} from "../../pi-package/extensions/run-subagent/domain";
import { InvocationSupervisor } from "../../pi-package/extensions/run-subagent/invocation-supervisor";
import { parseJournalRecord } from "../../pi-package/extensions/run-subagent/journal-codec";
import {
	SessionStore,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
} from "../../pi-package/extensions/run-subagent/persistence";
import {
	RootRuntimeBridge,
	type RuntimeChannelFailure,
} from "../../pi-package/extensions/run-subagent/runtime-bridge";
import { recoverRuntimeFailure } from "../../pi-package/extensions/run-subagent/runtime-failure";
import { SessionCatalog } from "../../pi-package/extensions/run-subagent/session-catalog";
import { WaitCoordinator } from "../../pi-package/extensions/run-subagent/wait-coordinator";

/** Supplies durable metadata for direct supervisor launch fixtures without model resolution. */
const INVOCATION_METADATA = {
	startedAtMs: 1_700_000_000_000,
	elapsedMs: 1_000,
} as const;

test("establishes production worker IPC and settles one response", async () => {
	// Purpose: production fail-stop must survive failed nested persistence and reconcile after writer release.
	// Input and expected output: two package-loaded workers, one nested catalog session, one pending wait, and one failed remote append still produce complete teardown and durable forced abort.
	// Edge case: writer release occurs only after both processes stop, repeated offline reconciliation remains idempotent, and later sends reject.
	// Dependencies: local pi CLI, production coordinator, supervisor, bridge, SessionStore, public SessionManager, system temporary state, and no provider or network.
	// Arrange.
	const directory = mkdtempSync(join(tmpdir(), "subagents-runtime-"));
	const bridge = new RootRuntimeBridge();
	const waits = new WaitCoordinator();
	const failures: RuntimeChannelFailure[] = [];
	const workers: ChildProcess[] = [];
	const workerClosures: Promise<void>[] = [];
	let coordinator: SubagentCoordinator | undefined;
	let failureHandling = Promise.resolve();
	let failedRuntimeLeaseId: string | undefined;
	let failedRemoteAppends = 0;
	let established = false;
	let acknowledged = false;
	let waitCeased = false;
	let waitResponseCount = 0;
	let laterSendRejected = false;
	let failureHandlingRejected = false;
	let writerReleased = false;
	let writerReleasedAfterProcessesStopped = false;
	let rootTerminalRecords = 0;
	let nestedTerminalRecords = 0;
	let nestedRecoveredState: string | undefined;
	let parentJournalKinds: string[] = [];
	try {
		const rootDirectory = join(directory, "root");
		const rootManager = SessionManager.create(rootDirectory, rootDirectory, {
			id: "owner-pi",
		});
		rootManager.appendCustomEntry("subagents-test-seed", { created: true });
		const rootSessionFile = rootManager.getSessionFile();
		if (rootSessionFile === undefined) {
			throw new Error(
				"public SessionManager did not create the root session file",
			);
		}
		const rootOwner: OwnerIdentity = {
			ownerPiSessionId: rootManager.getSessionId(),
			ownerSessionFile: rootSessionFile,
		};
		const parentSessionDir = join(directory, "parent");
		const parentSeedManager = SessionManager.create(
			parentSessionDir,
			parentSessionDir,
			{ id: "parent-owner-pi" },
		);
		parentSeedManager.appendMessage(seedAssistantMessage());
		const parentSeedFile = parentSeedManager.getSessionFile();
		if (parentSeedFile === undefined) {
			throw new Error(
				"public SessionManager did not create the parent session file",
			);
		}
		const agentDir = join(directory, "agent");
		const suiteDir = join(agentDir, "agent-suite");
		mkdirSync(suiteDir, { recursive: true });
		const store = new SessionStore({
			append: async (_owner, record) => {
				failedRemoteAppends += 1;
				if (failedRuntimeLeaseId === undefined) {
					throw new Error("failed runtime lease was not established");
				}
				await bridge.request(failedRuntimeLeaseId, "append_journal", record);
			},
			appendHistory: async (_owner, feedback) => {
				if (failedRuntimeLeaseId === undefined) {
					throw new Error("failed runtime lease was not established");
				}
				await bridge.request(failedRuntimeLeaseId, "append_history", feedback);
			},
		});
		store.registerActive({
			owner: rootOwner,
			sessionManager: rootManager,
			appendJournal: (record) => {
				rootManager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
			},
			appendHistory: () => {
				throw new Error("root history was not expected in fail-stop");
			},
		});
		const catalog = new SessionCatalog();
		const supervisor = new InvocationSupervisor({
			bridge,
			childStartupConfig: {
				authRetry: { maxRetries: 10, delayMs: 1 },
			},
			recordChildStartupAttempt: () => undefined,
			childEnvironment: {
				PI_AGENT_SUITE_DIR: suiteDir,
				PI_CODING_AGENT_DIR: agentDir,
			},
			onEvent: () => undefined,
			onRuntimeFailure: (failure) => {
				failures.push(failure);
				if (coordinator !== undefined) {
					failureHandling = recoverRuntimeFailure(coordinator, store, failure);
				}
			},
			spawnProcess: (command, args, options) => {
				const worker = spawn(command, [...args], options);
				workers.push(worker);
				workerClosures.push(
					new Promise((resolve) => {
						worker.once("close", () => resolve());
					}),
				);
				return worker;
			},
		});
		coordinator = new SubagentCoordinator({
			catalog,
			invocations: supervisor,
			waits,
			store,
			clock: {
				monotonicNow: () => performance.now(),
				wallNow: () => Date.now(),
			},
			isAgentAvailable: () => true,
		});
		const parent = await supervisor.launchWorker({
			owner: rootOwner,
			sessionKey: {
				ownerPiSessionId: rootOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			agentId: "SubAgentCoder",
			taskName: "Probe runtime",
			childPiSessionId: parentSeedManager.getSessionId(),
			childSessionDir: parentSessionDir,
			childSessionFile: parentSeedFile,
		});
		failedRuntimeLeaseId = parent.runtimeLeaseId;
		const parentOwner: OwnerIdentity = {
			ownerPiSessionId: parent.childPiSessionId,
			ownerSessionFile: parent.childSessionFile,
		};
		const descendant = await supervisor.launchWorker({
			owner: parentOwner,
			sessionKey: {
				ownerPiSessionId: parentOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			agentId: "SubAgentCoder",
			taskName: "Probe descendant",
			childSessionDir: join(directory, "descendant"),
			ownerRuntimeLeaseId: parent.runtimeLeaseId,
		});
		const parentSession: LogicalSession = {
			key: {
				ownerPiSessionId: rootOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: parent.childPiSessionId,
			childSessionDir: parent.childSessionDir,
			childSessionFile: parent.childSessionFile,
			agentId: "SubAgentCoder",
			taskName: "Probe runtime",
			creationOrder: 1,
			invocationId: parent.invocationId,
			runtimeLeaseId: parent.runtimeLeaseId,
			invocationMetadata: INVOCATION_METADATA,
			state: "active",
		};
		const descendantSession: LogicalSession = {
			key: {
				ownerPiSessionId: parentOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: descendant.childPiSessionId,
			childSessionDir: descendant.childSessionDir,
			childSessionFile: descendant.childSessionFile,
			agentId: "SubAgentCoder",
			taskName: "Probe descendant",
			creationOrder: 1,
			invocationId: descendant.invocationId,
			runtimeLeaseId: descendant.runtimeLeaseId,
			ownerRuntimeLeaseId: parent.runtimeLeaseId,
			invocationMetadata: INVOCATION_METADATA,
			state: "active",
		};
		await store.append(rootOwner, {
			kind: "session-accepted",
			session: parentSession,
		});
		await bridge.request(parent.runtimeLeaseId, "append_history", {
			feedbackId: "nested-owner-seed",
			invocationId: descendantSession.invocationId,
			sessionKey: descendantSession.key,
			status: "success",
			output: "seed active branch",
			presentation: {
				agentId: descendantSession.agentId,
				taskName: descendantSession.taskName,
				invocationMetadata: descendantSession.invocationMetadata,
			},
		});
		const nestedAppendResponse = await bridge.request(
			parent.runtimeLeaseId,
			"append_journal",
			{ kind: "session-accepted", session: descendantSession },
		);
		store.registerRemote(parentOwner, parent.runtimeLeaseId);
		catalog.add(parentSession);
		catalog.add(descendantSession);
		coordinator.registerOwner(rootOwner);
		coordinator.registerOwner(parentOwner);
		established = workers.length === 2;
		const response = await bridge.request(
			parent.runtimeLeaseId,
			"delivery_acknowledgment",
			{},
		);
		acknowledged =
			isAcknowledged(nestedAppendResponse) && isAcknowledged(response);
		const pendingWait = coordinator
			.wait(
				parentOwner,
				{ sessionIds: [1], timeoutMs: 30_000 },
				{
					toolCallId: "wait-tool",
					requestId: "nested-wait",
					runtimeLeaseId: parent.runtimeLeaseId,
				},
			)
			.then(() => {
				waitResponseCount += 1;
			})
			.catch(() => {
				waitCeased = true;
			});

		// Act.
		const parentProcess = workers[0];
		if (parentProcess === undefined) {
			throw new Error("production supervisor did not spawn a parent worker");
		}
		parentProcess.disconnect();
		while (failures.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		try {
			await failureHandling;
		} catch {
			failureHandlingRejected = true;
		}
		await pendingWait;
		const processesStopped = workers.every(
			(worker) => worker.exitCode !== null || worker.signalCode !== null,
		);
		if (processesStopped) {
			await Promise.all(workerClosures);
			writerReleasedAfterProcessesStopped = workers.every(
				(worker) => worker.exitCode !== null || worker.signalCode !== null,
			);
			writerReleased =
				store.releaseRemoteLease(parent.runtimeLeaseId).length === 0;
			await store.reconcileOffline(parentOwner);
			const parentManager = SessionManager.open(
				parentOwner.ownerSessionFile,
				parent.childSessionDir,
			);
			parentJournalKinds = parentManager.getBranch().flatMap((entry) => {
				if (
					entry.type !== "custom" ||
					entry.customType !== SUBAGENT_JOURNAL_CUSTOM_TYPE
				) {
					return [];
				}
				return [parseJournalRecord(entry.data)?.kind ?? "invalid"];
			});
			const parentFold = store.fold(parentManager.getBranch());
			nestedRecoveredState = parentFold.sessions.find(
				(session) =>
					session.key.ownerPiSessionId === parentOwner.ownerPiSessionId &&
					session.key.ownerLocalSessionId === 1,
			)?.state;
			nestedTerminalRecords = countTerminalRecords(parentManager);
			rootTerminalRecords = countTerminalRecords(rootManager);
		}
		try {
			await bridge.request(
				parent.runtimeLeaseId,
				"delivery_acknowledgment",
				{},
			);
		} catch {
			laterSendRejected = true;
		}

		// Assert.
		expect({
			established,
			acknowledged,
			failures,
			failureHandlingRejected,
			failedRemoteAppends,
			waitCeased,
			waitResponseCount,
			laterSendRejected,
			allProcessesClosed: workers.every(
				(worker) => worker.exitCode !== null || worker.signalCode !== null,
			),
			writerReleased,
			writerReleasedAfterProcessesStopped,
			rootTerminalRecords,
			nestedTerminalRecords,
			nestedRecoveredState,
			parentJournalKinds,
		}).toEqual({
			established: true,
			acknowledged: true,
			failures: [
				{
					runtimeLeaseId: parent.runtimeLeaseId,
					reason: "channel_disconnected",
				},
			],
			failureHandlingRejected: false,
			failedRemoteAppends: 1,
			waitCeased: true,
			waitResponseCount: 0,
			laterSendRejected: true,
			allProcessesClosed: true,
			writerReleased: true,
			writerReleasedAfterProcessesStopped: true,
			rootTerminalRecords: 1,
			nestedTerminalRecords: 1,
			nestedRecoveredState: "terminal-aborted",
			parentJournalKinds: ["session-accepted", "terminal"],
		});
	} finally {
		for (const worker of workers) {
			if (worker.exitCode === null && worker.signalCode === null) {
				worker.kill("SIGKILL");
			}
		}
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Creates one persisted branch leaf before the worker becomes its sole writer. */
function seedAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "seed" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** Recognizes the one production acknowledgment result shape under test. */
function isAcknowledged(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"acknowledged" in value &&
		value.acknowledged === true
	);
}

/** Counts durable terminal records through the production journal parser. */
function countTerminalRecords(manager: SessionManager): number {
	return manager.getBranch().filter((entry) => {
		if (
			entry.type !== "custom" ||
			entry.customType !== SUBAGENT_JOURNAL_CUSTOM_TYPE
		) {
			return false;
		}
		return parseJournalRecord(entry.data)?.kind === "terminal";
	}).length;
}
