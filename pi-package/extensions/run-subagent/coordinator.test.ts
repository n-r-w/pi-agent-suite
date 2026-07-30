import { describe, expect, test } from "bun:test";
import type { SubagentNormalResult, SubagentStartRequest } from "./contracts";
import { SubagentCoordinator } from "./coordinator";
import type {
	JournalRecord,
	LogicalSession,
	OwnerIdentity,
	SessionKey,
	SubagentFeedback,
} from "./domain";
import type {
	InvocationAcceptance,
	InvocationControl,
	InvocationEvent,
	InvocationSteerScope,
	NewInvocationRequest,
} from "./invocation-contracts";
import type { OwnerSessionStore } from "./persistence";
import { recoverRuntimeFailure } from "./runtime-failure";
import type { SessionCatalogState } from "./session-catalog";
import type {
	WaitAdmission,
	WaitCorrelation,
	WaitRuntime,
} from "./wait-coordinator";

const OWNER: OwnerIdentity = {
	ownerPiSessionId: "owner-pi",
	ownerSessionFile: "/tmp/owner-session.jsonl",
};

/** Stores deterministic session facts for coordinator behavior tests. */
class CatalogFake implements SessionCatalogState {
	public readonly sessions: LogicalSession[] = [];

	/** Adds one accepted test session. */
	public add(session: LogicalSession): void {
		this.sessions.push(session);
	}

	/** Replaces one reconstructed test session by stable key. */
	public replace(session: LogicalSession): void {
		const index = this.sessions.findIndex(
			(current) =>
				current.key.ownerPiSessionId === session.key.ownerPiSessionId &&
				current.key.ownerLocalSessionId === session.key.ownerLocalSessionId,
		);
		if (index < 0) {
			throw new Error("test session is unknown");
		}
		this.sessions[index] = session;
	}

	/** Resolves one owner-local test session. */
	public get(
		owner: OwnerIdentity,
		ownerLocalSessionId: number,
	): LogicalSession | undefined {
		return this.sessions.find(
			(session) =>
				session.key.ownerPiSessionId === owner.ownerPiSessionId &&
				session.key.ownerLocalSessionId === ownerLocalSessionId,
		);
	}

	/** Finds every test session that shares one local ID. */
	public findByLocalId(ownerLocalSessionId: number): readonly LogicalSession[] {
		return this.sessions.filter(
			(session) => session.key.ownerLocalSessionId === ownerLocalSessionId,
		);
	}

	/** Lists one owner's test sessions. */
	public list(owner: OwnerIdentity): readonly LogicalSession[] {
		return this.sessions.filter(
			(session) => session.key.ownerPiSessionId === owner.ownerPiSessionId,
		);
	}

	/** Updates the current invocation facts in place for test observation. */
	public update(
		key: SessionKey,
		update: Partial<
			Pick<
				LogicalSession,
				"invocationId" | "runtimeLeaseId" | "ownerRuntimeLeaseId" | "state"
			>
		>,
	): void {
		const index = this.sessions.findIndex(
			(session) =>
				session.key.ownerPiSessionId === key.ownerPiSessionId &&
				session.key.ownerLocalSessionId === key.ownerLocalSessionId,
		);
		const current = this.sessions[index];
		if (current !== undefined) {
			this.sessions[index] = { ...current, ...update };
		}
	}
}

/** Keeps invocation acceptance controllable without a child process. */
class InvocationControlFake implements InvocationControl {
	public active = false;
	public rejectNextStart = false;
	public startCalls = 0;
	public startGate: Promise<void> | undefined;
	public continueGate: Promise<void> | undefined;
	public steerGate: Promise<void> | undefined;
	public steerResponseGate: Promise<void> | undefined;
	public terminateGate: Promise<void> | undefined;
	/** Runs controlled teardown behavior after one lease enters process termination. */
	public terminateAction:
		| ((runtimeLeaseId: string) => Promise<void>)
		| undefined;
	public readonly steerCalls: string[] = [];
	public readonly continueCalls: string[] = [];
	public readonly terminatedLeases: string[] = [];
	public nextAcceptance: InvocationAcceptance = {
		invocationId: "invocation-1",
		runtimeLeaseId: "lease-1",
		childPiSessionId: "child-pi-1",
		childSessionDir: "/tmp/child",
		childSessionFile: "/tmp/child/session.jsonl",
	};

	/** Accepts one new invocation while leaving it active. */
	public async start(
		_request: NewInvocationRequest,
	): Promise<InvocationAcceptance> {
		this.startCalls += 1;
		if (this.rejectNextStart) {
			this.rejectNextStart = false;
			throw new Error("controlled start rejection");
		}
		await this.startGate;
		this.active = true;
		return this.nextAcceptance;
	}

	/** Accepts continuation of one saved test session. */
	public async continue(
		_session: LogicalSession,
		prompt: string,
	): Promise<InvocationAcceptance> {
		this.continueCalls.push(prompt);
		await this.continueGate;
		this.active = true;
		return this.nextAcceptance;
	}

	/** Accepts steering of one active invocation. */
	public async steer(
		_invocationId: string,
		prompt: string,
		scope: InvocationSteerScope = {},
	): Promise<void> {
		await this.steerGate;
		scope.signal?.throwIfAborted();
		scope.beforeDispatch?.();
		this.steerCalls.push(prompt);
		await this.steerResponseGate;
	}

	/** Marks a test runtime lease inactive. */
	public async terminateLease(runtimeLeaseId: string): Promise<void> {
		this.terminatedLeases.push(runtimeLeaseId);
		await this.terminateAction?.(runtimeLeaseId);
		await this.terminateGate;
		this.active = false;
	}
}

/** Records durable journal writes in append order. */
class StoreFake implements OwnerSessionStore {
	public readonly records: JournalRecord[] = [];
	public readonly remoteOwners = new Map<string, OwnerIdentity>();
	public readonly releasedLeases: string[] = [];
	public readonly reconciledOwners: string[] = [];
	public readonly reconciledAfterCompleteRelease: boolean[] = [];
	public appendGate: Promise<void> | undefined;
	public onAppend: ((record: JournalRecord) => void) | undefined;
	public nextAppendFailure: "absent" | "ambiguous" | undefined;

	public constructor(private readonly history: HistoryFake) {}

	/** Records one coordinator journal command or simulates one publication failure. */
	public async append(
		_owner: OwnerIdentity,
		record: JournalRecord,
	): Promise<void> {
		this.onAppend?.(record);
		await this.appendGate;
		const failure = this.nextAppendFailure;
		this.nextAppendFailure = undefined;
		if (failure === "ambiguous") {
			this.records.push(record);
		}
		if (failure !== undefined) {
			throw new Error(`controlled ${failure} append failure`);
		}
		this.records.push(record);
	}

