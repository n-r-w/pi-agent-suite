import { existsSync } from "node:fs";
import {
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readNonEmptyString as readStringField } from "./boundary-validation";
import {
	type JournalRecord,
	sessionMapKey as keyOf,
	type LogicalSession,
	type OwnerIdentity,
	type SessionKey,
	type SubagentFeedback,
} from "./domain";
import { parseJournalRecord } from "./journal-codec";

/** Identifies the sole V2 custom-entry family. */
export const SUBAGENT_JOURNAL_CUSTOM_TYPE = "subagents-v2-journal";
/** Identifies feedback messages inserted into owner history. */
export const SUBAGENT_HISTORY_CUSTOM_TYPE = "subagents-v2-feedback";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

/** Provides the sole public Pi writer for one active owner process. */
export interface ActiveOwnerSessionWriter {
	readonly owner: OwnerIdentity;
	readonly sessionManager: ReadonlySessionManager;
	appendJournal(record: JournalRecord): void;
	appendHistory(feedback: SubagentFeedback): void;
}

/** Routes writes to an active owner process without creating a second writer. */
interface RemoteOwnerSessionWriter {
	append(owner: OwnerIdentity, record: JournalRecord): Promise<void>;
	appendHistory(
		owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void>;
}

/** Exposes durable direct-owner journal operations. */
export interface OwnerSessionStore {
	append(owner: OwnerIdentity, record: JournalRecord): Promise<void>;
	appendHistory(
		owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void>;
	hasAcceptedInvocationEvidence(
		owner: OwnerIdentity,
		sessionKey: SessionKey,
		invocationId: string,
	): Promise<boolean>;
	hasWaitEvidence(owner: OwnerIdentity, feedbackId: string): Promise<boolean>;
	hasHistoryEvidence(
		owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean>;
}

/** Summarizes one folded owner journal. */
interface FoldedOwnerJournal {
	readonly sessions: readonly LogicalSession[];
	readonly records: readonly JournalRecord[];
}

/** Carries one owner's evidence and write ports through feedback recovery. */
interface ReconciliationContext {
	readonly getEntries: () => readonly SessionEntry[];
	readonly appendRecord: (record: JournalRecord) => void;
	readonly appendHistory: (feedback: SubagentFeedback) => void;
	readonly recoverUndeliveredFeedback: boolean;
	readonly committed: Set<string>;
	readonly claimedWaits: ReadonlySet<string>;
	readonly pendingHistory: Set<string>;
}

/** Implements public SessionManager persistence and reconstruction. */
export class V2SessionStore implements OwnerSessionStore {
	private readonly active = new Map<string, ActiveOwnerSessionWriter>();
	private readonly remoteOwners = new Map<
		string,
		{ readonly owner: OwnerIdentity; readonly runtimeLeaseId: string }
	>();
	private readonly reconciliationTails = new Map<string, Promise<void>>();

	/** Creates a store with an optional root-to-worker writer. */
	public constructor(private readonly remote?: RemoteOwnerSessionWriter) {}

	/** Registers one active owner as the sole writer for its session. */
	public registerActive(writer: ActiveOwnerSessionWriter): void {
		const ownerPiSessionId = writer.owner.ownerPiSessionId;
		if (this.remoteOwners.has(ownerPiSessionId)) {
			throw new Error(`owner ${ownerPiSessionId} already has a remote writer`);
		}
		this.active.set(ownerPiSessionId, writer);
	}

	/** Releases active ownership before offline access can begin. */
	public unregisterActive(ownerPiSessionId: string): void {
		this.active.delete(ownerPiSessionId);
	}

	/** Marks one owner as writable only through its active worker process. */
	public registerRemote(owner: OwnerIdentity, runtimeLeaseId: string): void {
		if (this.active.has(owner.ownerPiSessionId)) {
			throw new Error(
				`owner ${owner.ownerPiSessionId} already has a local writer`,
			);
		}
		this.remoteOwners.set(owner.ownerPiSessionId, { owner, runtimeLeaseId });
	}

	/** Releases one worker writer after its process has stopped. */
	public unregisterRemote(ownerPiSessionId: string): void {
		this.remoteOwners.delete(ownerPiSessionId);
	}

	/** Releases every owner routed through one stopped runtime lease. */
	public releaseRemoteLease(runtimeLeaseId: string): readonly OwnerIdentity[] {
		const released: OwnerIdentity[] = [];
		for (const [ownerPiSessionId, registration] of this.remoteOwners) {
			if (registration.runtimeLeaseId === runtimeLeaseId) {
				this.remoteOwners.delete(ownerPiSessionId);
				released.push(registration.owner);
			}
		}
		return released;
	}

	/** Appends one validated journal record through its owner writer. */
	public async append(
		owner: OwnerIdentity,
		record: JournalRecord,
	): Promise<void> {
		const writer = this.active.get(owner.ownerPiSessionId);
		if (writer !== undefined) {
			writer.appendJournal(record);
			return;
		}
		if (this.remoteOwners.has(owner.ownerPiSessionId)) {
			if (this.remote === undefined) {
				throw new Error("remote owner writer is unavailable");
			}
			await this.remote.append(owner, record);
			return;
		}
		this.openOwner(owner).appendCustomEntry(
			SUBAGENT_JOURNAL_CUSTOM_TYPE,
			record,
		);
	}

	/** Appends one idempotent feedback history message. */
	public async appendHistory(
		owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void> {
		const writer = this.active.get(owner.ownerPiSessionId);
		if (writer !== undefined) {
			if (
				!hasHistoryEvidence(
					writer.sessionManager.getBranch(),
					feedback.feedbackId,
				)
			) {
				writer.appendHistory(feedback);
			}
			return;
		}
		if (this.remoteOwners.has(owner.ownerPiSessionId)) {
			if (this.remote === undefined) {
				throw new Error("remote owner writer is unavailable");
			}
			await this.remote.appendHistory(owner, feedback);
			return;
		}
		appendHistoryToManager(this.openOwner(owner), feedback);
	}

	/** Detects one accepted invocation record on a readable owner branch. */
	public async hasAcceptedInvocationEvidence(
		owner: OwnerIdentity,
		sessionKey: SessionKey,
		invocationId: string,
	): Promise<boolean> {
		if (this.remoteOwners.has(owner.ownerPiSessionId)) {
			return false;
		}
		return this.fold(this.readBranch(owner)).records.some((record) => {
			if (record.kind === "session-accepted") {
				return (
					record.session.invocationId === invocationId &&
					keysEqual(record.session.key, sessionKey)
				);
			}
			return (
				record.kind === "continuation-accepted" &&
				record.invocationId === invocationId &&
				keysEqual(record.sessionKey, sessionKey)
			);
		});
	}

	/** Detects one persisted wait-result correlation on the active branch. */
	public async hasWaitEvidence(
		owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean> {
		return this.remoteOwners.has(owner.ownerPiSessionId)
			? false
			: hasWaitEvidence(this.readBranch(owner), feedbackId);
	}

	/** Detects one feedback-keyed owner-history message on the active branch. */
	public async hasHistoryEvidence(
		owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean> {
		return this.remoteOwners.has(owner.ownerPiSessionId)
			? false
			: hasHistoryEvidence(this.readBranch(owner), feedbackId);
	}

	/** Reconciles durable feedback obligations through public session evidence. */
	public reconcile(sessionManager: SessionManager): Promise<void> {
		return this.serializeReconciliation(sessionManager.getSessionId(), () =>
			this.reconcileEntries(
				() => sessionManager.getBranch(),
				(record) => {
					sessionManager.appendCustomEntry(
						SUBAGENT_JOURNAL_CUSTOM_TYPE,
						record,
					);
				},
				(feedback) => appendHistoryToManager(sessionManager, feedback),
				true,
			),
		);
	}

	/** Reconciles an active owner through its sole ExtensionAPI writer. */
	public reconcileActive(writer: ActiveOwnerSessionWriter): Promise<void> {
		return this.serializeReconciliation(writer.owner.ownerPiSessionId, () =>
			this.reconcileEntries(
				() => writer.sessionManager.getBranch(),
				(record) => writer.appendJournal(record),
				(feedback) => writer.appendHistory(feedback),
				false,
			),
		);
	}

	/** Reconciles one stopped remote owner through public offline session access. */
	public reconcileOffline(
		owner: OwnerIdentity,
	): Promise<readonly LogicalSession[]> {
		return this.reconstructOwner(this.openOwner(owner), new Set());
	}

	/** Folds validated V2 records from one public session branch. */
	public fold(entries: readonly SessionEntry[]): FoldedOwnerJournal {
		const records: JournalRecord[] = [];
		const sessions = new Map<string, LogicalSession>();
		for (const entry of entries) {
			if (
				entry.type !== "custom" ||
				entry.customType !== SUBAGENT_JOURNAL_CUSTOM_TYPE
			) {
				continue;
			}
			const record = parseJournalRecord(entry.data);
			if (record === undefined) {
				continue;
			}
			records.push(record);
			applyRecord(sessions, record);
		}
		return {
			records,
			sessions: [...sessions.values()].sort(
				(left, right) => left.creationOrder - right.creationOrder,
			),
		};
	}

	/** Recursively folds every saved direct-owner journal. */
	public reconstruct(root: SessionManager): Promise<readonly LogicalSession[]> {
		return this.reconstructOwner(root, new Set());
	}

	/** Reconstructs the active root through ExtensionAPI and all saved descendants through SessionManager. */
	public async reconstructActive(
		writer: ActiveOwnerSessionWriter,
	): Promise<readonly LogicalSession[]> {
		await this.reconcileActive(writer);
		const visitedSessions = new Set([writer.owner.ownerSessionFile]);
		const folded = this.fold(writer.sessionManager.getBranch());
		const branches = await Promise.all(
			folded.sessions.map(async (session) => {
				const reconstructed = terminalizeUnmatchedActive(session);
				if (reconstructed !== session) {
					writer.appendJournal(forcedAbortRecord(session));
				}
				if (!existsSync(session.childSessionFile)) {
					return [reconstructed];
				}
				const child = SessionManager.open(
					session.childSessionFile,
					session.childSessionDir,
				);
				return [
					reconstructed,
					...(await this.reconstructOwner(child, visitedSessions)),
				];
			}),
		);
		return branches.flat();
	}

	/** Selects one durable destination from current branch evidence. */
	/** Serializes reentrant scans so each one observes the preceding scan's evidence. */
	private serializeReconciliation(
		ownerPiSessionId: string,
		operation: () => Promise<void>,
	): Promise<void> {
		const previous =
			this.reconciliationTails.get(ownerPiSessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(operation);
		this.reconciliationTails.set(ownerPiSessionId, current);
		current.then(
			() => this.clearReconciliation(ownerPiSessionId, current),
			() => this.clearReconciliation(ownerPiSessionId, current),
		);
		return current;
	}

	/** Removes only the tail that still belongs to the completed scan. */
	private clearReconciliation(
		ownerPiSessionId: string,
		completed: Promise<void>,
	): void {
		if (this.reconciliationTails.get(ownerPiSessionId) === completed) {
			this.reconciliationTails.delete(ownerPiSessionId);
		}
	}

	private async reconcileEntries(
		getEntries: () => readonly SessionEntry[],
		appendRecord: (record: JournalRecord) => void,
		appendHistory: (feedback: SubagentFeedback) => void,
		recoverUndeliveredFeedback: boolean,
	): Promise<void> {
		const folded = this.fold(getEntries());
		const context: ReconciliationContext = {
			getEntries,
			appendRecord,
			appendHistory,
			recoverUndeliveredFeedback,
			committed: committedFeedbackIds(folded.records),
			claimedWaits: claimedWaitFeedbackIds(folded.records),
			pendingHistory: pendingHistoryFeedbackIds(folded.records),
		};
		for (const record of folded.records) {
			const feedback = terminalFeedbackForReconciliation(
				record,
				context.committed,
			);
			if (feedback !== undefined) {
				reconcileTerminalFeedback(feedback, context);
			}
		}
	}

	/** Opens an owner only when no active local or remote writer exists. */
	private openOwner(owner: OwnerIdentity): SessionManager {
		if (
			this.active.has(owner.ownerPiSessionId) ||
			this.remoteOwners.has(owner.ownerPiSessionId)
		) {
			throw new Error(
				`owner ${owner.ownerPiSessionId} already has an active writer`,
			);
		}
		return SessionManager.open(owner.ownerSessionFile);
	}

	/** Reads through the sole active writer or one offline public manager. */
	private readBranch(owner: OwnerIdentity): readonly SessionEntry[] {
		const active = this.active.get(owner.ownerPiSessionId);
		if (active !== undefined) {
			return active.sessionManager.getBranch();
		}
		return this.openOwner(owner).getBranch();
	}

	/** Performs one bounded recursive owner fold. */
	private async reconstructOwner(
		manager: SessionManager,
		visitedSessions: Set<string>,
	): Promise<LogicalSession[]> {
		const traversalKey = managerTraversalKey(manager);
		if (visitedSessions.has(traversalKey)) {
			return [];
		}
		visitedSessions.add(traversalKey);
		await this.reconcile(manager);
		const folded = this.fold(manager.getBranch());
		const branches = await Promise.all(
			folded.sessions.map(async (session) => {
				const reconstructed = terminalizeUnmatchedActive(session);
				if (reconstructed !== session) {
					manager.appendCustomEntry(
						SUBAGENT_JOURNAL_CUSTOM_TYPE,
						forcedAbortRecord(session),
					);
				}
				if (!existsSync(session.childSessionFile)) {
					return [reconstructed];
				}
				const child = SessionManager.open(
					session.childSessionFile,
					session.childSessionDir,
				);
				return [
					reconstructed,
					...(await this.reconstructOwner(child, visitedSessions)),
				];
			}),
		);
		return branches.flat();
	}
}

/** Identifies one persisted traversal node without assuming globally unique session IDs. */
function managerTraversalKey(manager: SessionManager): string {
	return (
		manager.getSessionFile() ??
		`${manager.getSessionDir()}\u0000${manager.getSessionId()}`
	);
}

/** Selects terminal feedback that has not already reached a final disposition. */
function terminalFeedbackForReconciliation(
	record: JournalRecord,
	committed: ReadonlySet<string>,
): SubagentFeedback | undefined {
	return record.kind === "terminal" &&
		record.feedback !== undefined &&
		record.disposition !== "withheld-forced-abort" &&
		!committed.has(record.feedback.feedbackId)
		? record.feedback
		: undefined;
}

/** Replays one undelivered terminal through wait or history persistence. */
function reconcileTerminalFeedback(
	feedback: SubagentFeedback,
	context: ReconciliationContext,
): void {
	if (hasWaitEvidence(context.getEntries(), feedback.feedbackId)) {
		context.appendRecord(commitRecord("wait-committed", feedback));
		context.committed.add(feedback.feedbackId);
		return;
	}
	// An active owner can still be between durable claim and Pi tool-result append.
	if (
		!context.recoverUndeliveredFeedback &&
		context.claimedWaits.has(feedback.feedbackId)
	) {
		return;
	}
	const historyDelivered = hasHistoryEvidence(
		context.getEntries(),
		feedback.feedbackId,
	);
	if (!historyDelivered) {
		// sendMessage becomes branch evidence after the active handler returns.
		if (
			!context.recoverUndeliveredFeedback &&
			context.pendingHistory.has(feedback.feedbackId)
		) {
			return;
		}
		if (!context.pendingHistory.has(feedback.feedbackId)) {
			context.appendRecord({
				kind: "history-pending",
				feedbackId: feedback.feedbackId,
				invocationId: feedback.invocationId,
				sessionKey: feedback.sessionKey,
			});
			context.pendingHistory.add(feedback.feedbackId);
		}
		context.appendHistory(feedback);
	}
	if (hasHistoryEvidence(context.getEntries(), feedback.feedbackId)) {
		context.appendRecord(commitRecord("history-committed", feedback));
		context.committed.add(feedback.feedbackId);
	}
}

/** Maps an unmatched persisted active invocation to shutdown-first terminal abort. */
function terminalizeUnmatchedActive(session: LogicalSession): LogicalSession {
	return session.state === "active" || session.state === "starting"
		? { ...session, state: "terminal-aborted" }
		: session;
}

/** Creates the durable no-feedback record for an unmatched active invocation. */
function forcedAbortRecord(session: LogicalSession): JournalRecord {
	return {
		kind: "terminal",
		sessionKey: session.key,
		invocationId: session.invocationId,
		state: "terminal-aborted",
		disposition: "withheld-forced-abort",
	};
}

/** Appends complete feedback once without triggering a new owner turn. */
function appendHistoryToManager(
	manager: SessionManager,
	feedback: SubagentFeedback,
): void {
	if (hasHistoryEvidence(manager.getBranch(), feedback.feedbackId)) {
		return;
	}
	const message = createHistoryMessage(feedback);
	manager.appendCustomMessageEntry(
		SUBAGENT_HISTORY_CUSTOM_TYPE,
		message.content,
		true,
		message.details,
	);
}

/** Builds the complete active or inactive owner-history message. */
export function createHistoryMessage(feedback: SubagentFeedback): {
	readonly content: string;
	readonly details: SubagentFeedback;
} {
	const sessionId = feedback.sessionKey.ownerLocalSessionId;
	return {
		content:
			feedback.status === "success"
				? `Subagent ${sessionId} completed successfully:\n${feedback.output}`
				: `Subagent ${sessionId} finished with ${feedback.status}:\n${feedback.error}`,
		details: feedback,
	};
}

/** Finds one internal wait-result correlation without trusting message details. */
function hasWaitEvidence(
	entries: readonly SessionEntry[],
	feedbackId: string,
): boolean {
	return entries.some((entry) => {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "subagent_wait"
		) {
			return false;
		}
		return readStringField(entry.message.details, "feedbackId") === feedbackId;
	});
}

/** Finds one feedback-keyed custom history message. */
function hasHistoryEvidence(
	entries: readonly SessionEntry[],
	feedbackId: string,
): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE &&
			readStringField(entry.details, "feedbackId") === feedbackId,
	);
}

/** Collects feedback identities reserved for a wait result that Pi may still append. */
function claimedWaitFeedbackIds(
	records: readonly JournalRecord[],
): Set<string> {
	return new Set(
		records.flatMap((record) =>
			record.kind === "wait-claimed" ? [record.feedback.feedbackId] : [],
		),
	);
}

/** Collects history deliveries that were reserved before sendMessage became visible. */
function pendingHistoryFeedbackIds(
	records: readonly JournalRecord[],
): Set<string> {
	return new Set(
		records.flatMap((record) =>
			record.kind === "history-pending" ? [record.feedbackId] : [],
		),
	);
}

/** Creates one durable destination commit from complete feedback identity. */
function commitRecord(
	kind: "wait-committed" | "history-committed",
	feedback: SubagentFeedback,
): JournalRecord {
	return {
		kind,
		feedbackId: feedback.feedbackId,
		invocationId: feedback.invocationId,
		sessionKey: feedback.sessionKey,
	};
}

/** Collects feedback IDs whose durable destination is already committed. */
function committedFeedbackIds(records: readonly JournalRecord[]): Set<string> {
	return new Set(
		records.flatMap((record) =>
			record.kind === "wait-committed" || record.kind === "history-committed"
				? [record.feedbackId]
				: [],
		),
	);
}

/** Applies one append-order record to the logical-session fold. */
function applyRecord(
	sessions: Map<string, LogicalSession>,
	record: JournalRecord,
): void {
	if (record.kind === "session-accepted") {
		sessions.set(keyOf(record.session.key), record.session);
		return;
	}
	if (record.kind === "continuation-accepted") {
		const current = sessions.get(keyOf(record.sessionKey));
		if (current !== undefined) {
			sessions.set(keyOf(record.sessionKey), {
				...current,
				invocationId: record.invocationId,
				runtimeLeaseId: record.runtimeLeaseId,
				...(record.ownerRuntimeLeaseId === undefined
					? {}
					: { ownerRuntimeLeaseId: record.ownerRuntimeLeaseId }),
				invocationMetadata: record.invocationMetadata,
				state: "active",
			});
		}
		return;
	}
	if (record.kind === "terminal") {
		const current = sessions.get(keyOf(record.sessionKey));
		if (current !== undefined && current.invocationId === record.invocationId) {
			sessions.set(keyOf(record.sessionKey), {
				...current,
				...(record.feedback === undefined
					? {}
					: {
							invocationMetadata:
								record.feedback.presentation.invocationMetadata,
						}),
				state: record.state,
			});
		}
	}
}

/** Compares owner-qualified session identities without globalizing local IDs. */
function keysEqual(left: SessionKey, right: SessionKey): boolean {
	return (
		left.ownerPiSessionId === right.ownerPiSessionId &&
		left.ownerLocalSessionId === right.ownerLocalSessionId
	);
}
