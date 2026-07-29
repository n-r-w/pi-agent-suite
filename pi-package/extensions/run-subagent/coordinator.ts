import { readCancellationError } from "./cancellation-reason";
import {
	feedbackResult,
	type SubagentFailedCode,
	type SubagentNormalResult,
	type SubagentStartRequest,
	type SubagentSteerRequest,
	SubagentToolError,
	type SubagentWaitRequest,
} from "./contracts";
import type {
	AcceptedPresentationEvidence,
	InvocationMetadata,
	JournalRecord,
	LogicalSession,
	OwnerIdentity,
	SessionKey,
	SubagentFeedback,
	WaitFeedbackPresentationEvidence,
} from "./domain";
import { errorMessage } from "./error-message";
import {
	type InvocationAcceptance,
	type InvocationControl,
	type InvocationEvent,
	InvocationStartError,
} from "./invocation-contracts";
import type { OwnerSessionStore } from "./persistence";
import { sanitizePublicSubagentErrorMessage } from "./public-error";
import type { RuntimeChannelFailure } from "./runtime-bridge";
import type { SessionCatalogState } from "./session-catalog";
import { resolveDirectChildSession } from "./session-ownership";
import type { WaitRuntime } from "./wait-coordinator";

/** Represents the only successful result produced by start and steering operations. */
type AcceptedResult = Extract<
	SubagentNormalResult,
	{ readonly outcome: "accepted" }
>;

/** Supplies coordinator time facts without granting presentation clock ownership. */
interface CoordinatorClock {
	monotonicNow(): number;
	wallNow(): number;
}

/** Supplies all coordinator-owned transition ports. */
interface SubagentCoordinatorOptions {
	readonly catalog: SessionCatalogState;
	readonly invocations: InvocationControl;
	readonly waits: WaitRuntime;
	readonly store: OwnerSessionStore;
	readonly clock: CoordinatorClock;
	readonly isAgentAvailable: (owner: OwnerIdentity, agentId: string) => boolean;
}

/** Carries one terminal observation through durable feedback settlement. */
interface SessionCompletion {
	readonly session: LogicalSession;
	readonly state: "terminal-success" | "terminal-failure" | "terminal-aborted";
	readonly outcome: {
		readonly status: "success" | "failure" | "abort";
		readonly text: string;
	};
	readonly invocationMetadata: InvocationMetadata;
	readonly terminalObservedAt: number;
}

/** Defines one admitted wait execution identity. */
interface WaitExecution {
	readonly toolCallId: string;
	readonly requestId: string;
	readonly runtimeLeaseId?: string;
}

/** Identifies one root or remote operation across cancellation and acceptance. */
interface OperationCorrelation {
	readonly requestId: string;
	readonly toolCallId: string;
	readonly runtimeLeaseId?: string;
}

/** Binds operations initiated by a nested owner to its worker runtime lease. */
interface CoordinationScope {
	readonly ownerRuntimeLeaseId?: string;
	readonly operationCorrelation?: OperationCorrelation;
	readonly signal?: AbortSignal;
}

/** Exposes one operation's cancellation signal and publication transition. */
interface OperationCancellationLease {
	readonly signal: AbortSignal;
	accept(): boolean;
	cancellationError(): Error;
	close(): void;
}

/** Stores the sole pending/accepted/cancelled transition for each operation correlation. */
class OperationCancellationAuthority {
	private readonly operations = new Map<string, OperationCancellationState>();

	/** Opens one operation before it enters the coordinator transition queue. */
	public open(
		correlation: OperationCorrelation | undefined,
		parentSignal: AbortSignal | undefined,
	): OperationCancellationLease {
		const key =
			correlation === undefined ? undefined : operationKey(correlation);
		if (key !== undefined && this.operations.has(key)) {
			throw new Error("operation cancellation correlation is already active");
		}
		const controller = new AbortController();
		const state: OperationCancellationState = {
			controller,
			status: "pending",
			cancellationError: undefined,
		};
		if (key !== undefined) {
			this.operations.set(key, state);
		}
		const onAbort = (): void => {
			this.cancelState(state, readCancellationError(parentSignal));
		};
		if (parentSignal?.aborted) {
			onAbort();
		} else {
			parentSignal?.addEventListener("abort", onAbort, { once: true });
		}
		return {
			signal: controller.signal,
			accept: () => {
				if (state.status !== "pending") {
					return state.status === "accepted";
				}
				state.status = "accepted";
				return true;
			},
			cancellationError: () =>
				state.cancellationError ?? new Error("operation was not cancelled"),
			close: () => {
				parentSignal?.removeEventListener("abort", onAbort);
				if (key !== undefined && this.operations.get(key) === state) {
					this.operations.delete(key);
				}
			},
		};
	}

	/** Cancels one still-pending remote operation before acceptance publication. */
	public cancel(correlation: OperationCorrelation, reason: Error): boolean {
		const state = this.operations.get(operationKey(correlation));
		return state === undefined ? false : this.cancelState(state, reason);
	}

	/** Selects cancellation only while publication authority remains pending. */
	private cancelState(
		state: OperationCancellationState,
		reason: Error,
	): boolean {
		if (state.status !== "pending") {
			return false;
		}
		state.status = "cancelled";
		state.cancellationError = reason;
		state.controller.abort(reason);
		return true;
	}
}