	/** Records one history message as branch evidence. */
	public async appendHistory(
		_owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void> {
		this.historyFeedbackIds.add(feedback.feedbackId);
		await this.history.deliver(_owner, feedback);
	}

	public readonly historyFeedbackIds = new Set<string>();
	public readonly waitFeedbackIds = new Set<string>();

	/** Reports accepted-record evidence by stable session and invocation identity. */
	public async hasAcceptedInvocationEvidence(
		_owner: OwnerIdentity,
		sessionKey: SessionKey,
		invocationId: string,
	): Promise<boolean> {
		return this.records.some((record) => {
			if (record.kind === "session-accepted") {
				return (
					record.session.invocationId === invocationId &&
					record.session.key.ownerPiSessionId === sessionKey.ownerPiSessionId &&
					record.session.key.ownerLocalSessionId ===
						sessionKey.ownerLocalSessionId
				);
			}
			return (
				record.kind === "continuation-accepted" &&
				record.invocationId === invocationId &&
				record.sessionKey.ownerPiSessionId === sessionKey.ownerPiSessionId &&
				record.sessionKey.ownerLocalSessionId === sessionKey.ownerLocalSessionId
			);
		});
	}

	/** Reports deterministic wait-result evidence. */
	public async hasWaitEvidence(
		_owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean> {
		return this.waitFeedbackIds.has(feedbackId);
	}

	/** Reports deterministic history evidence. */
	public async hasHistoryEvidence(
		_owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean> {
		return this.historyFeedbackIds.has(feedbackId);
	}

	/** Releases one configured remote owner and records lease ordering. */
	public releaseRemoteLease(runtimeLeaseId: string): readonly OwnerIdentity[] {
		this.releasedLeases.push(runtimeLeaseId);
		const owner = this.remoteOwners.get(runtimeLeaseId);
		if (owner === undefined) {
			return [];
		}
		this.remoteOwners.delete(runtimeLeaseId);
		return [owner];
	}

	/** Records that offline reconciliation begins only after every writer release. */
	public async reconcileOffline(
		owner: OwnerIdentity,
	): Promise<readonly LogicalSession[]> {
		this.reconciledOwners.push(owner.ownerPiSessionId);
		this.reconciledAfterCompleteRelease.push(this.remoteOwners.size === 0);
		return [];
	}
}

/** Records owner-history delivery without entering wait settlement. */
class HistoryFake {
	public readonly feedback: SubagentFeedback[] = [];

	/** Records one selected history destination. */
	public async deliver(
		_owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void> {
		this.feedback.push(feedback);
	}
}

/** Keeps one pending wait and exposes explicit settlement. */
class WaitRuntimeFake implements WaitRuntime {
	public admission: WaitAdmission | undefined;
	public readonly cancelledLeases: string[] = [];
	public readonly cancelledOwners: string[] = [];
	public settled: SubagentNormalResult[] = [];
	private reject: ((error: Error) => void) | undefined;
	private resolve: ((result: SubagentNormalResult) => void) | undefined;
	private onTimeout: (() => void) | undefined;

	/** Admits one pending test wait. */
	public admit(
		admission: WaitAdmission,
		onTimeout: () => void,
	): Promise<SubagentNormalResult> {
		this.admission = admission;
		this.onTimeout = onTimeout;
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	/** Settles the current pending test wait once. */
	public settle(_owner: OwnerIdentity, result: SubagentNormalResult): boolean {
		if (this.resolve === undefined) {
			return false;
		}
		const resolve = this.resolve;
		this.admission = undefined;
		this.reject = undefined;
		this.resolve = undefined;
		this.settled.push(result);
		resolve(result);
		return true;
	}

	/** Fires the admitted deadline callback under test control. */
	public expire(): void {
		this.onTimeout?.();
	}

	/** Rejects one exact test correlation without settling it normally. */
	public cancel(correlation: WaitCorrelation, reason: Error): boolean {
		if (
			this.admission === undefined ||
			this.admission.owner.ownerPiSessionId !==
				correlation.owner.ownerPiSessionId ||
			this.admission.owner.ownerSessionFile !==
				correlation.owner.ownerSessionFile ||
			this.admission.toolCallId !== correlation.toolCallId ||
			this.admission.requestId !== correlation.requestId ||
			this.admission.runtimeLeaseId !== correlation.runtimeLeaseId
		) {
			return false;
		}
		const reject = this.reject;
		this.admission = undefined;
		this.reject = undefined;
		this.resolve = undefined;
		this.onTimeout = undefined;
		reject?.(reason);
		return true;
	}

	/** Clears one owner wait without settlement. */
	public cancelOwner(owner: OwnerIdentity): void {
		this.cancelledOwners.push(owner.ownerPiSessionId);
		this.cancelPending("owner wait cancelled");
	}

	/** Clears one lease wait without settlement. */
	public cancelLease(runtimeLeaseId: string): void {
		this.cancelledLeases.push(runtimeLeaseId);
		if (this.admission?.runtimeLeaseId === runtimeLeaseId) {
			this.cancelPending("lease wait cancelled");
		}
	}

	/** Rejects the pending wait once without producing a settlement. */
	private cancelPending(message: string): void {
		const reject = this.reject;
		this.admission = undefined;
		this.reject = undefined;
		this.resolve = undefined;
		reject?.(new Error(message));
	}
}

/** Creates one deterministic coordinator and its observable ports. */
function createHarness(now: () => number = () => 10): {
	readonly coordinator: SubagentCoordinator;
	readonly catalog: CatalogFake;
	readonly invocations: InvocationControlFake;
	readonly store: StoreFake;
	readonly history: HistoryFake;
	readonly waits: WaitRuntimeFake;
} {
	const catalog = new CatalogFake();
	const invocations = new InvocationControlFake();
	const history = new HistoryFake();
	const store = new StoreFake(history);
	const waits = new WaitRuntimeFake();
	return {
		coordinator: new SubagentCoordinator({
			catalog,
			invocations,
			store,
			waits,
			clock: { monotonicNow: now, wallNow: now },
			isAgentAvailable: (_owner, agentId) => agentId === "SubAgentCoder",
		}),
		catalog,
		invocations,
		store,
		history,
		waits,
	};
}

/** Exercises canceled-wait readmission and one later feedback destination. */
async function exerciseCanceledWaitReadmission(
	harness: ReturnType<typeof createHarness>,
	cancel: () => Promise<unknown>,
	runtimeLeaseId?: string,
): Promise<{
	readonly cancelledWaits: number;
	readonly staleSettlements: number;
	readonly result: SubagentNormalResult | undefined;
}> {
	let cancelledWaits = 0;
	let staleSettlements = 0;
	const firstWait = harness.coordinator
		.wait(
			OWNER,
			{ sessionIds: [1], timeoutMs: 100 },
			{
				toolCallId: "cancelled-wait",
				requestId: "cancelled-request",
				...(runtimeLeaseId === undefined ? {} : { runtimeLeaseId }),
			},
		)
		.then(() => {
			staleSettlements += 1;
		})
		.catch(() => {
			cancelledWaits += 1;
		});
	await Promise.resolve();
	await cancel();
	await firstWait;
	const resumedSession = activeSession(2);
	harness.catalog.add(resumedSession);
	harness.coordinator.registerOwner(OWNER);
	const resumedWait = harness.coordinator.wait(
		OWNER,
		{ sessionIds: [2], timeoutMs: 100 },
		{ toolCallId: "resumed-wait", requestId: "resumed-request" },
	);
	await Promise.resolve();
	await harness.coordinator.observeInvocation({
		kind: "terminal",
		invocationId: resumedSession.invocationId,
		status: "success",
		text: "resumed result",
	});
	return {
		cancelledWaits,
		staleSettlements,
		result: await resumedWait.catch(() => undefined),
	};
}

/** Seeds one active direct child for wait and terminal tests. */
function activeSession(localId = 1): LogicalSession {
	return {
		key: {
			ownerPiSessionId: OWNER.ownerPiSessionId,
			ownerLocalSessionId: localId,
		},
		childPiSessionId: `child-pi-${localId}`,
		childSessionDir: `/tmp/child-${localId}`,
		childSessionFile: `/tmp/child-${localId}/session.jsonl`,
		agentId: "SubAgentCoder",
		taskName: "Trace runtime",
		creationOrder: localId,
		invocationId: `invocation-${localId}`,
		runtimeLeaseId: `lease-${localId}`,
		invocationMetadata: {
			startedAtMs: 1_700_000_000_000,
			elapsedMs: 1_000,
			modelId: "openai/test-model",
			thinking: "high",
			contextWindow: 128_000,
		},
		state: "active",
	};
}

describe("SubagentCoordinator", () => {
	test("returns accepted before child completion", async () => {
		// Purpose: start acceptance must not wait for terminal child feedback.
		// Input and expected output: one available agent returns accepted session 1 while its invocation remains active.
		// Edge case: the child produces no terminal event before the start result.
		// Dependencies: in-memory catalog, invocation control, journal, wait, and history ports.
		const harness = createHarness();
		const request: SubagentStartRequest = {
			agentId: "SubAgentCoder",
			taskName: "Trace runtime",
			prompt: "Inspect the runtime",
		};
		let result: SubagentNormalResult | undefined;
		try {
			result = await harness.coordinator.start(OWNER, request);
		} catch {}

		expect({ result, active: harness.invocations.active }).toEqual({
			result: { outcome: "accepted", sessionId: 1 },
			active: true,
		});
	});

	test("reports an unavailable subagent without registry terminology", async () => {
		// Purpose: agent_unavailable must identify the requested subagent without exposing the internal callable-agent classification.
		// Input and expected output: an unavailable agent ID produces one concise model-visible failure.
		// Edge case: availability fails before an invocation or logical session is created.
		// Dependencies: coordinator availability policy and the common public error boundary.
		const harness = createHarness();
		let failure: string | undefined;
		try {
			await harness.coordinator.start(OWNER, {
				agentId: "MissingAgent",
				taskName: "Unavailable agent",
				prompt: "Start",
			});
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}

		expect(failure).toBe(
			"[agent_unavailable] Subagent MissingAgent is unavailable",
		);
		expect(harness.invocations.startCalls).toBe(0);
		expect(harness.catalog.sessions).toEqual([]);
	});

	test("cancels an accepted start before publication without leaving a session", async () => {
		// Purpose: cancellation must own the start outcome when it precedes logical acceptance publication.
		// Input and expected output: abort while invocation acceptance is gated rejects with the Pi reason, terminates the lease, and writes no session.
		// Edge case: the invocation port still returns an acceptance after cancellation, so coordinator compensation owns cleanup.
		// Dependencies: controllable invocation acceptance, coordinator serialization, catalog, and journal fakes.
		const harness = createHarness();
		let releaseAcceptance = (): void => undefined;
		harness.invocations.startGate = new Promise<void>((resolve) => {
			releaseAcceptance = resolve;
		});
		const controller = new AbortController();
		const reason = new Error("cancel start before publication");
		const pending = harness.coordinator
			.start(
				OWNER,
				{
					agentId: "SubAgentCoder",
					taskName: "Cancelled start",
					prompt: "work",
				},
				{ signal: controller.signal },
			)
			.catch((error: unknown) => error);
		await Promise.resolve();
		controller.abort(reason);
		releaseAcceptance();
		const outcome = await pending;

		expect({
			originalReason: outcome === reason,
			sessions: harness.catalog.sessions.length,
			records: harness.store.records.length,
			terminatedLeases: harness.invocations.terminatedLeases,
			active: harness.invocations.active,
		}).toEqual({
			originalReason: true,
			sessions: 0,
			records: 0,
			terminatedLeases: ["lease-1"],
			active: false,
		});
	});

	test("cancels one exact remote start correlation before publication", async () => {
		// Purpose: nested cancellation must reach the same authority as root Pi cancellation without relying on a local signal.
		// Input and expected output: stale correlation loses, exact correlation wins, and the accepted lease is terminated without publication.
		// Edge case: runtime lease, bridge request ID, and tool-call ID must all match.
		// Dependencies: coordinator operation authority and controllable invocation acceptance.
		const harness = createHarness();
		let releaseAcceptance = (): void => undefined;
		harness.invocations.startGate = new Promise<void>((resolve) => {
			releaseAcceptance = resolve;
		});
		const correlation = {
			runtimeLeaseId: "nested-owner-lease",
			requestId: "nested-request",
			toolCallId: "nested-tool",
		};
		const pending = harness.coordinator
			.start(
				OWNER,
				{
					agentId: "SubAgentCoder",
					taskName: "Remote cancelled start",
					prompt: "work",
				},
				{
					ownerRuntimeLeaseId: correlation.runtimeLeaseId,
					operationCorrelation: correlation,
				},
			)
			.catch((error: unknown) => error);
		await Promise.resolve();
		const staleCancelled = harness.coordinator.cancelOperation(
			{
				...correlation,
				requestId: "stale-request",
			},
			new Error("stale remote cancellation"),
		);
		const exactCancelled = harness.coordinator.cancelOperation(
			correlation,
			new Error("exact remote cancellation"),
		);
		releaseAcceptance();
		await pending;

		expect({
			staleCancelled,
			exactCancelled,
			sessions: harness.catalog.sessions.length,
			records: harness.store.records.length,
			terminatedLeases: harness.invocations.terminatedLeases,
		}).toEqual({
			staleCancelled: false,
			exactCancelled: true,
			sessions: 0,
			records: 0,
			terminatedLeases: ["lease-1"],
		});
	});

	test("cancels terminal continuation before publication without replacing the session", async () => {
		// Purpose: continuation cancellation must preserve the terminal invocation when cancellation precedes publication.
		// Input and expected output: a gated continuation acceptance is terminated, no continuation record is written, and the original session stays terminal.
		// Edge case: the new invocation has already received a runtime lease before cancellation is observed.
		// Dependencies: terminal catalog state, controllable continuation acceptance, and journal fakes.
		const harness = createHarness();
		const session = { ...activeSession(), state: "terminal-success" as const };
		harness.catalog.add(session);
		harness.invocations.nextAcceptance = {
			...harness.invocations.nextAcceptance,
			invocationId: "continuation-invocation",
			runtimeLeaseId: "continuation-lease",
		};
		let releaseAcceptance = (): void => undefined;
		harness.invocations.continueGate = new Promise<void>((resolve) => {
			releaseAcceptance = resolve;
		});
		const controller = new AbortController();
		const reason = new Error("cancel continuation before publication");
		const pending = harness.coordinator
			.steer(
				OWNER,
				{ sessionId: 1, prompt: "continue" },
				{ signal: controller.signal },
			)
			.catch((error: unknown) => error);
		await Promise.resolve();
		controller.abort(reason);
		releaseAcceptance();
		const outcome = await pending;
		const current = harness.catalog.get(OWNER, 1);

		expect({
			originalReason: outcome === reason,
			invocationId: current?.invocationId,
			state: current?.state,
			records: harness.store.records.length,
			terminatedLeases: harness.invocations.terminatedLeases,
		}).toEqual({
			originalReason: true,
			invocationId: session.invocationId,
			state: "terminal-success",
			records: 0,
			terminatedLeases: ["continuation-lease"],
		});
	});

	test("cancels active steering before child prompt acceptance", async () => {
		// Purpose: active steering must use the same cancellation-versus-acceptance ordering as start and continuation.
		// Input and expected output: abort while child steering acceptance is gated rejects with the Pi reason and records no applied prompt.
		// Edge case: the tracked active invocation remains authoritative and is not replaced or removed.
		// Dependencies: active catalog state, controllable steering acceptance, and coordinator operation scope.
		const harness = createHarness();
		const session = activeSession();
		harness.catalog.add(session);
		let releaseAcceptance = (): void => undefined;
		harness.invocations.steerGate = new Promise<void>((resolve) => {
			releaseAcceptance = resolve;
		});
		const controller = new AbortController();
		const reason = new Error("cancel active steer before acceptance");
		const pending = harness.coordinator
			.steer(
				OWNER,
				{ sessionId: 1, prompt: "do not apply" },
				{ signal: controller.signal },
			)
			.catch((error: unknown) => error);
		await Promise.resolve();
		controller.abort(reason);
		releaseAcceptance();
		const outcome = await pending;

		expect({
			originalReason: outcome === reason,
			steerCalls: harness.invocations.steerCalls,
			currentInvocation: harness.catalog.get(OWNER, 1)?.invocationId,
			currentState: harness.catalog.get(OWNER, 1)?.state,
		}).toEqual({
			originalReason: true,
			steerCalls: [],
			currentInvocation: session.invocationId,
			currentState: "active",
		});
	});

	test("keeps dispatched active steering accepted across local and remote cancellation", async () => {
		// Purpose: dispatch reservation must close cancellation authority before the child RPC response is observed.
		// Input and expected output: local abort and exact remote cancellation both lose after one applied steer dispatch.
		// Edge case: the child response remains gated until both cancellation paths have run.
		// Dependencies: coordinator operation authority, dispatch-aware invocation fake, and AbortController.
		const harness = createHarness();
		harness.catalog.add(activeSession());
		let releaseResponse = (): void => undefined;
		harness.invocations.steerResponseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const correlation = {
			requestId: "dispatched-steer-request",
			toolCallId: "dispatched-steer-tool",
		};
		const controller = new AbortController();
		const pending = harness.coordinator.steer(
			OWNER,
			{ sessionId: 1, prompt: "apply exactly once" },
			{ signal: controller.signal, operationCorrelation: correlation },
		);
		while (harness.invocations.steerCalls.length === 0) {
			await Promise.resolve();
		}
		controller.abort(new Error("late local cancellation"));
		const remoteCancellationWon = harness.coordinator.cancelOperation(
			correlation,
			new Error("late remote cancellation"),
		);
		releaseResponse();
		const outcome = await pending;

		expect({
			outcome,
			remoteCancellationWon,
			steerCalls: harness.invocations.steerCalls,
			state: harness.catalog.get(OWNER, 1)?.state,
		}).toEqual({
			outcome: { outcome: "accepted", sessionId: 1 },
			remoteCancellationWon: false,
			steerCalls: ["apply exactly once"],
			state: "active",
		});
	});

	test("retains tracked start and steering outcomes when acceptance wins", async () => {
		// Purpose: cancellation after publication authority cannot undo a tracked acceptance or duplicate cleanup.
		// Input and expected output: accepted start remains cataloged, and accepted active steering applies exactly once after later aborts.
		// Edge case: both Pi signals abort immediately after their coordinator promises resolve.
		// Dependencies: coordinator operation authority, catalog, journal, and invocation fakes.
		const harness = createHarness();
		const startController = new AbortController();
		const startCorrelation = {
			requestId: "accepted-start-request",
			toolCallId: "accepted-start-tool",
		};
		const started = await harness.coordinator.start(
			OWNER,
			{
				agentId: "SubAgentCoder",
				taskName: "Accepted start",
				prompt: "work",
			},
			{
				signal: startController.signal,
				operationCorrelation: startCorrelation,
			},
		);
		startController.abort(new Error("late start cancellation"));
		const lateStartCancellation = harness.coordinator.cancelOperation(
			startCorrelation,
			new Error("late remote start cancellation"),
		);
		const steerController = new AbortController();
		const steerCorrelation = {
			requestId: "accepted-steer-request",
			toolCallId: "accepted-steer-tool",
		};
		const steered = await harness.coordinator.steer(
			OWNER,
			{ sessionId: 1, prompt: "apply once" },
			{
				signal: steerController.signal,
				operationCorrelation: steerCorrelation,
			},
		);
		steerController.abort(new Error("late steer cancellation"));
		const lateSteerCancellation = harness.coordinator.cancelOperation(
			steerCorrelation,
			new Error("late remote steer cancellation"),
		);

		expect({
			started,
			steered,
			lateStartCancellation,
			lateSteerCancellation,
			sessions: harness.catalog.sessions.length,
			state: harness.catalog.get(OWNER, 1)?.state,
			steerCalls: harness.invocations.steerCalls,
			terminatedLeases: harness.invocations.terminatedLeases,
		}).toEqual({
			started: { outcome: "accepted", sessionId: 1 },
			steered: { outcome: "accepted", sessionId: 1 },
			lateStartCancellation: false,
			lateSteerCancellation: false,
			sessions: 1,
			state: "active",
			steerCalls: ["apply once"],
			terminatedLeases: [],
		});
	});

	test("does not accept a failed start and consumes only its candidate ID", async () => {
		// Purpose: pre-acceptance failure must not create a logical session while preserving monotonic owner-local allocation.
		// Input and expected output: one rejected start is followed by an accepted session with owner-local ID 2.
		// Edge case: the failed candidate remains absent from the catalog and journal.
		// Dependencies: deterministic invocation rejection and in-memory coordinator ports.
		const harness = createHarness();
		harness.invocations.rejectNextStart = true;
		const request: SubagentStartRequest = {
			agentId: "SubAgentCoder",
			taskName: "Start candidate",
			prompt: "Inspect the runtime",
		};
		let failed = false;
		try {
			await harness.coordinator.start(OWNER, request);
		} catch {
			failed = true;
		}
		const accepted = await harness.coordinator.start(OWNER, request);

		expect({
			failed,
			accepted,
			sessions: harness.catalog.sessions.map(
				(session) => session.key.ownerLocalSessionId,
			),
			journalKinds: harness.store.records.map((record) => record.kind),
		}).toEqual({
			failed: true,
			accepted: { outcome: "accepted", sessionId: 2 },
			sessions: [2],
			journalKinds: ["session-accepted"],
		});
	});

	test("stops an accepted initial invocation when publication has no evidence", async () => {
		// Purpose: durable acceptance failure cannot leave a live invocation without a logical reference.
		// Input and expected output: accepted prompt plus absent session-accepted evidence rejects, stops lease-1, and publishes no session or feedback.
		// Edge case: the consumed owner-local candidate remains a gap rather than an addressable session.
		// Dependencies: controlled absent append failure after supervisor acceptance.
		// Arrange.
		const harness = createHarness();
		harness.store.nextAppendFailure = "absent";

		// Act.
		let rejected = false;
		try {
			await harness.coordinator.start(OWNER, {
				agentId: "SubAgentCoder",
				taskName: "Absent publication",
				prompt: "Accept then fail publication",
			});
		} catch {
			rejected = true;
		}

		// Assert.
		expect({
			rejected,
			terminatedLeases: harness.invocations.terminatedLeases,
			invocationActive: harness.invocations.active,
			sessions: harness.catalog.sessions,
			records: harness.store.records,
			history: harness.history.feedback,
		}).toEqual({
			rejected: true,
			terminatedLeases: ["lease-1"],
			invocationActive: false,
			sessions: [],
			records: [],
			history: [],
		});
	});

	test("reconciles ambiguous initial acceptance before a later start", async () => {
		// Purpose: delivery-unknown session acceptance must resolve to one stopped durable session before another start.
		// Input and expected output: ambiguous evidence becomes terminal-aborted session 1, then a later start creates only session 2.
		// Edge case: compensation creates no feedback for the stopped accepted invocation.
		// Dependencies: controlled append that writes session-accepted before rejecting.
		// Arrange.
		const harness = createHarness();
		harness.store.nextAppendFailure = "ambiguous";

		// Act.
		let rejected = false;
		try {
			await harness.coordinator.start(OWNER, {
				agentId: "SubAgentCoder",
				taskName: "Ambiguous publication",
				prompt: "Accept then lose acknowledgment",
			});
		} catch {
			rejected = true;
		}
		harness.invocations.nextAcceptance = {
			invocationId: "invocation-2",
			runtimeLeaseId: "lease-2",
			childPiSessionId: "child-pi-2",
			childSessionDir: "/tmp/child-2",
			childSessionFile: "/tmp/child-2/session.jsonl",
		};
		const later = await harness.coordinator.start(OWNER, {
			agentId: "SubAgentCoder",
			taskName: "Later start",
			prompt: "Start a distinct session",
		});

		// Assert.
		expect({
			rejected,
			later,
			terminatedLeases: harness.invocations.terminatedLeases,
			sessions: harness.catalog.sessions.map((session) => ({
				id: session.key.ownerLocalSessionId,
				invocationId: session.invocationId,
				state: session.state,
			})),
			recordKinds: harness.store.records.map((record) => record.kind),
			history: harness.history.feedback,
		}).toEqual({
			rejected: true,
			later: { outcome: "accepted", sessionId: 2 },
			terminatedLeases: ["lease-1"],
			sessions: [
				{ id: 1, invocationId: "invocation-1", state: "terminal-aborted" },
				{ id: 2, invocationId: "invocation-2", state: "active" },
			],
			recordKinds: ["session-accepted", "terminal", "session-accepted"],
			history: [],
		});
	});

	test("stops an accepted continuation when publication has no evidence", async () => {
		// Purpose: failed continuation publication must preserve the prior terminal reference for retry.
		// Input and expected output: absent continuation evidence stops lease-2, keeps invocation-1 terminal, and a later steer accepts invocation-3.
		// Edge case: the failed continuation creates no feedback or catalog mutation.
		// Dependencies: one terminal session and controlled absent continuation append.
		// Arrange.
		const harness = createHarness();
		harness.catalog.add({ ...activeSession(), state: "terminal-success" });
		harness.coordinator.registerOwner(OWNER);
		harness.invocations.nextAcceptance = {
			invocationId: "invocation-2",
			runtimeLeaseId: "lease-2",
			childPiSessionId: "child-pi-1",
			childSessionDir: "/tmp/child-1",
			childSessionFile: "/tmp/child-1/session.jsonl",
		};
		harness.store.nextAppendFailure = "absent";

		// Act.
		let rejected = false;
		try {
			await harness.coordinator.steer(OWNER, {
				sessionId: 1,
				prompt: "First continuation",
			});
		} catch {
			rejected = true;
		}
		const afterFailure = harness.catalog.get(OWNER, 1);
		harness.invocations.nextAcceptance = {
			invocationId: "invocation-3",
			runtimeLeaseId: "lease-3",
			childPiSessionId: "child-pi-1",
			childSessionDir: "/tmp/child-1",
			childSessionFile: "/tmp/child-1/session.jsonl",
		};
		const later = await harness.coordinator.steer(OWNER, {
			sessionId: 1,
			prompt: "Retry continuation",
		});

		// Assert.
		expect({
			rejected,
			afterFailure,
			later,
			terminatedLeases: harness.invocations.terminatedLeases,
			current: harness.catalog.get(OWNER, 1),
			recordKinds: harness.store.records.map((record) => record.kind),
			history: harness.history.feedback,
		}).toMatchObject({
			rejected: true,
			afterFailure: { invocationId: "invocation-1", state: "terminal-success" },
			later: { outcome: "accepted", sessionId: 1 },
			terminatedLeases: ["lease-2"],
			current: { invocationId: "invocation-3", state: "active" },
			recordKinds: ["continuation-accepted"],
			history: [],
		});
	});

	test("reconciles ambiguous continuation before a later steer", async () => {
		// Purpose: delivery-unknown continuation must become one stopped durable invocation under the same session reference.
		// Input and expected output: ambiguous invocation-2 becomes terminal-aborted, then a later steer continues session 1 as invocation-3.
		// Edge case: compensation produces no feedback and no duplicate logical session.
		// Dependencies: one terminal session and controlled append that writes continuation-accepted before rejecting.
		// Arrange.
		const harness = createHarness();
		harness.catalog.add({ ...activeSession(), state: "terminal-success" });
		harness.coordinator.registerOwner(OWNER);
		harness.invocations.nextAcceptance = {
			invocationId: "invocation-2",
			runtimeLeaseId: "lease-2",
			childPiSessionId: "child-pi-1",
			childSessionDir: "/tmp/child-1",
			childSessionFile: "/tmp/child-1/session.jsonl",
		};
		harness.store.nextAppendFailure = "ambiguous";

		// Act.
		let rejected = false;
		try {
			await harness.coordinator.steer(OWNER, {
				sessionId: 1,
				prompt: "Ambiguous continuation",
			});
		} catch {
			rejected = true;
		}
		const afterFailure = harness.catalog.get(OWNER, 1);
		harness.invocations.nextAcceptance = {
			invocationId: "invocation-3",
			runtimeLeaseId: "lease-3",
			childPiSessionId: "child-pi-1",
			childSessionDir: "/tmp/child-1",
			childSessionFile: "/tmp/child-1/session.jsonl",
		};
		const later = await harness.coordinator.steer(OWNER, {
			sessionId: 1,
			prompt: "Later continuation",
		});

		// Assert.
		expect({
			rejected,
			afterFailure,
			later,
			terminatedLeases: harness.invocations.terminatedLeases,
			current: harness.catalog.get(OWNER, 1),
			recordKinds: harness.store.records.map((record) => record.kind),
			sessionCount: harness.catalog.sessions.length,
			history: harness.history.feedback,
		}).toMatchObject({
			rejected: true,
			afterFailure: { invocationId: "invocation-2", state: "terminal-aborted" },
			later: { outcome: "accepted", sessionId: 1 },
			terminatedLeases: ["lease-2"],
			current: { invocationId: "invocation-3", state: "active" },
			recordKinds: [
				"continuation-accepted",
				"terminal",
				"continuation-accepted",
			],
			sessionCount: 1,
			history: [],
		});
	});

	test("admits one overlapping wait", async () => {
		// Purpose: one owner must never have two eligible active waits.
		// Input and expected output: two same-owner waits race for one active child and exactly one loses with wait_already_active.
		// Edge case: neither call is active before the overlap.
		// Dependencies: controlled pending wait resolver and one active catalog session.
		const harness = createHarness();
		harness.catalog.add(activeSession());
		const outcomes: string[] = [];
		const first = harness.coordinator
			.wait(
				OWNER,
				{ sessionIds: [1], timeoutMs: 100 },
				{ toolCallId: "wait-1", requestId: "request-1" },
			)
			.then((result) => outcomes.push(result.outcome))
			.catch((error: unknown) => {
				outcomes.push(readFailureCode(error));
			});
		const second = harness.coordinator
			.wait(
				OWNER,
				{ sessionIds: [1], timeoutMs: 100 },
				{ toolCallId: "wait-2", requestId: "request-2" },
			)
			.then((result) => outcomes.push(result.outcome))
			.catch((error: unknown) => {
				outcomes.push(readFailureCode(error));
			});
		await Promise.resolve();
		harness.waits.settle(OWNER, { outcome: "timeout" });
		await Promise.allSettled([first, second]);

		expect([...outcomes].sort()).toEqual(["timeout", "wait_already_active"]);
	});

	test("cancels one exact wait before later feedback routes to history", async () => {
		// Purpose: tool abort must remove coordinator admission before resolver rejection so stale feedback cannot be claimed.
		// Input and expected output: two exact cancellations permit readmission; later child success reaches owner history once without a wait claim.
		// Edge case: a stale request correlation cannot cancel the admitted wait.
		// Dependencies: serialized coordinator transitions and controlled wait, history, and journal ports.
		const harness = createHarness();
		const session = activeSession();
		harness.catalog.add(session);
		harness.coordinator.registerOwner(OWNER);
		const firstExecution = {
			toolCallId: "abort-wait-1",
			requestId: "abort-request-1",
			runtimeLeaseId: "abort-lease",
		};
		const firstReason = new Error("cancel first wait");
		const first = harness.coordinator
			.wait(OWNER, { sessionIds: [1], timeoutMs: 100 }, firstExecution)
			.then(() => "normal")
			.catch((error: unknown) => error);
		await Promise.resolve();

		const staleCancelled = await harness.coordinator.cancelWait(
			OWNER,
			{
				...firstExecution,
				requestId: "abort-request-stale",
			},
			new Error("stale wait cancellation"),
		);
		const firstCancelled = await harness.coordinator.cancelWait(
			OWNER,
			firstExecution,
			firstReason,
		);
		if (!firstCancelled) {
			harness.waits.cancelOwner(OWNER);
		}
		const secondExecution = {
			toolCallId: "abort-wait-2",
			requestId: "abort-request-2",
			runtimeLeaseId: "abort-lease",
		};
		const secondReason = new Error("cancel second wait");
		const second = harness.coordinator
			.wait(OWNER, { sessionIds: [1], timeoutMs: 100 }, secondExecution)
			.then(() => "normal")
			.catch((error: unknown) => error);
		await Promise.resolve();
		const secondCancelled = await harness.coordinator.cancelWait(
			OWNER,
			secondExecution,
			secondReason,
		);
		if (!secondCancelled) {
			harness.waits.cancelOwner(OWNER);
		}
		await harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: session.invocationId,
			status: "success",
			text: "later feedback",
		});

		expect({
			staleCancelled,
			firstCancelled,
			secondCancelled,
			firstUsedOriginalReason: (await first) === firstReason,
			secondUsedOriginalReason: (await second) === secondReason,
			waitClaims: harness.store.records.filter(
				(record) => record.kind === "wait-claimed",
			).length,
			history: harness.history.feedback.map((feedback) =>
				feedback.status === "success" ? feedback.output : feedback.error,
			),
		}).toEqual({
			staleCancelled: false,
			firstCancelled: true,
			secondCancelled: true,
			firstUsedOriginalReason: true,
			secondUsedOriginalReason: true,
			waitClaims: 0,
			history: ["later feedback"],
		});
	});

	test("lets serialized feedback win before a racing wait cancellation", async () => {
		// Purpose: feedback and abort must share one transition order without duplicate or lost delivery.
		// Input and expected output: feedback enqueued first settles the wait once; the later exact cancellation reports no match.
		// Edge case: cancellation uses the complete correlation that was valid before feedback committed.
		// Dependencies: serialized coordinator transitions and controlled wait, history, and journal ports.
		const harness = createHarness();
		const session = activeSession();
		harness.catalog.add(session);
		harness.coordinator.registerOwner(OWNER);
		const execution = {
			toolCallId: "race-wait",
			requestId: "race-request",
		};
		const wait = harness.coordinator.wait(
			OWNER,
			{ sessionIds: [1], timeoutMs: 100 },
			execution,
		);
		await Promise.resolve();

		const feedback = harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: session.invocationId,
			status: "success",
			text: "race feedback",
		});
		const cancellation = harness.coordinator.cancelWait(
			OWNER,
			execution,
			new Error("late cancellation"),
		);
		await feedback;

		expect({
			result: await wait,
			cancelled: await cancellation,
			settlements: harness.waits.settled.length,
			waitClaims: harness.store.records.filter(
				(record) => record.kind === "wait-claimed",
			).length,
			history: harness.history.feedback.length,
		}).toEqual({
			result: {
				outcome: "feedback",
				sessionId: 1,
				status: "success",
				elapsedSeconds: 1,
				output: "race feedback",
			},
			cancelled: false,
			settlements: 1,
			waitClaims: 1,
			history: 0,
		});
	});

	test("removes owner-cancelled wait admission before later readmission", async () => {
		// Purpose: owner shutdown must remove authoritative wait admission before canceling its resolver.
		// Input and expected output: a canceled wait rejects, then the same owner admits a new wait and receives one feedback result.
		// Edge case: the canceled wait cannot settle from later child feedback or claim a second destination.
		// Dependencies: controlled wait cancellation, forced abort, and one resumed active session.
		// Arrange.
		const harness = createHarness();
		harness.catalog.add(activeSession());

		// Act.
		const outcome = await exerciseCanceledWaitReadmission(harness, () =>
			harness.coordinator.shutdown(OWNER),
		);

		// Assert.
		expect({
			outcome,
			cancelledOwners: harness.waits.cancelledOwners,
			settled: harness.waits.settled,
			history: harness.history.feedback,
			journalKinds: harness.store.records.map((record) => record.kind),
		}).toEqual({
			outcome: {
				cancelledWaits: 1,
				staleSettlements: 0,
				result: {
					outcome: "feedback",
					sessionId: 2,
					status: "success",
					elapsedSeconds: 1,
					output: "resumed result",
				},
			},
			cancelledOwners: [OWNER.ownerPiSessionId],
			settled: [
				{
					outcome: "feedback",
					sessionId: 2,
					status: "success",
					elapsedSeconds: 1,
					output: "resumed result",
				},
			],
			history: [],
			journalKinds: ["terminal", "terminal", "wait-claimed"],
		});
	});

	test("removes lease-cancelled wait admission before later readmission", async () => {
		// Purpose: runtime fail-stop must remove authoritative wait admission before canceling the failed lease resolver.
		// Input and expected output: a lease-canceled wait rejects, then the same owner admits a new wait and receives one feedback result.
		// Edge case: forced abort of the first child cannot settle the canceled wait or create history feedback.
		// Dependencies: one lease-owned active session and controlled runtime failure.
		// Arrange.
		const harness = createHarness();
		const failedLeaseId = "failed-owner-lease";
		harness.catalog.add({
			...activeSession(),
			ownerRuntimeLeaseId: failedLeaseId,
		});

		// Act.
		const outcome = await exerciseCanceledWaitReadmission(
			harness,
			() =>
				harness.coordinator.observeRuntimeFailure({
					runtimeLeaseId: failedLeaseId,
					reason: "channel_disconnected",
				}),
			failedLeaseId,
		);

		// Assert.
		expect({
			outcome,
			cancelledLeases: harness.waits.cancelledLeases,
			terminatedLeases: harness.invocations.terminatedLeases,
			settled: harness.waits.settled,
			history: harness.history.feedback,
			journalKinds: harness.store.records.map((record) => record.kind),
		}).toEqual({
			outcome: {
				cancelledWaits: 1,
				staleSettlements: 0,
				result: {
					outcome: "feedback",
					sessionId: 2,
					status: "success",
					elapsedSeconds: 1,
					output: "resumed result",
				},
			},
			cancelledLeases: [failedLeaseId, "lease-1"],
			terminatedLeases: [failedLeaseId],
			settled: [
				{
					outcome: "feedback",
					sessionId: 2,
					status: "success",
					elapsedSeconds: 1,
					output: "resumed result",
				},
			],
			history: [],
			journalKinds: ["terminal", "terminal", "wait-claimed"],
		});
	});

	test("gives known non-owned wait IDs precedence over unknown IDs", async () => {
		// Purpose: mixed wait identity failures must be independent from request order.
		// Input and expected output: both mixed orders return not_owner while an unknown-only request returns unknown_session.
		// Edge case: failed validation cannot admit a wait or mutate session, invocation, feedback, or child state.
		// Dependencies: one known foreign catalog session and in-memory coordinator ports.
		// Arrange.
		const harness = createHarness();
		const foreignSession = {
			...activeSession(),
			key: {
				ownerPiSessionId: "other-owner",
				ownerLocalSessionId: 1,
			},
		};
		harness.catalog.add(foreignSession);
		const codes: string[] = [];

		// Act.
		for (const [index, sessionIds] of [[99, 1], [1, 99], [99]].entries()) {
			try {
				await harness.coordinator.wait(
					OWNER,
					{ sessionIds, timeoutMs: 100 },
					{
						toolCallId: `wait-${index}`,
						requestId: `request-${index}`,
					},
				);
			} catch (error) {
				codes.push(readFailureCode(error));
			}
		}

		// Assert.
		expect(codes).toEqual(["not_owner", "not_owner", "unknown_session"]);
		expect({
			sessions: harness.catalog.sessions,
			invocationActive: harness.invocations.active,
			steerCalls: harness.invocations.steerCalls,
			continueCalls: harness.invocations.continueCalls,
			journalRecords: harness.store.records,
			historyFeedbackIds: [...harness.store.historyFeedbackIds],
			waitFeedbackIds: [...harness.store.waitFeedbackIds],
			history: harness.history.feedback,
			waitAdmission: harness.waits.admission,
			waitSettled: harness.waits.settled,
		}).toEqual({
			sessions: [foreignSession],
			invocationActive: false,
			steerCalls: [],
			continueCalls: [],
			journalRecords: [],
			historyFeedbackIds: [],
			waitFeedbackIds: [],
			history: [],
			waitAdmission: undefined,
			waitSettled: [],
		});
	});

	test("claims feedback observed before expiry despite terminal persistence latency", async () => {
		// Purpose: wait eligibility must use serialized terminal observation time rather than persistence completion time.
		// Input and expected output: feedback enters at 50 before deadline 100, terminal persistence completes after 100, and the wait receives feedback.
		// Edge case: terminal and wait-claimed durability still precede settlement while history remains empty.
		// Dependencies: mutable monotonic clock, controlled append gate, and wait runtime fake.
		let now = 0;
		const harness = createHarness(() => now);
		harness.catalog.add(activeSession());
		let releaseAppend = (): void => {};
		let reportAppendStarted = (): void => {};
		const appendStarted = new Promise<void>((resolve) => {
			reportAppendStarted = resolve;
		});
		harness.store.appendGate = new Promise<void>((resolve) => {
			releaseAppend = resolve;
		});
		harness.store.onAppend = (record) => {
			if (record.kind === "terminal") {
				reportAppendStarted();
			}
		};
		harness.coordinator
			.wait(
				OWNER,
				{ sessionIds: [1], timeoutMs: 100 },
				{ toolCallId: "wait-latency", requestId: "request-latency" },
			)
			.catch(() => undefined);
		await Promise.resolve();
		now = 50;
		const observation = harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: "invocation-1",
			status: "success",
			text: "persisted late",
		});
		await appendStarted;
		now = 101;
		releaseAppend();
		await observation;

		expect({
			recordKinds: harness.store.records.map((record) => record.kind),
			settlements: harness.waits.settled,
			history: harness.history.feedback,
		}).toEqual({
			recordKinds: ["terminal", "wait-claimed"],
			settlements: [
				{
					outcome: "feedback",
					sessionId: 1,
					status: "success",
					elapsedSeconds: 1,
					output: "persisted late",
				},
			],
			history: [],
		});
	});

	test("commits one finalized terminal snapshot to wait evidence", async () => {
		// Purpose: feedback selected by a wait must carry one authoritative terminal presentation snapshot without a preceding metadata append.
		// Input and expected output: final context and projection facts enter the terminal record, wait evidence, and no history destination.
		// Edge case: elapsed wait uses terminal observation time while invocation elapsed uses the accepted start time.
		// Dependencies: mutable coordinator clock, controlled wait resolver, and append-order journal fake.
		let now = 0;
		const harness = createHarness(() => now);
		harness.catalog.add({
			...activeSession(),
			invocationMetadata: {
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 15,
				modelId: "openai/test-model",
				thinking: "high",
				contextWindow: 128_000,
			},
		} as unknown as LogicalSession);
		const wait = harness.coordinator.wait(
			OWNER,
			{ sessionIds: [1], timeoutMs: 100 },
			{ toolCallId: "wait-1", requestId: "request-1" },
		);
		await Promise.resolve();
		now = 15.75;
		try {
			await harness.coordinator.observeInvocation({
				kind: "terminal",
				invocationId: "invocation-1",
				status: "success",
				text: "done",
				contextTokens: 58_000,
				projectionSavedTokens: 20_000,
			} as InvocationEvent);
		} catch {}
		const result = await wait.catch(() => undefined);
		const evidence = harness.coordinator.takeWaitEvidence("wait-1");
		const terminal = harness.store.records.find(
			(record) => record.kind === "terminal",
		);

		expect({
			recordKinds: harness.store.records.map((record) => record.kind),
			terminal,
			result,
			evidence,
			history: harness.history.feedback,
		}).toEqual({
			recordKinds: ["terminal", "wait-claimed"],
			terminal: expect.objectContaining({
				kind: "terminal",
				feedback: expect.objectContaining({
					status: "success",
					output: "done",
					presentation: {
						agentId: "SubAgentCoder",
						taskName: "Trace runtime",
						invocationMetadata: {
							startedAtMs: 1_700_000_000_000,
							elapsedMs: 15,
							modelId: "openai/test-model",
							thinking: "high",
							contextWindow: 128_000,
							contextTokens: 58_000,
							projectionSavedTokens: 20_000,
						},
					},
				}),
			}),
			result: {
				outcome: "feedback",
				sessionId: 1,
				status: "success",
				elapsedSeconds: 1,
				output: "done",
			},
			evidence: {
				presentationKind: "wait-feedback",
				feedbackId: "invocation-1:feedback",
				invocationId: "invocation-1",
				waitRequestId: "request-1",
				waitElapsedMs: 15,
				feedback: expect.objectContaining({
					status: "success",
					output: "done",
					presentation: expect.any(Object),
				}),
			},
			history: [],
		});
	});