/** Holds one operation's linearized outcome and internal abort controller. */
interface OperationCancellationState {
	readonly controller: AbortController;
	status: "pending" | "accepted" | "cancelled";
	cancellationError: Error | undefined;
}

interface ActiveWait {
	readonly owner: OwnerIdentity;
	readonly selectedIds: ReadonlySet<number>;
	readonly startedAt: number;
	readonly expiresAt: number;
	readonly execution: WaitExecution;
}

/** Keeps wall and monotonic start facts in their distinct clock domains. */
interface InvocationStartFacts {
	readonly monotonicMs: number;
	readonly wallMs: number;
}

/** Carries all facts required to publish one cancellation-winning start. */
interface NewSessionPublication {
	readonly owner: OwnerIdentity;
	readonly request: SubagentStartRequest;
	readonly scope: CoordinationScope;
	readonly operation: OperationCancellationLease;
	readonly acceptance: InvocationAcceptance;
	readonly invocationStart: InvocationStartFacts;
	readonly sessionKey: SessionKey;
	readonly ownerLocalSessionId: number;
}

/** Restricts acceptance compensation to the two durable publication records. */
type AcceptedJournalRecord = Extract<
	JournalRecord,
	{ readonly kind: "session-accepted" | "continuation-accepted" }
>;

/** Narrows durable terminal records that carry selected normal feedback. */
type TerminalJournalRecord = Extract<
	JournalRecord,
	{ readonly kind: "terminal" }
>;

/** Carries one authorized active steer or terminal continuation request. */
interface SteerSessionOperation {
	readonly owner: OwnerIdentity;
	readonly session: LogicalSession;
	readonly prompt: string;
	readonly scope: CoordinationScope;
	readonly operation?: OperationCancellationLease;
}

/** Retains one remote owner's selected terminal until offline durability is available. */
interface DeferredTerminal {
	readonly owner: OwnerIdentity;
	readonly record: TerminalJournalRecord;
}

/** Serializes every logical-session, invocation, wait, and disposition transition. */
export class SubagentCoordinator {
	private transitionTail: Promise<void> = Promise.resolve();
	private readonly operationCancellations =
		new OperationCancellationAuthority();
	private readonly activeWaits = new Map<string, ActiveWait>();
	private readonly sessionsByInvocation = new Map<string, SessionKey>();
	private readonly invocationStartMonotonicMs = new Map<string, number>();
	private readonly nextLocalId = new Map<string, number>();
	private readonly owners = new Map<string, OwnerIdentity>();
	// Failed closure leases reject operations that were queued before teardown completed.
	private readonly stoppedRuntimeLeases = new Set<string>();
	// Remote terminal obligations survive uncertain publication until writer release.
	private readonly deferredTerminals = new Map<string, DeferredTerminal>();
	private readonly waitEvidence = new Map<
		string,
		WaitFeedbackPresentationEvidence
	>();

	/** Binds the sole transition owner to its infrastructure ports. */
	public constructor(private readonly options: SubagentCoordinatorOptions) {}

	/** Restores one direct owner and indexes its current invocation identities. */
	public registerOwner(owner: OwnerIdentity): void {
		this.rememberOwner(owner);
		for (const session of this.options.catalog.list(owner)) {
			this.sessionsByInvocation.set(session.invocationId, session.key);
		}
	}

	/** Starts one direct child and returns after Pi accepts the prompt. */
	public start(
		owner: OwnerIdentity,
		request: SubagentStartRequest,
		scope: CoordinationScope = {},
	): Promise<AcceptedResult> {
		this.rememberOwner(owner);
		const operation = this.operationCancellations.open(
			scope.operationCorrelation,
			scope.signal,
		);
		const operationScope = { ...scope, signal: operation.signal };
		return this.enqueue(async () => {
			this.requireActiveRuntimeLease(scope.ownerRuntimeLeaseId, "start_failed");
			if (!this.options.isAgentAvailable(owner, request.agentId)) {
				throw new SubagentToolError(
					"agent_unavailable",
					`Subagent ${request.agentId} is unavailable`,
				);
			}
			const ownerLocalSessionId = this.consumeNextLocalId(owner);
			const sessionKey: SessionKey = {
				ownerPiSessionId: owner.ownerPiSessionId,
				ownerLocalSessionId,
			};
			const invocationStart = this.captureInvocationStart();
			const acceptance = await this.acceptNewInvocation(
				owner,
				sessionKey,
				request,
				operationScope,
			);
			return this.publishNewSession({
				owner,
				request,
				scope,
				operation,
				acceptance,
				invocationStart,
				sessionKey,
				ownerLocalSessionId,
			});
		}).finally(() => operation.close());
	}

	/** Publishes one accepted start only after it wins cancellation authority. */
	private async publishNewSession({
		owner,
		request,
		scope,
		operation,
		acceptance,
		invocationStart,
		sessionKey,
		ownerLocalSessionId,
	}: NewSessionPublication): Promise<AcceptedResult> {
		// Publication authority decides before any durable or in-memory session becomes visible.
		await this.requireAcceptanceAuthority(acceptance, operation);
		const common = {
			key: sessionKey,
			childPiSessionId: acceptance.childPiSessionId,
			childSessionDir: acceptance.childSessionDir,
			childSessionFile: acceptance.childSessionFile,
			agentId: request.agentId,
			taskName: request.taskName,
			creationOrder: ownerLocalSessionId,
			invocationId: acceptance.invocationId,
			runtimeLeaseId: acceptance.runtimeLeaseId,
			invocationMetadata: this.acceptedInvocationMetadata(
				acceptance,
				invocationStart,
			),
			state: "active" as const,
		};
		const session: LogicalSession =
			scope.ownerRuntimeLeaseId === undefined
				? common
				: { ...common, ownerRuntimeLeaseId: scope.ownerRuntimeLeaseId };
		await this.appendAcceptedOrCompensate(
			owner,
			{ kind: "session-accepted", session },
			acceptance,
			() => {
				this.options.catalog.add({
					...session,
					state: "terminal-aborted",
				});
				this.sessionsByInvocation.set(acceptance.invocationId, sessionKey);
			},
		);
		this.invocationStartMonotonicMs.set(
			acceptance.invocationId,
			invocationStart.monotonicMs,
		);
		this.options.catalog.add(session);
		this.sessionsByInvocation.set(acceptance.invocationId, sessionKey);
		return { outcome: "accepted", sessionId: ownerLocalSessionId };
	}

	/** Resolves one new-child acceptance through the shared supervisor error boundary. */
	private async acceptNewInvocation(
		owner: OwnerIdentity,
		sessionKey: SessionKey,
		request: SubagentStartRequest,
		scope: CoordinationScope,
	): Promise<InvocationAcceptance> {
		try {
			return await this.options.invocations.start({
				owner,
				sessionKey,
				agentId: request.agentId,
				taskName: request.taskName,
				prompt: request.prompt,
				...scope,
			});
		} catch (error) {
			if (scope.signal?.aborted) {
				throw readCancellationError(scope.signal);
			}
			throw mapInvocationError(error, "start_failed");
		}
	}

	/** Steers or continues one direct child after Pi accepts the message. */
	public steer(
		owner: OwnerIdentity,
		request: SubagentSteerRequest,
		scope: CoordinationScope = {},
	): Promise<AcceptedResult> {
		this.rememberOwner(owner);
		const operation = this.operationCancellations.open(
			scope.operationCorrelation,
			scope.signal,
		);
		const operationScope = { ...scope, signal: operation.signal };
		return this.enqueue(() => {
			this.requireActiveRuntimeLease(
				scope.ownerRuntimeLeaseId,
				"message_rejected",
			);
			const session = resolveDirectChildSession(
				this.options.catalog,
				owner,
				request.sessionId,
			);
			return this.steerSession({
				owner,
				session,
				prompt: request.prompt,
				scope: operationScope,
				operation,
			});
		}).finally(() => operation.close());
	}

	/** Accepts one presentation-originated message by complete stable identity. */
	public submitManagementMessage(
		sessionKey: SessionKey,
		prompt: string,
	): Promise<AcceptedResult> {
		return this.enqueue(() => {
			const session = this.resolveSessionKey(sessionKey);
			const owner = this.ownerOf(session);
			return this.steerSession({ owner, session, prompt, scope: {} });
		});
	}

	/** Admits one direct-owner wait and returns its eventual settlement. */
	public async wait(
		owner: OwnerIdentity,
		request: SubagentWaitRequest,
		execution: WaitExecution,
	): Promise<SubagentNormalResult> {
		this.rememberOwner(owner);
		const admission = await this.enqueue(() => {
			this.requireActiveRuntimeLease(
				execution.runtimeLeaseId,
				"message_rejected",
			);
			// Ownership failure precedence applies to the complete request, not its first unresolved ID.
			const nonOwnedSessionId = request.sessionIds.find(
				(sessionId) =>
					this.options.catalog.get(owner, sessionId) === undefined &&
					this.options.catalog.findByLocalId(sessionId).length > 0,
			);
			if (nonOwnedSessionId !== undefined) {
				throw new SubagentToolError(
					"not_owner",
					`session ${nonOwnedSessionId} is not directly owned by the caller`,
				);
			}
			const sessions = request.sessionIds.map((sessionId) =>
				resolveDirectChildSession(this.options.catalog, owner, sessionId),
			);
			const selectedIds = new Set(
				sessions
					.filter((session) => session.state === "active")
					.map((session) => session.key.ownerLocalSessionId),
			);
			if (selectedIds.size === 0) {
				return { immediate: { outcome: "no_active_sessions" } as const };
			}
			const ownerKey = owner.ownerPiSessionId;
			if (this.activeWaits.has(ownerKey)) {
				throw new SubagentToolError(
					"wait_already_active",
					"the calling agent already has an active subagent wait",
				);
			}
			const startedAt = this.options.clock.monotonicNow();
			const expiresAt = startedAt + request.timeoutMs;
			const activeWait: ActiveWait = {
				owner,
				selectedIds,
				startedAt,
				expiresAt,
				execution,
			};
			this.activeWaits.set(ownerKey, activeWait);
			const result = this.options.waits.admit(
				{
					owner,
					toolCallId: execution.toolCallId,
					requestId: execution.requestId,
					...(execution.runtimeLeaseId === undefined
						? {}
						: { runtimeLeaseId: execution.runtimeLeaseId }),
					expiresAt,
				},
				() => {
					this.expireWait(owner);
				},
			);
			return { result };
		});
		if ("immediate" in admission) {
			return admission.immediate;
		}
		return admission.result;
	}

	/** Cancels one exact still-pending start or steer correlation. */
	public cancelOperation(
		correlation: OperationCorrelation,
		reason: Error,
	): boolean {
		return this.operationCancellations.cancel(correlation, reason);
	}