	test("selects accepted exit before terminal", async () => {
		// Purpose: accepted process exit observed first must select one terminal-failure outcome.
		// Input and expected output: exit code 9 precedes a late normal success event and creates one failure feedback obligation.
		// Edge case: the late normal event cannot replace state or create a second feedback.
		// Dependencies: deterministic event calls against one active session.
		const harness = createHarness();
		harness.catalog.add(activeSession());
		harness.coordinator.registerOwner(OWNER);
		for (const event of [
			{
				kind: "accepted-exit" as const,
				invocationId: "invocation-1",
				exitCode: 9,
				signal: null,
			},
			{
				kind: "terminal" as const,
				invocationId: "invocation-1",
				status: "success" as const,
				text: "late success",
			},
		]) {
			try {
				await harness.coordinator.observeInvocation(event);
			} catch {}
		}
		const terminalRecords = harness.store.records.filter(
			(record) => record.kind === "terminal",
		);

		expect(
			terminalRecords.map((record) =>
				record.kind === "terminal"
					? {
							state: record.state,
							status: record.feedback?.status,
							error:
								record.feedback !== undefined &&
								record.feedback.status !== "success"
									? record.feedback.error
									: undefined,
						}
					: undefined,
			),
		).toEqual([
			{
				state: "terminal-failure",
				status: "failure",
				error: "Subagent stopped before completing the task",
			},
		]);
	});