	/** Cancels one exact active wait before its tool call observes rejection. */
	public cancelWait(
		owner: OwnerIdentity,
		execution: WaitExecution,
		reason: Error,
	): Promise<boolean> {
		return this.enqueue(() => {
			const activeWait = this.activeWaits.get(owner.ownerPiSessionId);
			if (
				activeWait === undefined ||
				!sameWaitExecution(activeWait.execution, execution)
			) {
				return false;
			}
			// Authoritative admission is removed before timer and resolver rejection.
			this.activeWaits.delete(owner.ownerPiSessionId);
			const cancelled = this.options.waits.cancel(
				{
					owner,
					toolCallId: execution.toolCallId,
					requestId: execution.requestId,
					...(execution.runtimeLeaseId === undefined
						? {}
						: { runtimeLeaseId: execution.runtimeLeaseId }),
				},
				reason,
			);
			if (!cancelled) {
				throw new Error("active wait resolver correlation is missing");
			}
			return true;
		});
	}

	/** Removes one settled wait's internal persistence correlation. */
	/** Reads accepted presentation facts from the authoritative logical session. */
	public acceptedPresentationEvidence(
		owner: OwnerIdentity,
		sessionId: number,
	): AcceptedPresentationEvidence {
		const session = resolveDirectChildSession(
			this.options.catalog,
			owner,
			sessionId,
		);
		const metadata = session.invocationMetadata;
		return {
			presentationKind: "accepted",
			agentId: session.agentId,
			taskName: session.taskName,
			...(metadata?.modelId === undefined ? {} : { modelId: metadata.modelId }),
			...(metadata?.thinking === undefined
				? {}
				: { thinking: metadata.thinking }),
		};
	}

	/** Consumes one wait-owned presentation snapshot after normal result settlement. */
	public takeWaitEvidence(
		toolCallId: string,
	): WaitFeedbackPresentationEvidence | undefined {
		const evidence = this.waitEvidence.get(toolCallId);
		this.waitEvidence.delete(toolCallId);
		return evidence;
	}

	/** Serializes one supervisor observation. */
	public observeInvocation(event: InvocationEvent): Promise<void> {
		return this.enqueue(async () => {
			const session = this.findSessionByInvocation(event.invocationId);
			// Historical invocation indexes cannot mutate a continued logical session.
			if (
				session === undefined ||
				session.state !== "active" ||
				session.invocationId !== event.invocationId
			) {
				return;
			}
			// Wait eligibility belongs to serialized observation, not later durability completion.
			const terminalObservedAt = this.options.clock.monotonicNow();
			const invocationMetadata = this.finalInvocationMetadata(session, event);
			if (event.kind === "accepted-exit") {
				await this.completeSession({
					session,
					state: "terminal-failure",
					outcome: {
						status: "failure",
						text: formatAcceptedExit(),
					},
					invocationMetadata,
					terminalObservedAt,
				});
				return;
			}
			const terminalState = terminalStateFor(event.status);
			await this.completeSession({
				session,
				state: terminalState,
				outcome: {
					status: event.status,
					text: event.text,
				},
				invocationMetadata,
				terminalObservedAt,
			});
		});
	}

	/** Serializes one runtime-channel fail-stop observation. */
	public observeRuntimeFailure(
		failure: RuntimeChannelFailure,
	): Promise<readonly string[]> {
		return this.enqueue(async () => {
			const closure = this.runtimeLeaseClosure([failure.runtimeLeaseId]);
			// The complete closure is fixed before cancellation or teardown can alter live ownership.
			for (const runtimeLeaseId of closure.runtimeLeaseIds) {
				this.stoppedRuntimeLeases.add(runtimeLeaseId);
				this.cancelWaitByLease(runtimeLeaseId);
			}
			try {
				await this.forceAbortInOrder(closure.activeSessions);
			} catch {
				// Offline reconciliation repairs durable state after every affected writer is released.
			}
			await this.options.invocations.terminateLease(failure.runtimeLeaseId);
			return closure.runtimeLeaseIds;
		});
	}

	/** Persists selected normal terminals after process teardown releases the remote writer. */
	public persistDeferredTerminals(owner: OwnerIdentity): Promise<void> {
		return this.enqueue(async () => {
			const deferred = [...this.deferredTerminals].filter(
				([, terminal]) =>
					terminal.owner.ownerPiSessionId === owner.ownerPiSessionId,
			);
			// One offline writer preserves the coordinator's selected terminal order.
			await deferred.reduce(
				(previous, [invocationId, terminal]) =>
					previous.then(async () => {
						await this.options.store.append(terminal.owner, terminal.record);
						this.deferredTerminals.delete(invocationId);
					}),
				Promise.resolve(),
			);
		});
	}

	/** Replaces live catalog projections with sessions rebuilt by offline reconciliation. */
	public applyReconciledSessions(
		sessions: readonly LogicalSession[],
	): Promise<void> {
		return this.enqueue(() => {
			for (const session of sessions) {
				const current = this.options.catalog
					.findByLocalId(session.key.ownerLocalSessionId)
					.find(
						(candidate) =>
							candidate.key.ownerPiSessionId === session.key.ownerPiSessionId,
					);
				if (current === undefined) {
					this.options.catalog.add(session);
					this.sessionsByInvocation.set(session.invocationId, session.key);
					continue;
				}
				// A different live invocation was accepted after this offline snapshot began.
				if (current.invocationId !== session.invocationId) {
					continue;
				}
				this.sessionsByInvocation.delete(current.invocationId);
				this.options.catalog.replace(session);
				this.sessionsByInvocation.set(session.invocationId, session.key);
			}
		});
	}

	/** Stops the complete descendant closure during owner-runtime shutdown. */
	public shutdown(owner: OwnerIdentity): Promise<readonly string[]> {
		this.rememberOwner(owner);
		return this.enqueue(async () => {
			const seedRuntimeLeaseIds = [
				...new Set(
					this.options.catalog
						.list(owner)
						.map((session) => session.runtimeLeaseId),
				),
			];
			const closure = this.runtimeLeaseClosure(seedRuntimeLeaseIds);
			// The complete graceful closure is fixed before wait, logical, or process mutation.
			this.cancelWaitByOwner(owner);
			for (const runtimeLeaseId of closure.runtimeLeaseIds) {
				this.stoppedRuntimeLeases.add(runtimeLeaseId);
				this.cancelWaitByLease(runtimeLeaseId);
			}
			try {
				await this.forceAbortInOrder(closure.activeSessions);
			} catch {
				// Offline reconciliation repairs durable state after every closure writer is released.
			}
			const teardowns = await Promise.allSettled(
				seedRuntimeLeaseIds.map((runtimeLeaseId) =>
					this.options.invocations.terminateLease(runtimeLeaseId),
				),
			);
			const rejected = teardowns.find((result) => result.status === "rejected");
			if (rejected !== undefined) {
				// All seed closures settle before graceful shutdown reports one teardown failure.
				throw rejected.reason instanceof Error
					? rejected.reason
					: new Error(errorMessage(rejected.reason));
			}
			return closure.runtimeLeaseIds;
		});
	}

	/** Applies strict timeout precedence inside the serialized transition queue. */
	private expireWait(owner: OwnerIdentity): void {
		this.enqueue(() => {
			const key = owner.ownerPiSessionId;
			const wait = this.activeWaits.get(key);
			if (
				wait === undefined ||
				this.options.clock.monotonicNow() < wait.expiresAt
			) {
				return;
			}
			this.activeWaits.delete(key);
			this.options.waits.settle(owner, { outcome: "timeout" });
		}).catch(() => undefined);
	}

	/** Stops an accepted lease when cancellation reserved the first transition. */
	private async requireAcceptanceAuthority(
		acceptance: InvocationAcceptance,
		operation: OperationCancellationLease,
	): Promise<void> {
		if (operation.accept()) {
			return;
		}
		await this.options.invocations.terminateLease(acceptance.runtimeLeaseId);
		throw operation.cancellationError();
	}

	/** Stops an accepted invocation and reconciles only durably observed acceptance. */
	private async appendAcceptedOrCompensate(
		owner: OwnerIdentity,
		record: AcceptedJournalRecord,
		acceptance: InvocationAcceptance,
		publishCompensatedState: () => void,
	): Promise<void> {
		try {
			await this.options.store.append(owner, record);
			return;
		} catch (publicationError) {
			// No logical publication can occur until the accepted process is synchronously stopped.
			await this.options.invocations.terminateLease(acceptance.runtimeLeaseId);
			const sessionKey =
				record.kind === "session-accepted"
					? record.session.key
					: record.sessionKey;
			if (
				await this.options.store.hasAcceptedInvocationEvidence(
					owner,
					sessionKey,
					acceptance.invocationId,
				)
			) {
				await this.options.store.append(owner, {
					kind: "terminal",
					sessionKey,
					invocationId: acceptance.invocationId,
					state: "terminal-aborted",
					disposition: "withheld-forced-abort",
				});
				publishCompensatedState();
			}
			throw publicationError instanceof Error
				? publicationError
				: new Error(errorMessage(publicationError));
		}
	}

	/** Persists one changed current-invocation snapshot before publishing it. */
	/** Finalizes terminal metrics without publishing a preceding metadata record. */
	private finalInvocationMetadata(
		session: LogicalSession,
		event: InvocationEvent,
	): InvocationMetadata {
		const current = session.invocationMetadata;
		if (current === undefined) {
			throw new Error(
				`active invocation ${session.invocationId} has no accepted metadata`,
			);
		}
		const startedAtMonotonicMs = this.invocationStartMonotonicMs.get(
			session.invocationId,
		);
		return {
			...current,
			elapsedMs:
				startedAtMonotonicMs === undefined
					? current.elapsedMs
					: Math.max(
							current.elapsedMs,
							this.elapsedSince(startedAtMonotonicMs),
						),
			...(event.contextTokens === undefined
				? {}
				: { contextTokens: event.contextTokens }),
			...(event.projectionSavedTokens === undefined
				? {}
				: { projectionSavedTokens: event.projectionSavedTokens }),
		};
	}

	/** Captures one invocation start in both elapsed and durable clock domains. */
	private captureInvocationStart(): InvocationStartFacts {
		return {
			monotonicMs: this.options.clock.monotonicNow(),
			wallMs: this.options.clock.wallNow(),
		};
	}

	/** Materializes accepted launch metadata from one owned clock snapshot. */
	private acceptedInvocationMetadata(
		acceptance: InvocationAcceptance,
		start: InvocationStartFacts,
	): InvocationMetadata {
		return createInvocationMetadata(
			acceptance,
			start.wallMs,
			this.elapsedSince(start.monotonicMs),
		);
	}