	test("steers active sessions and continues terminal sessions", async () => {
		// Purpose: steer must preserve one logical ID while selecting active RPC or terminal continuation.
		// Input and expected output: active session 1 accepts direct steering, then terminal session 1 accepts a new invocation.
		// Edge case: continuation changes invocation identity without allocating session 2.
		// Dependencies: controlled invocation port and mutable in-memory catalog.
		const harness = createHarness();
		harness.catalog.add(activeSession());
		harness.coordinator.registerOwner(OWNER);
		const activeResult = await harness.coordinator.steer(OWNER, {
			sessionId: 1,
			prompt: "Change direction",
		});
		harness.catalog.update(activeSession().key, { state: "terminal-success" });
		harness.invocations.nextAcceptance = {
			...harness.invocations.nextAcceptance,
			invocationId: "invocation-2",
			runtimeLeaseId: "lease-2",
		};
		const terminalResult = await harness.coordinator.steer(OWNER, {
			sessionId: 1,
			prompt: "Continue saved work",
		});

		expect({
			activeResult,
			terminalResult,
			steerCalls: harness.invocations.steerCalls,
			continueCalls: harness.invocations.continueCalls,
			sessions: harness.catalog.list(OWNER).map((session) => ({
				id: session.key.ownerLocalSessionId,
				invocationId: session.invocationId,
				state: session.state,
			})),
		}).toEqual({
			activeResult: { outcome: "accepted", sessionId: 1 },
			terminalResult: { outcome: "accepted", sessionId: 1 },
			steerCalls: ["Change direction"],
			continueCalls: ["Continue saved work"],
			sessions: [{ id: 1, invocationId: "invocation-2", state: "active" }],
		});
	});