	/** Returns non-negative whole milliseconds from the coordinator's monotonic clock. */
	private elapsedSince(startedAtMonotonicMs: number): number {
		return Math.max(
			0,
			Math.floor(this.options.clock.monotonicNow() - startedAtMonotonicMs),
		);
	}

	/** Preserves one normal terminal before remote durability and feedback routing. */
	private async completeSession({
		session,
		state,
		outcome,
		invocationMetadata,
		terminalObservedAt,
	}: SessionCompletion): Promise<void> {
		const feedback = createFeedback(session, outcome, invocationMetadata);
		const owner = this.ownerOf(session);
		const terminalRecord: TerminalJournalRecord = {
			kind: "terminal",
			sessionKey: session.key,
			invocationId: session.invocationId,
			state,
			disposition: "pending",
			feedback,
		};
		if (session.ownerRuntimeLeaseId !== undefined) {
			// Normal-first authority and complete feedback exist before remote durability can fail.
			this.options.catalog.update(session.key, { invocationMetadata, state });
			this.deferredTerminals.set(session.invocationId, {
				owner,
				record: terminalRecord,
			});
			await this.options.store.append(owner, terminalRecord);
			this.deferredTerminals.delete(session.invocationId);
		} else {
			await this.options.store.append(owner, terminalRecord);
			this.options.catalog.update(session.key, { invocationMetadata, state });
		}
		this.invocationStartMonotonicMs.delete(session.invocationId);
		const wait = this.activeWaits.get(session.key.ownerPiSessionId);
		if (
			wait?.selectedIds.has(session.key.ownerLocalSessionId) &&
			terminalObservedAt < wait.expiresAt
		) {
			await this.options.store.append(owner, {
				kind: "wait-claimed",
				feedback,
				waitToolCallId: wait.execution.toolCallId,
				waitRequestId: wait.execution.requestId,
			});
			this.activeWaits.delete(session.key.ownerPiSessionId);
			this.waitEvidence.set(wait.execution.toolCallId, {
				presentationKind: "wait-feedback",
				feedbackId: feedback.feedbackId,
				invocationId: feedback.invocationId,
				waitRequestId: wait.execution.requestId,
				waitElapsedMs: Math.max(
					0,
					Math.floor(terminalObservedAt - wait.startedAt),
				),
				feedback,
			});
			this.options.waits.settle(owner, feedbackResult(feedback));
			return;
		}
		await this.options.store.append(owner, {
			kind: "history-pending",
			feedbackId: feedback.feedbackId,
			invocationId: feedback.invocationId,
			sessionKey: feedback.sessionKey,
		});
		await this.options.store.appendHistory(owner, feedback);
		if (
			await this.options.store.hasHistoryEvidence(owner, feedback.feedbackId)
		) {
			await this.options.store.append(owner, {
				kind: "history-committed",
				feedbackId: feedback.feedbackId,
				invocationId: feedback.invocationId,
				sessionKey: feedback.sessionKey,
			});
		}
	}

	/** Persists shutdown-first forced abort without creating feedback. */
	private async forceAbort(session: LogicalSession): Promise<void> {
		try {
			await this.options.store.append(this.ownerOf(session), {
				kind: "terminal",
				sessionKey: session.key,
				invocationId: session.invocationId,
				state: "terminal-aborted",
				disposition: "withheld-forced-abort",
			});
		} finally {
			// Fail-stop makes the logical session terminal even when durable repair is deferred.
			this.invocationStartMonotonicMs.delete(session.invocationId);
			this.options.catalog.update(session.key, { state: "terminal-aborted" });
		}
	}

	/** Applies every forced abort before reporting the first persistence failure. */
	private async forceAbortInOrder(
		sessions: readonly LogicalSession[],
	): Promise<void> {
		let firstFailure: Error | undefined;
		await sessions.reduce(
			(previous, session) =>
				previous.then(async () => {
					try {
						await this.forceAbort(session);
					} catch (error) {
						firstFailure ??=
							error instanceof Error ? error : new Error(errorMessage(error));
					}
				}),
			Promise.resolve(),
		);
		if (firstFailure !== undefined) {
			throw firstFailure;
		}
	}

	/** Removes one owner's authoritative wait before canceling its adapter resolver. */
	private cancelWaitByOwner(owner: OwnerIdentity): void {
		this.activeWaits.delete(owner.ownerPiSessionId);
		this.options.waits.cancelOwner(owner);
	}

	/** Removes lease-owned authoritative waits before canceling adapter resolvers. */
	private cancelWaitByLease(runtimeLeaseId: string): void {
		for (const [ownerPiSessionId, wait] of this.activeWaits) {
			if (wait.execution.runtimeLeaseId === runtimeLeaseId) {
				this.activeWaits.delete(ownerPiSessionId);
			}
		}
		this.options.waits.cancelLease(runtimeLeaseId);
	}

	/** Rejects nested coordination after its current owner runtime enters fail-stop. */
	private requireActiveRuntimeLease(
		runtimeLeaseId: string | undefined,
		failureCode: SubagentFailedCode,
	): void {
		if (
			runtimeLeaseId !== undefined &&
			this.stoppedRuntimeLeases.has(runtimeLeaseId)
		) {
			throw new SubagentToolError(
				failureCode,
				"Subagent operation is no longer available",
			);
		}
	}

	/** Shares active steer and terminal continuation without weakening caller authorization. */
	private steerSession(
		request: SteerSessionOperation,
	): Promise<AcceptedResult> {
		return request.session.state === "active"
			? this.steerActiveSession(request)
			: this.continueTerminalSession(request);
	}

	/** Applies one active steer only after child acceptance wins cancellation. */
	private async steerActiveSession({
		session,
		prompt,
		scope,
		operation,
	}: SteerSessionOperation): Promise<AcceptedResult> {
		try {
			await this.options.invocations.steer(session.invocationId, prompt, {
				...(scope.signal === undefined ? {} : { signal: scope.signal }),
				...(operation === undefined
					? {}
					: {
							// Pi queue dispatch owns the operation before its cross-process response can race cancellation.
							beforeDispatch: () => {
								if (!operation.accept()) {
									throw operation.cancellationError();
								}
							},
						}),
			});
		} catch (error) {
			if (scope.signal?.aborted) {
				throw readCancellationError(scope.signal);
			}
			throw mapInvocationError(error, "message_rejected");
		}
		return { outcome: "accepted", sessionId: session.key.ownerLocalSessionId };
	}

	/** Publishes one terminal continuation only after it wins cancellation. */
	private async continueTerminalSession({
		owner,
		session,
		prompt,
		scope,
		operation,
	}: SteerSessionOperation): Promise<AcceptedResult> {
		const invocationStart = this.captureInvocationStart();
		let acceptance: InvocationAcceptance;
		try {
			acceptance = await this.options.invocations.continue(
				session,
				prompt,
				scope,
			);
		} catch (error) {
			if (scope.signal?.aborted) {
				throw readCancellationError(scope.signal);
			}
			throw mapInvocationError(error, "start_failed");
		}
		if (operation !== undefined) {
			// Continuation publication owns the accepted lease only after winning cancellation.
			await this.requireAcceptanceAuthority(acceptance, operation);
		}
		const invocationMetadata = this.acceptedInvocationMetadata(
			acceptance,
			invocationStart,
		);
		const ownerLeaseUpdate =
			scope.ownerRuntimeLeaseId === undefined
				? {}
				: { ownerRuntimeLeaseId: scope.ownerRuntimeLeaseId };
		await this.appendAcceptedOrCompensate(
			owner,
			{
				kind: "continuation-accepted",
				sessionKey: session.key,
				invocationId: acceptance.invocationId,
				runtimeLeaseId: acceptance.runtimeLeaseId,
				...ownerLeaseUpdate,
				invocationMetadata,
			},
			acceptance,
			() => {
				this.options.catalog.update(session.key, {
					invocationId: acceptance.invocationId,
					runtimeLeaseId: acceptance.runtimeLeaseId,
					...ownerLeaseUpdate,
					invocationMetadata,
					state: "terminal-aborted",
				});
				this.sessionsByInvocation.set(acceptance.invocationId, session.key);
			},
		);
		this.invocationStartMonotonicMs.set(
			acceptance.invocationId,
			invocationStart.monotonicMs,
		);
		this.options.catalog.update(session.key, {
			invocationId: acceptance.invocationId,
			runtimeLeaseId: acceptance.runtimeLeaseId,
			...ownerLeaseUpdate,
			invocationMetadata,
			state: "active",
		});
		this.sessionsByInvocation.set(acceptance.invocationId, session.key);
		return { outcome: "accepted", sessionId: session.key.ownerLocalSessionId };
	}

	/** Resolves a complete stable key without owner-local ambiguity. */
	private resolveSessionKey(sessionKey: SessionKey): LogicalSession {
		const session = this.options.catalog
			.findByLocalId(sessionKey.ownerLocalSessionId)
			.find(
				(candidate) =>
					candidate.key.ownerPiSessionId === sessionKey.ownerPiSessionId,
			);
		if (session === undefined) {
			throw new SubagentToolError(
				"unknown_session",
				"unknown subagent session",
			);
		}
		return session;
	}

	/** Finds the current session for one supervisor event. */
	private findSessionByInvocation(
		invocationId: string,
	): LogicalSession | undefined {
		const knownKey = this.sessionsByInvocation.get(invocationId);
		if (knownKey !== undefined) {
			return this.options.catalog.get(
				{
					ownerPiSessionId: knownKey.ownerPiSessionId,
					ownerSessionFile: "",
				},
				knownKey.ownerLocalSessionId,
			);
		}
		return this.allKnownSessions().find(
			(session) => session.invocationId === invocationId,
		);
	}