	test("routes management messages by complete descendant identity", async () => {
		// Purpose: user management messages must distinguish repeated owner-local IDs at arbitrary descendant depth.
		// Input and expected output: stable key `{ child-pi-1, 1 }` steers the nested invocation instead of root owner session 1.
		// Edge case: both logical sessions expose owner-local ID 1, so a flat-ID route would target the wrong process.
		// Dependencies: coordinator-owned catalog resolution and the existing active steer path.
		// ARRANGE: seed one root session and its direct nested child with the same local ID.
		const harness = createHarness();
		const root = activeSession(1);
		const nested: LogicalSession = {
			...activeSession(1),
			key: {
				ownerPiSessionId: root.childPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "nested-child-pi",
			childSessionDir: "/tmp/nested-child",
			childSessionFile: "/tmp/nested-child/session.jsonl",
			invocationId: "nested-invocation",
			runtimeLeaseId: "nested-lease",
		};
		harness.catalog.add(root);
		harness.catalog.add(nested);
		harness.coordinator.registerOwner(OWNER);

		// ACT: submit through the stable-key management path.
		const result = await harness.coordinator.submitManagementMessage(
			nested.key,
			"Message the nested descendant",
		);

		// ASSERT: acceptance retains the owner-local label while the nested invocation receives the message.
		expect({
			result,
			steerCalls: harness.invocations.steerCalls,
		}).toEqual({
			result: { outcome: "accepted", sessionId: 1 },
			steerCalls: ["Message the nested descendant"],
		});
	});

	test("refreshes nested continuation ownership for current-parent fail-stop", async () => {
		// Purpose: a saved nested session must move from its old parent lease to the current continuation scope.
		// Input and expected output: continuation under new-parent updates live and journal ownership; failure aborts live and durable state, wait is immediate, and later steer continues once.
		// Edge case: broken current behavior admits a wait, so cleanup cancels that wait only after stale-state evidence is captured.
		// Dependencies: production coordinator continuation, fail-stop membership, journal records, wait admission, and serialized public steer.
		// Arrange.
		const harness = createHarness();
		const nestedSession: LogicalSession = {
			...activeSession(1),
			invocationId: "nested-old-invocation",
			runtimeLeaseId: "nested-old-lease",
			ownerRuntimeLeaseId: "old-parent-lease",
			state: "terminal-success",
		};
		harness.catalog.add(nestedSession);
		harness.coordinator.registerOwner(OWNER);
		harness.invocations.nextAcceptance = {
			invocationId: "nested-current-invocation",
			runtimeLeaseId: "nested-current-lease",
			childPiSessionId: nestedSession.childPiSessionId,
			childSessionDir: nestedSession.childSessionDir,
			childSessionFile: nestedSession.childSessionFile,
		};

		// Act.
		const firstContinuation = await harness.coordinator.steer(
			OWNER,
			{ sessionId: 1, prompt: "Continue under current parent" },
			{ ownerRuntimeLeaseId: "new-parent-lease" },
		);
		const continued = harness.catalog.get(OWNER, 1);
		const firstContinuationRecord = harness.store.records.find(
			(record) => record.kind === "continuation-accepted",
		);
		await harness.coordinator.observeRuntimeFailure({
			runtimeLeaseId: "new-parent-lease",
			reason: "channel_disconnected",
		});
		const afterFailure = harness.catalog.get(OWNER, 1);
		const recordsAfterFailure = [...harness.store.records];
		const terminatedAfterFailure = [...harness.invocations.terminatedLeases];
		let waitOutcome = "";
		const waitResult = harness.coordinator
			.wait(
				OWNER,
				{ sessionIds: [1], timeoutMs: 1 },
				{ toolCallId: "wait-stopped", requestId: "wait-stopped" },
			)
			.then((result) => {
				waitOutcome = result.outcome;
			})
			.catch((error: unknown) => {
				waitOutcome = error instanceof Error ? error.message : String(error);
			});
		await Promise.resolve();
		const waitAdmitted = harness.waits.admission !== undefined;
		if (waitAdmitted) {
			await harness.coordinator.shutdown(OWNER);
		}
		await waitResult;
		harness.invocations.nextAcceptance = {
			invocationId: "nested-later-invocation",
			runtimeLeaseId: "nested-later-lease",
			childPiSessionId: nestedSession.childPiSessionId,
			childSessionDir: nestedSession.childSessionDir,
			childSessionFile: nestedSession.childSessionFile,
		};
		const laterContinuation = await harness.coordinator.steer(
			OWNER,
			{ sessionId: 1, prompt: "Continue after fail-stop" },
			{ ownerRuntimeLeaseId: "later-parent-lease" },
		);

		// Assert.
		expect({
			firstContinuation,
			continuedOwnerLease: continued?.ownerRuntimeLeaseId,
			durableOwnerLease:
				firstContinuationRecord === undefined
					? undefined
					: Reflect.get(firstContinuationRecord, "ownerRuntimeLeaseId"),
			afterFailureState: afterFailure?.state,
			terminalState: recordsAfterFailure.find(
				(record) => record.kind === "terminal",
			)?.state,
			terminatedAfterFailure,
			waitAdmitted,
			waitOutcome,
			laterContinuation,
			continueCalls: harness.invocations.continueCalls,
			activeSteerCalls: harness.invocations.steerCalls,
			sameSessionFile:
				harness.catalog.get(OWNER, 1)?.childSessionFile ===
				nestedSession.childSessionFile,
		}).toEqual({
			firstContinuation: { outcome: "accepted", sessionId: 1 },
			continuedOwnerLease: "new-parent-lease",
			durableOwnerLease: "new-parent-lease",
			afterFailureState: "terminal-aborted",
			terminalState: "terminal-aborted",
			terminatedAfterFailure: ["new-parent-lease"],
			waitAdmitted: false,
			waitOutcome: "no_active_sessions",
			laterContinuation: { outcome: "accepted", sessionId: 1 },
			continueCalls: [
				"Continue under current parent",
				"Continue after fail-stop",
			],
			activeSteerCalls: [],
			sameSessionFile: true,
		});
	});

	test("fail-stops the complete transitive runtime lease closure", async () => {
		// Purpose: one failed owner channel must stop every active logical descendant without intermediate owner_stopping messages.
		// Input and expected output: root-to-A-to-B-to-C ownership aborts all three sessions, cancels all lease waits, and releases every writer before reconciliation.
		// Edge case: C is two ownership edges below the failed A lease and must not survive immediate-only selection.
		// Dependencies: coordinator ownership traversal, invocation fail-stop, wait cancellation, writer release, and offline reconciliation.
		// Arrange.
		const harness = createHarness();
		const ownerA: OwnerIdentity = {
			ownerPiSessionId: "child-a",
			ownerSessionFile: "/tmp/child-a.jsonl",
		};
		const ownerB: OwnerIdentity = {
			ownerPiSessionId: "child-b",
			ownerSessionFile: "/tmp/child-b.jsonl",
		};
		const sessions: LogicalSession[] = [
			{
				...activeSession(1),
				childPiSessionId: ownerA.ownerPiSessionId,
				invocationId: "invocation-a",
				runtimeLeaseId: "lease-a",
			},
			{
				...activeSession(1),
				key: {
					ownerPiSessionId: ownerA.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: ownerB.ownerPiSessionId,
				invocationId: "invocation-b",
				runtimeLeaseId: "lease-b",
				ownerRuntimeLeaseId: "lease-a",
			},
			{
				...activeSession(1),
				key: {
					ownerPiSessionId: ownerB.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: "child-c",
				invocationId: "invocation-c",
				runtimeLeaseId: "lease-c",
				ownerRuntimeLeaseId: "lease-b",
			},
		];
		for (const session of sessions) {
			harness.catalog.add(session);
		}
		for (const owner of [OWNER, ownerA, ownerB]) {
			harness.coordinator.registerOwner(owner);
		}
		for (const [runtimeLeaseId, owner] of [
			["lease-a", ownerA],
			["lease-b", ownerB],
			[
				"lease-c",
				{
					ownerPiSessionId: "child-c",
					ownerSessionFile: "/tmp/child-c.jsonl",
				},
			],
		] as const) {
			harness.store.remoteOwners.set(runtimeLeaseId, owner);
		}

		// Act.
		await recoverRuntimeFailure(harness.coordinator, harness.store, {
			runtimeLeaseId: "lease-a",
			reason: "channel_disconnected",
		});

		// Assert.
		expect({
			states: sessions.map(
				(session) =>
					harness.catalog.get(
						{
							ownerPiSessionId: session.key.ownerPiSessionId,
							ownerSessionFile: "",
						},
						session.key.ownerLocalSessionId,
					)?.state,
			),
			terminalInvocations: harness.store.records.flatMap((record) =>
				record.kind === "terminal" ? [record.invocationId] : [],
			),
			cancelledLeases: harness.waits.cancelledLeases,
			terminatedLeases: harness.invocations.terminatedLeases,
			releasedLeases: harness.store.releasedLeases,
			reconciledOwners: harness.store.reconciledOwners,
			reconciledAfterCompleteRelease:
				harness.store.reconciledAfterCompleteRelease,
		}).toEqual({
			states: ["terminal-aborted", "terminal-aborted", "terminal-aborted"],
			terminalInvocations: ["invocation-a", "invocation-b", "invocation-c"],
			cancelledLeases: ["lease-a", "lease-b", "lease-c"],
			terminatedLeases: ["lease-a"],
			releasedLeases: ["lease-a", "lease-b", "lease-c"],
			reconciledOwners: ["child-a", "child-b", "child-c"],
			reconciledAfterCompleteRelease: [true, true, true],
		});
	});

	test("preserves a normal descendant while fail-stopping through its lease", async () => {
		// Purpose: a normal-first intermediate descendant must remain authoritative while its active child is still reached transitively.
		// Input and expected output: B completes once, then A failure aborts A and C without a second B terminal record or feedback delivery.
		// Edge case: terminal B remains the only ownership bridge from failed lease A to active lease C.
		// Dependencies: serialized terminal precedence, ownership closure traversal, forced-abort withholding, and history disposition.
		const harness = createHarness();
		const ownerA: OwnerIdentity = {
			ownerPiSessionId: "normal-child-a",
			ownerSessionFile: "/tmp/normal-child-a.jsonl",
		};
		const ownerB: OwnerIdentity = {
			ownerPiSessionId: "normal-child-b",
			ownerSessionFile: "/tmp/normal-child-b.jsonl",
		};
		const sessionA: LogicalSession = {
			...activeSession(1),
			childPiSessionId: ownerA.ownerPiSessionId,
			invocationId: "normal-invocation-a",
			runtimeLeaseId: "normal-lease-a",
		};
		const sessionB: LogicalSession = {
			...activeSession(1),
			key: {
				ownerPiSessionId: ownerA.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: ownerB.ownerPiSessionId,
			invocationId: "normal-invocation-b",
			runtimeLeaseId: "normal-lease-b",
			ownerRuntimeLeaseId: "normal-lease-a",
		};
		const sessionC: LogicalSession = {
			...activeSession(1),
			key: {
				ownerPiSessionId: ownerB.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "normal-child-c",
			invocationId: "normal-invocation-c",
			runtimeLeaseId: "normal-lease-c",
			ownerRuntimeLeaseId: "normal-lease-b",
		};
		for (const session of [sessionA, sessionB, sessionC]) {
			harness.catalog.add(session);
		}
		for (const owner of [OWNER, ownerA, ownerB]) {
			harness.coordinator.registerOwner(owner);
		}

		await harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: sessionB.invocationId,
			status: "success",
			text: "B completed normally",
		});
		await harness.coordinator.observeRuntimeFailure({
			runtimeLeaseId: sessionA.runtimeLeaseId,
			reason: "channel_disconnected",
		});

		const terminalRecords = harness.store.records.filter(
			(record) => record.kind === "terminal",
		);
		expect({
			states: [sessionA, sessionB, sessionC].map(
				(session) =>
					harness.catalog.get(
						{
							ownerPiSessionId: session.key.ownerPiSessionId,
							ownerSessionFile: "",
						},
						session.key.ownerLocalSessionId,
					)?.state,
			),
			bTerminals: terminalRecords.filter(
				(record) => record.invocationId === sessionB.invocationId,
			).length,
			bFeedback: harness.history.feedback.filter(
				(feedback) => feedback.invocationId === sessionB.invocationId,
			).length,
			cForcedAbort: terminalRecords.some(
				(record) =>
					record.invocationId === sessionC.invocationId &&
					record.state === "terminal-aborted",
			),
		}).toEqual({
			states: ["terminal-aborted", "terminal-success", "terminal-aborted"],
			bTerminals: 1,
			bFeedback: 1,
			cForcedAbort: true,
		});
	});

	test("rejects descendant operations queued behind fail-stop", async () => {
		// Purpose: a failed closure lease must not accept new descendant coordination after confirmed teardown.
		// Input and expected output: start under lease A queues during teardown, then start, steer, and wait all reject before their runtime ports mutate.
		// Edge case: the start entered the coordinator after failure invalidated A but before teardown completed.
		// Dependencies: serialized coordinator transitions, closure lease invalidation, and nested operation admission.
		const harness = createHarness();
		const sessionA = activeSession(1);
		harness.catalog.add(sessionA);
		harness.coordinator.registerOwner(OWNER);
		let releaseTeardown = (): void => undefined;
		harness.invocations.terminateGate = new Promise<void>((resolve) => {
			releaseTeardown = resolve;
		});
		const failure = harness.coordinator.observeRuntimeFailure({
			runtimeLeaseId: sessionA.runtimeLeaseId,
			reason: "channel_disconnected",
		});
		while (harness.invocations.terminatedLeases.length === 0) {
			await Promise.resolve();
		}
		let startFailure = "";
		const queuedStart = harness.coordinator
			.start(
				{
					ownerPiSessionId: sessionA.childPiSessionId,
					ownerSessionFile: sessionA.childSessionFile,
				},
				{
					agentId: "SubAgentCoder",
					taskName: "Queued descendant",
					prompt: "Must not start",
				},
				{ ownerRuntimeLeaseId: sessionA.runtimeLeaseId },
			)
			.catch((error: unknown) => {
				startFailure = error instanceof Error ? error.message : String(error);
			});
		releaseTeardown();
		await Promise.all([failure, queuedStart]);
		let steerFailure = "";
		await harness.coordinator
			.steer(
				OWNER,
				{ sessionId: 1, prompt: "Must not steer" },
				{ ownerRuntimeLeaseId: sessionA.runtimeLeaseId },
			)
			.catch((error: unknown) => {
				steerFailure = error instanceof Error ? error.message : String(error);
			});
		let waitFailure = "";
		const stoppedWait = harness.coordinator
			.wait(
				OWNER,
				{ sessionIds: [1], timeoutMs: 100 },
				{
					toolCallId: "stopped-wait",
					requestId: "stopped-wait",
					runtimeLeaseId: sessionA.runtimeLeaseId,
				},
			)
			.catch((error: unknown) => {
				waitFailure = error instanceof Error ? error.message : String(error);
			});
		await Promise.resolve();
		const waitAdmitted = harness.waits.admission !== undefined;
		if (waitAdmitted) {
			await harness.coordinator.shutdown(OWNER);
		}
		await stoppedWait;

		expect({
			startCalls: harness.invocations.startCalls,
			continueCalls: harness.invocations.continueCalls,
			waitAdmitted,
			startFailure,
			steerFailure,
			waitFailure,
		}).toEqual({
			startCalls: 0,
			continueCalls: [],
			waitAdmitted: false,
			startFailure: "[start_failed] Subagent operation is no longer available",
			steerFailure:
				"[message_rejected] Subagent operation is no longer available",
			waitFailure:
				"[message_rejected] Subagent operation is no longer available",
		});
	});

	test("keeps root continuation ownership unchanged", async () => {
		// Purpose: current-parent lease reassignment applies only to nested callers.
		// Input and expected output: root terminal continuation remains without ownerRuntimeLeaseId in live and durable state.
		// Edge case: the same continuation update path writes invocation and runtime lease changes.
		// Dependencies: production terminal steer and continuation journal publication.
		const harness = createHarness();
		const rootSession = {
			...activeSession(1),
			invocationId: "root-old-invocation",
			runtimeLeaseId: "root-old-lease",
			state: "terminal-success" as const,
		};
		harness.catalog.add(rootSession);
		harness.coordinator.registerOwner(OWNER);
		await harness.coordinator.steer(OWNER, {
			sessionId: 1,
			prompt: "Continue root session",
		});
		const continuation = harness.store.records.find(
			(record) => record.kind === "continuation-accepted",
		);

		expect({
			liveOwnerLease: harness.catalog.get(OWNER, 1)?.ownerRuntimeLeaseId,
			durableOwnerLease:
				continuation === undefined
					? undefined
					: Reflect.get(continuation, "ownerRuntimeLeaseId"),
		}).toEqual({
			liveOwnerLease: undefined,
			durableOwnerLease: undefined,
		});
	});

	test("applies offline reconciliation state to the live catalog", async () => {
		// Purpose: fail-stop recovery must project reconstructed terminal state into the current coordinator catalog.
		// Input and expected output: stale active live state becomes the terminal-aborted state returned by offline reconciliation.
		// Edge case: the failed lease does not match stale owner metadata, so only reconciliation can repair the live state.
		// Dependencies: production runtime-failure ordering and coordinator catalog refresh.
		const harness = createHarness();
		const staleSession: LogicalSession = {
			...activeSession(1),
			invocationId: "stale-invocation",
			runtimeLeaseId: "stale-runtime-lease",
			ownerRuntimeLeaseId: "old-parent-lease",
		};
		harness.catalog.add(staleSession);
		harness.coordinator.registerOwner(OWNER);
		await recoverRuntimeFailure(
			harness.coordinator,
			{
				releaseRemoteLease: () => [OWNER],
				reconcileOffline: async () => [
					{ ...staleSession, state: "terminal-aborted" as const },
				],
			},
			{
				runtimeLeaseId: "new-parent-lease",
				reason: "channel_disconnected",
			},
		);

		expect({
			state: harness.catalog.get(OWNER, 1)?.state,
			terminatedLeases: harness.invocations.terminatedLeases,
		}).toEqual({
			state: "terminal-aborted",
			terminatedLeases: ["new-parent-lease"],
		});
	});

	test("skips stale reconciliation after a newer continuation", async () => {
		// Purpose: a delayed offline projection must not replace a continuation accepted after fail-stop began.
		// Input and expected output: current-parent failure terminalizes the old invocation, later steer activates a new invocation, and released stale reconstruction leaves it active.
		// Edge case: reconciliation starts before the later continuation but returns its old terminal snapshot afterward.
		// Dependencies: production recovery ordering, coordinator transition serialization, and invocation-qualified catalog projection.
		const harness = createHarness();
		const failedSession: LogicalSession = {
			...activeSession(1),
			invocationId: "failed-invocation",
			runtimeLeaseId: "failed-child-lease",
			ownerRuntimeLeaseId: "failed-parent-lease",
		};
		harness.catalog.add(failedSession);
		harness.coordinator.registerOwner(OWNER);
		let markReconciliationStarted: () => void = () => undefined;
		const reconciliationStarted = new Promise<void>((resolve) => {
			markReconciliationStarted = resolve;
		});
		let releaseReconciliation: () => void = () => undefined;
		const reconciliationGate = new Promise<void>((resolve) => {
			releaseReconciliation = resolve;
		});
		const recovery = recoverRuntimeFailure(
			harness.coordinator,
			{
				releaseRemoteLease: () => [OWNER],
				reconcileOffline: async () => {
					markReconciliationStarted();
					await reconciliationGate;
					return [{ ...failedSession, state: "terminal-aborted" as const }];
				},
			},
			{
				runtimeLeaseId: "failed-parent-lease",
				reason: "channel_disconnected",
			},
		);
		await reconciliationStarted;
		harness.invocations.nextAcceptance = {
			invocationId: "later-invocation",
			runtimeLeaseId: "later-child-lease",
			childPiSessionId: failedSession.childPiSessionId,
			childSessionDir: failedSession.childSessionDir,
			childSessionFile: failedSession.childSessionFile,
		};
		const laterContinuation = await harness.coordinator.steer(
			OWNER,
			{ sessionId: 1, prompt: "Continue during reconciliation" },
			{ ownerRuntimeLeaseId: "later-parent-lease" },
		);
		const beforeStaleProjection = harness.catalog.get(OWNER, 1);
		releaseReconciliation();
		await recovery;
		const afterStaleProjection = harness.catalog.get(OWNER, 1);

		expect({
			laterContinuation,
			before: {
				invocationId: beforeStaleProjection?.invocationId,
				ownerRuntimeLeaseId: beforeStaleProjection?.ownerRuntimeLeaseId,
				state: beforeStaleProjection?.state,
			},
			after: {
				invocationId: afterStaleProjection?.invocationId,
				ownerRuntimeLeaseId: afterStaleProjection?.ownerRuntimeLeaseId,
				state: afterStaleProjection?.state,
			},
		}).toEqual({
			laterContinuation: { outcome: "accepted", sessionId: 1 },
			before: {
				invocationId: "later-invocation",
				ownerRuntimeLeaseId: "later-parent-lease",
				state: "active",
			},
			after: {
				invocationId: "later-invocation",
				ownerRuntimeLeaseId: "later-parent-lease",
				state: "active",
			},
		});
	});

	test("routes feedback at the timeout boundary to history", async () => {
		// Purpose: feedback observed at expiresAt must lose to timeout and cannot settle the wait.
		// Input and expected output: selected child completes at time 110 for a wait admitted at 10 with timeout 100.
		// Edge case: history receives the feedback once and the wait later resolves only as timeout.
		// Dependencies: mutable monotonic clock and explicit fake deadline callback.
		let now = 10;
		const harness = createHarness(() => now);
		harness.catalog.add(activeSession());
		harness.coordinator.registerOwner(OWNER);
		const wait = harness.coordinator.wait(
			OWNER,
			{ sessionIds: [1], timeoutMs: 100 },
			{ toolCallId: "wait-boundary", requestId: "request-boundary" },
		);
		await Promise.resolve();
		now = 110;
		await harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: "invocation-1",
			status: "success",
			text: "at boundary",
		});
		harness.waits.expire();
		const result = await wait;

		expect({
			result,
			historyStatuses: harness.history.feedback.map(
				(feedback) => feedback.status,
			),
			settlements: harness.waits.settled,
		}).toEqual({
			result: { outcome: "timeout" },
			historyStatuses: ["success"],
			settlements: [{ outcome: "timeout" }],
		});
	});

	test("allows owner shutdown reentry during process teardown", async () => {
		// Purpose: process teardown must not retain the coordinator queue needed by a worker's owner_stopping request.
		// Input and expected output: root shutdown starts lease termination, whose nested owner shutdown settles before root shutdown completes.
		// Edge case: the nested owner has no descendants, matching a worker that only needs its stopping acknowledgment.
		// Dependencies: serialized logical shutdown, controlled invocation termination, and reentrant owner shutdown.
		const harness = createHarness();
		const session = activeSession();
		const childOwner: OwnerIdentity = {
			ownerPiSessionId: session.childPiSessionId,
			ownerSessionFile: session.childSessionFile,
		};
		harness.catalog.add(session);
		let markTeardownEntered = (): void => {
			throw new Error("teardown entry signal was not initialized");
		};
		const teardownEntered = new Promise<void>((resolve) => {
			markTeardownEntered = resolve;
		});
		let nestedShutdownSettled = false;
		harness.invocations.terminateAction = async () => {
			markTeardownEntered();
			await harness.coordinator.shutdown(childOwner);
			nestedShutdownSettled = true;
		};

		const rootShutdown = harness.coordinator.shutdown(OWNER);
		await teardownEntered;
		// A full event-loop turn lets an independently admitted owner shutdown settle.
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(nestedShutdownSettled).toBe(true);
		await rootShutdown;
		expect(harness.invocations.terminatedLeases).toEqual([
			session.runtimeLeaseId,
		]);
	});

	test("preserves normal feedback through graceful descendant closure", async () => {
		// Purpose: graceful closure must traverse a normal-first lease without replacing its terminal state or feedback.
		// Input and expected output: B succeeds once, then owner A shutdown preserves B and force-aborts active C without feedback.
		// Edge case: terminal B is the only current ownership bridge from A to active C.
		// Dependencies: first-event precedence, multi-seed graceful closure, and forced-abort feedback withholding.
		const harness = createHarness();
		const ownerA: OwnerIdentity = {
			ownerPiSessionId: "graceful-owner-a",
			ownerSessionFile: "/tmp/graceful-owner-a.jsonl",
		};
		const ownerB: OwnerIdentity = {
			ownerPiSessionId: "graceful-owner-b",
			ownerSessionFile: "/tmp/graceful-owner-b.jsonl",
		};
		const sessionB: LogicalSession = {
			...activeSession(1),
			key: {
				ownerPiSessionId: ownerA.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: ownerB.ownerPiSessionId,
			invocationId: "graceful-invocation-b",
			runtimeLeaseId: "graceful-lease-b",
			ownerRuntimeLeaseId: "graceful-lease-a",
		};
		const sessionC: LogicalSession = {
			...activeSession(1),
			key: {
				ownerPiSessionId: ownerB.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "graceful-owner-c",
			invocationId: "graceful-invocation-c",
			runtimeLeaseId: "graceful-lease-c",
			ownerRuntimeLeaseId: sessionB.runtimeLeaseId,
		};
		for (const session of [sessionB, sessionC]) {
			harness.catalog.add(session);
		}
		for (const owner of [ownerA, ownerB]) {
			harness.coordinator.registerOwner(owner);
		}
		await harness.coordinator.observeInvocation({
			kind: "terminal",
			invocationId: sessionB.invocationId,
			status: "success",
			text: "B completed normally",
		});

		await harness.coordinator.shutdown(ownerA);
		const terminalRecords = harness.store.records.filter(
			(record) => record.kind === "terminal",
		);

		expect({
			states: [
				harness.catalog.get(ownerA, 1)?.state,
				harness.catalog.get(ownerB, 1)?.state,
			],
			bTerminals: terminalRecords.filter(
				(record) => record.invocationId === sessionB.invocationId,
			).length,
			cTerminals: terminalRecords.filter(
				(record) => record.invocationId === sessionC.invocationId,
			).length,
			bFeedback: harness.history.feedback.filter(
				(feedback) => feedback.invocationId === sessionB.invocationId,
			).length,
			cFeedback: harness.history.feedback.filter(
				(feedback) => feedback.invocationId === sessionC.invocationId,
			).length,
		}).toEqual({
			states: ["terminal-success", "terminal-aborted"],
			bTerminals: 1,
			cTerminals: 1,
			bFeedback: 1,
			cFeedback: 0,
		});
	});

	test("withholds shutdown-forced abort feedback", async () => {
		// Purpose: owner shutdown must terminalize active children without creating feedback.
		// Input and expected output: one active child becomes terminal-aborted with withheld-forced-abort.
		// Edge case: no wait or owner-history destination is created.
		// Dependencies: controlled invocation termination and journal append order.
		const harness = createHarness();
		harness.catalog.add(activeSession());
		await harness.coordinator.shutdown(OWNER);
		const terminal = harness.store.records.find(
			(record) => record.kind === "terminal",
		);

		expect({
			terminal,
			history: harness.history.feedback,
			active: harness.invocations.active,
		}).toEqual({
			terminal: {
				kind: "terminal",
				sessionKey: activeSession().key,
				invocationId: "invocation-1",
				state: "terminal-aborted",
				disposition: "withheld-forced-abort",
			},
			history: [],
			active: false,
		});
	});

	test("rejects a known foreign owner-local session ID", async () => {
		// Purpose: direct-owner enforcement must distinguish a foreign known session from an unknown ID.
		// Input and expected output: caller owner-pi tries to steer session 1 owned by other-owner and receives not_owner.
		// Edge case: numeric owner-local IDs are intentionally reusable across owners.
		// Dependencies: one foreign catalog session and no invocation process.
		const harness = createHarness();
		harness.catalog.add({
			...activeSession(),
			key: {
				ownerPiSessionId: "other-owner",
				ownerLocalSessionId: 1,
			},
		});
		let code = "";
		try {
			await harness.coordinator.steer(OWNER, {
				sessionId: 1,
				prompt: "Do not accept",
			});
		} catch (error) {
			code = readFailureCode(error);
		}

		expect(code).toBe("not_owner");
	});
});

/** Reads a stable coordinator failure code without asserting message prose. */
function readFailureCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return "unexpected_failure";
}