	/** Derives one current transitive lease closure before shutdown mutates session state. */
	private runtimeLeaseClosure(seedRuntimeLeaseIds: readonly string[]): {
		readonly runtimeLeaseIds: readonly string[];
		readonly activeSessions: readonly LogicalSession[];
	} {
		const sessions = this.allKnownSessions();
		const runtimeLeaseIds = new Set(seedRuntimeLeaseIds);
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const session of sessions) {
				const ownedByClosure =
					session.ownerRuntimeLeaseId !== undefined &&
					runtimeLeaseIds.has(session.ownerRuntimeLeaseId);
				if (ownedByClosure && !runtimeLeaseIds.has(session.runtimeLeaseId)) {
					// Terminal sessions remain ownership bridge nodes while their teardown is retained.
					runtimeLeaseIds.add(session.runtimeLeaseId);
					expanded = true;
				}
			}
		}
		return {
			runtimeLeaseIds: [...runtimeLeaseIds],
			activeSessions: sessions.filter(
				(session) =>
					session.state === "active" &&
					runtimeLeaseIds.has(session.runtimeLeaseId),
			),
		};
	}

	/** Returns the complete recursively recorded hierarchy from known root owners. */
	private allKnownSessions(): readonly LogicalSession[] {
		const pending = [...this.owners.values()];
		const visitedOwners = new Set<string>();
		const sessions: LogicalSession[] = [];
		while (pending.length > 0) {
			const owner = pending.shift();
			if (owner === undefined || visitedOwners.has(owner.ownerPiSessionId)) {
				continue;
			}
			visitedOwners.add(owner.ownerPiSessionId);
			for (const session of this.options.catalog.list(owner)) {
				sessions.push(session);
				pending.push({
					ownerPiSessionId: session.childPiSessionId,
					ownerSessionFile: session.childSessionFile,
				});
			}
		}
		return sessions;
	}

	/** Preserves the session-file part of direct-owner persistence identity. */
	private rememberOwner(owner: OwnerIdentity): void {
		this.owners.set(owner.ownerPiSessionId, owner);
	}

	/** Resolves complete direct-owner persistence identity for one session. */
	private ownerOf(session: LogicalSession): OwnerIdentity {
		const existing = this.owners.get(session.key.ownerPiSessionId);
		if (existing !== undefined) {
			return existing;
		}
		const caller = this.allKnownSessions().find(
			(candidate) =>
				candidate.childPiSessionId === session.key.ownerPiSessionId,
		);
		if (caller === undefined) {
			throw new Error(
				`owner ${session.key.ownerPiSessionId} has no persistence identity`,
			);
		}
		const owner = {
			ownerPiSessionId: caller.childPiSessionId,
			ownerSessionFile: caller.childSessionFile,
		};
		this.rememberOwner(owner);
		return owner;
	}

	/** Consumes one owner-local candidate so failed starts can leave gaps. */
	private consumeNextLocalId(owner: OwnerIdentity): number {
		const current = this.nextLocalId.get(owner.ownerPiSessionId);
		const next =
			current ??
			Math.max(
				0,
				...this.options.catalog
					.list(owner)
					.map((session) => session.key.ownerLocalSessionId),
			) + 1;
		this.nextLocalId.set(owner.ownerPiSessionId, next + 1);
		return next;
	}

	/** Chains transitions while allowing later work after a rejected operation. */
	private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.transitionTail.then(operation, operation);
		this.transitionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

/** Builds one collision-free map key from the complete root or remote correlation. */
function operationKey(correlation: OperationCorrelation): string {
	return JSON.stringify([
		correlation.runtimeLeaseId ?? null,
		correlation.requestId,
		correlation.toolCallId,
	]);
}

/** Creates one complete current-invocation snapshot from accepted launch facts. */
function createInvocationMetadata(
	acceptance: InvocationAcceptance,
	startedAtMs: number,
	elapsedMs: number,
): InvocationMetadata {
	return {
		startedAtMs: Math.max(0, Math.floor(startedAtMs)),
		elapsedMs,
		...(acceptance.modelId === undefined
			? {}
			: { modelId: acceptance.modelId }),
		...(acceptance.thinking === undefined
			? {}
			: { thinking: acceptance.thinking }),
		...(acceptance.contextWindow === undefined
			? {}
			: { contextWindow: acceptance.contextWindow }),
	};
}

/** Prevents duplicate durable metadata records and projection revisions. */
/** Maps supervisor terminal status to the durable logical-session state. */
function terminalStateFor(
	status: "success" | "failure" | "abort",
): "terminal-success" | "terminal-failure" | "terminal-aborted" {
	if (status === "success") {
		return "terminal-success";
	}
	return status === "failure" ? "terminal-failure" : "terminal-aborted";
}

/** Matches one wait by its complete root or nested execution correlation. */
function sameWaitExecution(left: WaitExecution, right: WaitExecution): boolean {
	return (
		left.toolCallId === right.toolCallId &&
		left.requestId === right.requestId &&
		left.runtimeLeaseId === right.runtimeLeaseId
	);
}

/** Maps supervisor rejection classes to the public failed-tool channel. */
function mapInvocationError(
	error: unknown,
	fallback: "message_rejected" | "start_failed",
): SubagentToolError {
	if (error instanceof SubagentToolError) {
		return error;
	}
	if (error instanceof InvocationStartError) {
		return new SubagentToolError(
			error.code,
			error.code === "message_rejected"
				? "Subagent could not accept the message"
				: "Subagent could not start",
		);
	}
	return new SubagentToolError(fallback, errorMessage(error));
}

/** Creates complete terminal feedback with one deterministic deduplication ID. */
function createFeedback(
	session: LogicalSession,
	outcome: {
		readonly status: "success" | "failure" | "abort";
		readonly text: string;
	},
	invocationMetadata: InvocationMetadata,
): SubagentFeedback {
	const common = {
		feedbackId: `${session.invocationId}:feedback`,
		invocationId: session.invocationId,
		sessionKey: session.key,
		presentation: {
			agentId: session.agentId,
			taskName: session.taskName,
			invocationMetadata,
		},
	};
	return outcome.status === "success"
		? { ...common, status: "success", output: outcome.text }
		: {
				...common,
				status: outcome.status,
				error: sanitizePublicSubagentErrorMessage(outcome.text),
			};
}

/** Describes an accepted invocation that stopped before terminal feedback. */
function formatAcceptedExit(): string {
	return "Subagent stopped before completing the task";
}
