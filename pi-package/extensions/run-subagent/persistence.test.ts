import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../../../test/support/persisted-session.ts";
import type {
	JournalRecord,
	LogicalSession,
	OwnerIdentity,
	SubagentFeedback,
} from "./domain";
import {
	type ActiveOwnerSessionWriter,
	createHistoryMessage,
	SessionStore,
	SUBAGENT_HISTORY_CUSTOM_TYPE,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
} from "./persistence";

/** Supplies complete accepted invocation facts for durable journal fixtures. */
const INVOCATION_METADATA = {
	startedAtMs: 1_700_000_000_000,
	elapsedMs: 1_000,
	modelId: "openai/test-model",
	thinking: "high",
	contextWindow: 128_000,
	contextTokens: 58_000,
	projectionSavedTokens: 20_000,
} as const;

describe("SessionStore", () => {
	test("exposes rounded invocation seconds in model-visible history feedback", () => {
		// Purpose: automatic feedback must give the owner model the child invocation duration.
		// Input and expected output: success, failure, and abort messages expose whole seconds rounded up with a one-second minimum.
		// Edge case: zero, fractional, and exact-second durations preserve the approved conversion rule.
		// Dependencies: the production history-message projector.
		const key = { ownerPiSessionId: "owner", ownerLocalSessionId: 7 };
		// Stable presentation identity isolates elapsed-time behavior across terminal statuses.
		const presentation = (elapsedMs: number) => ({
			agentId: "SubAgentCoder",
			taskName: "Project history feedback",
			invocationMetadata: { startedAtMs: 0, elapsedMs },
		});

		const contents = [
			createHistoryMessage({
				feedbackId: "success",
				invocationId: "i1",
				sessionKey: key,
				status: "success",
				output: "done",
				presentation: presentation(0),
			}).content,
			createHistoryMessage({
				feedbackId: "failure",
				invocationId: "i2",
				sessionKey: key,
				status: "failure",
				error: "failed",
				presentation: presentation(1_001),
			}).content,
			createHistoryMessage({
				feedbackId: "abort",
				invocationId: "i3",
				sessionKey: key,
				status: "abort",
				error: "aborted",
				presentation: presentation(2_000),
			}).content,
		];

		expect(contents).toEqual([
			"Subagent 7 completed successfully:\nDuration: 1 seconds\ndone",
			"Subagent 7 finished with failure:\nDuration: 2 seconds\nfailed",
			"Subagent 7 finished with abort:\nDuration: 2 seconds\naborted",
		]);
	});

	test("reconciles public SessionManager evidence idempotently", async () => {
		// Purpose: public Pi persistence must preserve one feedback destination across reopen and repeated reconciliation.
		// Input and expected output: depth-zero reconstruction hides sessions while one pending terminal feedback becomes one history message and one history commit.
		// Edge case: a second depth-zero reopen appends neither artifact again and preserves the stable key and terminal state.
		// Dependencies: system temporary files and public SessionManager create, append, getBranch, custom-message, and open APIs.
		const directory = mkdtempSync(join(tmpdir(), "subagents-session-"));
		try {
			const store = new SessionStore();
			const manager = createPersistedSession(directory);
			const sessionFile = manager.getSessionFile();
			if (sessionFile === undefined) {
				throw new Error("public SessionManager did not create a session file");
			}
			const owner: OwnerIdentity = {
				ownerPiSessionId: manager.getSessionId(),
				ownerSessionFile: sessionFile,
			};
			const accepted: JournalRecord = {
				kind: "session-accepted",
				session: {
					key: {
						ownerPiSessionId: owner.ownerPiSessionId,
						ownerLocalSessionId: 1,
					},
					childPiSessionId: "child-pi",
					childSessionDir: directory,
					childSessionFile: join(directory, "child.jsonl"),
					agentId: "SubAgentCoder",
					taskName: "Trace runtime",
					creationOrder: 1,
					invocationId: "invocation-1",
					runtimeLeaseId: "lease-1",
					invocationMetadata: INVOCATION_METADATA,
					state: "active",
				},
			};
			const terminal: JournalRecord = {
				kind: "terminal",
				sessionKey: accepted.session.key,
				invocationId: "invocation-1",
				state: "terminal-success",
				disposition: "pending",
				feedback: {
					feedbackId: "feedback-1",
					invocationId: "invocation-1",
					sessionKey: accepted.session.key,
					status: "success",
					output: "done",
					presentation: {
						agentId: accepted.session.agentId,
						taskName: accepted.session.taskName,
						invocationMetadata: INVOCATION_METADATA,
					},
				} as unknown as SubagentFeedback,
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, accepted);
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, terminal);

			let first = SessionManager.open(sessionFile, directory, directory);
			try {
				await store.reconstruct(first);
			} catch {}
			first = SessionManager.open(sessionFile, directory, directory);
			try {
				await store.reconstruct(first);
			} catch {}
			const reopened = SessionManager.open(sessionFile, directory, directory);
			const branch = reopened.getBranch();
			const historyEntries = branch.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" &&
					entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
			);
			const historyCount = historyEntries.length;
			const commitCount = branch.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
					isHistoryCommit(entry.data),
			).length;
			const folded = safeFold(store, branch);
			const reconstructed = await store.reconstruct(reopened);

			expect({
				reconstructed: reconstructed.map((session) => ({
					key: session.key,
					state: session.state,
				})),
				historyCount,
				commitCount,
				stableKey: folded?.sessions[0]?.key,
				state: terminal.state,
				historyDetails: historyEntries[0]?.details,
			}).toEqual({
				reconstructed: [
					{ key: accepted.session.key, state: "terminal-success" },
				],
				historyCount: 1,
				commitCount: 1,
				stableKey: accepted.session.key,
				state: "terminal-success",
				historyDetails: terminal.feedback,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reconstructs every saved descendant independently from maxDepth", async () => {
		// Purpose: delegation limits must not hide or leave historical descendant journals unreconciled.
		// Input and expected output: every reconstruction returns B and C and commits C feedback in B.
		// Edge case: repeated reconstruction keeps one history message and one commit while unmatched active sessions become terminal-aborted.
		// Dependencies: public persisted SessionManager instances under a system temporary directory.
		const directory = mkdtempSync(join(tmpdir(), "subagents-reconstruct-"));
		try {
			const child = createPersistedSession(join(directory, "child"));
			const childFile = child.getSessionFile();
			if (childFile === undefined) {
				throw new Error("child SessionManager did not create a session file");
			}
			const childSession = {
				key: {
					ownerPiSessionId: child.getSessionId(),
					ownerLocalSessionId: 1,
				},
				childPiSessionId: "grandchild-pi",
				childSessionDir: join(directory, "grandchild"),
				childSessionFile: join(directory, "missing-grandchild.jsonl"),
				agentId: "SubAgentCoder",
				taskName: "Trace child",
				creationOrder: 1,
				invocationId: "child-invocation",
				runtimeLeaseId: "child-lease",
				invocationMetadata: INVOCATION_METADATA,
				state: "active" as const,
			};
			child.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: childSession,
			} satisfies JournalRecord);
			child.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "terminal",
				sessionKey: childSession.key,
				invocationId: childSession.invocationId,
				state: "terminal-success",
				disposition: "pending",
				feedback: {
					feedbackId: "child-feedback",
					invocationId: childSession.invocationId,
					sessionKey: childSession.key,
					status: "success",
					output: "C completed",
					presentation: {
						agentId: childSession.agentId,
						taskName: childSession.taskName,
						invocationMetadata: childSession.invocationMetadata,
					},
				},
			} satisfies JournalRecord);
			const parent = createPersistedSession(join(directory, "parent"));
			const parentSession = {
				key: {
					ownerPiSessionId: parent.getSessionId(),
					ownerLocalSessionId: 1,
				},
				childPiSessionId: child.getSessionId(),
				childSessionDir: child.getSessionDir(),
				childSessionFile: childFile,
				agentId: "SubAgentCoder",
				taskName: "Trace parent",
				creationOrder: 1,
				invocationId: "parent-invocation",
				runtimeLeaseId: "parent-lease",
				invocationMetadata: INVOCATION_METADATA,
				state: "active" as const,
			};
			parent.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: parentSession,
			} satisfies JournalRecord);
			const store = new SessionStore();
			const firstReconstruction = await store.reconstruct(parent);
			const childAfterFirst = SessionManager.open(
				childFile,
				child.getSessionDir(),
				child.getCwd(),
			);
			expect({
				firstReconstruction: firstReconstruction.map((session) => session.key),
				historyCount: childAfterFirst
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
					).length,
				commitCount: childAfterFirst
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
							isHistoryCommit(entry.data),
					).length,
			}).toEqual({
				firstReconstruction: [parentSession.key, childSession.key],
				historyCount: 1,
				commitCount: 1,
			});

			const secondReconstruction = await store.reconstruct(parent);
			const childAfterSecond = SessionManager.open(
				childFile,
				child.getSessionDir(),
				child.getCwd(),
			);
			const secondBranch = childAfterSecond.getBranch();
			const secondHistoryCount = secondBranch.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
			).length;
			const secondCommitCount = secondBranch.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
					isHistoryCommit(entry.data),
			).length;

			expect({
				secondReconstruction: secondReconstruction.map(
					(session) => session.key,
				),
				secondHistoryCount,
				secondCommitCount,
			}).toEqual({
				secondReconstruction: [parentSession.key, childSession.key],
				secondHistoryCount: 1,
				secondCommitCount: 1,
			});

			const repeatedReconstruction = await store.reconstruct(parent);
			const childAfterRepeated = SessionManager.open(
				childFile,
				child.getSessionDir(),
				child.getCwd(),
			);
			const repeatedBranch = childAfterRepeated.getBranch();
			const finalReconstruction = await store.reconstruct(parent);

			expect({
				firstReconstruction: firstReconstruction.map((session) => session.key),
				repeatedReconstruction: repeatedReconstruction.map(
					(session) => session.key,
				),
				finalReconstruction: finalReconstruction.map((session) => session.key),
				states: finalReconstruction.map((session) => session.state),
				repeatedHistoryCount: repeatedBranch.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
				).length,
				repeatedCommitCount: repeatedBranch.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
						isHistoryCommit(entry.data),
				).length,
				parentDisposition: lastTerminalDisposition(parent.getBranch()),
				childDisposition: lastTerminalDisposition(repeatedBranch),
			}).toEqual({
				firstReconstruction: [parentSession.key, childSession.key],
				repeatedReconstruction: [parentSession.key, childSession.key],
				finalReconstruction: [parentSession.key, childSession.key],
				states: ["terminal-aborted", "terminal-success"],
				repeatedHistoryCount: 1,
				repeatedCommitCount: 1,
				parentDisposition: "withheld-forced-abort",
				childDisposition: "pending",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("stops reconstruction when saved session files form a cycle", async () => {
		// Purpose: showing all historical descendants must remain finite for repeated saved-file references.
		// Input and expected output: A points to B and B points to A, while reconstruction returns each edge once.
		// Edge case: different owner IDs and files cannot rely on the delegation depth as a traversal guard.
		// Dependencies: public persisted SessionManager files and production recursive reconstruction.
		const directory = mkdtempSync(join(tmpdir(), "subagents-cycle-"));
		try {
			const first = createPersistedSession(join(directory, "first"), {
				id: "first-owner",
				text: "first owner",
			});
			const second = createPersistedSession(join(directory, "second"), {
				id: "second-owner",
				text: "second owner",
			});
			const firstFile = first.getSessionFile();
			const secondFile = second.getSessionFile();
			if (firstFile === undefined || secondFile === undefined) {
				throw new Error("cycle fixtures did not create session files");
			}
			const firstChild: LogicalSession = {
				key: { ownerPiSessionId: first.getSessionId(), ownerLocalSessionId: 1 },
				childPiSessionId: second.getSessionId(),
				childSessionDir: second.getSessionDir(),
				childSessionFile: secondFile,
				agentId: "SubAgentCoder",
				taskName: "Visit second",
				creationOrder: 1,
				invocationId: "first-invocation",
				runtimeLeaseId: "first-lease",
				invocationMetadata: INVOCATION_METADATA,
				state: "active",
			};
			const secondChild: LogicalSession = {
				...firstChild,
				key: {
					ownerPiSessionId: second.getSessionId(),
					ownerLocalSessionId: 1,
				},
				childPiSessionId: first.getSessionId(),
				childSessionDir: first.getSessionDir(),
				childSessionFile: firstFile,
				taskName: "Visit first",
				invocationId: "second-invocation",
				runtimeLeaseId: "second-lease",
			};
			first.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: firstChild,
			} satisfies JournalRecord);
			second.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: secondChild,
			} satisfies JournalRecord);

			const reconstructed = await new SessionStore().reconstruct(first);

			expect(reconstructed.map((session) => session.key)).toEqual([
				firstChild.key,
				secondChild.key,
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rebases fold state at the last owner snapshot boundary", () => {
		// Purpose: an owner snapshot must replace stale session and reconciliation state while preserving later append-order updates.
		// Input and expected output: two snapshots, a stale earlier session, and later continuation and terminal records produce only the last snapshot and its terminal session.
		// Edge case: an empty first snapshot and a non-empty last snapshot prove that the last boundary wins and that zero-session snapshots are valid.
		// Dependencies: public SessionManager custom entries, closed journal parsing, and SessionStore.fold.
		const directory = mkdtempSync(join(tmpdir(), "subagents-owner-snapshot-"));
		try {
			const manager = createPersistedSession(directory);
			const ownerPiSessionId = manager.getSessionId();
			const staleSession: LogicalSession = {
				key: { ownerPiSessionId, ownerLocalSessionId: 1 },
				childPiSessionId: "stale-child",
				childSessionDir: directory,
				childSessionFile: join(directory, "stale-child.jsonl"),
				agentId: "SubAgentCoder",
				taskName: "Stale session",
				creationOrder: 1,
				invocationId: "stale-invocation",
				runtimeLeaseId: "stale-lease",
				invocationMetadata: INVOCATION_METADATA,
				state: "active",
			};
			const snapshotSession: LogicalSession = {
				...staleSession,
				key: { ownerPiSessionId, ownerLocalSessionId: 2 },
				childPiSessionId: "snapshot-child",
				childSessionFile: join(directory, "snapshot-child.jsonl"),
				invocationId: "snapshot-invocation",
				runtimeLeaseId: "snapshot-lease",
				state: "terminal-success",
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: staleSession,
			});
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "history-pending",
				feedbackId: "stale-feedback",
				invocationId: staleSession.invocationId,
				sessionKey: staleSession.key,
			});
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "owner-snapshot",
				ownerPiSessionId,
				sessions: [],
			});
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "owner-snapshot",
				ownerPiSessionId,
				sessions: [snapshotSession],
			});
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "continuation-accepted",
				sessionKey: snapshotSession.key,
				invocationId: "continued-invocation",
				runtimeLeaseId: "continued-lease",
				invocationMetadata: INVOCATION_METADATA,
			});
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "terminal",
				sessionKey: snapshotSession.key,
				invocationId: "continued-invocation",
				state: "terminal-success",
				disposition: "pending",
			});

			const folded = new SessionStore().fold(manager.getBranch());

			expect(folded.records).toEqual([
				{
					kind: "owner-snapshot",
					ownerPiSessionId,
					sessions: [snapshotSession],
				},
				{
					kind: "continuation-accepted",
					sessionKey: snapshotSession.key,
					invocationId: "continued-invocation",
					runtimeLeaseId: "continued-lease",
					invocationMetadata: INVOCATION_METADATA,
				},
				{
					kind: "terminal",
					sessionKey: snapshotSession.key,
					invocationId: "continued-invocation",
					state: "terminal-success",
					disposition: "pending",
				},
			]);
			expect(folded.sessions).toEqual([
				{
					...snapshotSession,
					invocationId: "continued-invocation",
					runtimeLeaseId: "continued-lease",
					invocationMetadata: INVOCATION_METADATA,
				},
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("folds current parent lease from nested continuation records", () => {
		// Purpose: durable continuation state must replace the nested session's prior parent runtime lease.
		// Input and expected output: terminal session under old-parent becomes active under new-parent with the continued invocation and runtime lease.
		// Edge case: the continuation retains the same stable session key and saved child session reference.
		// Dependencies: public SessionManager journal entries and production journal folding.
		const directory = mkdtempSync(join(tmpdir(), "subagents-parent-lease-"));
		try {
			const manager = createPersistedSession(directory);
			const session = {
				key: {
					ownerPiSessionId: manager.getSessionId(),
					ownerLocalSessionId: 1,
				},
				childPiSessionId: "nested-child",
				childSessionDir: join(directory, "child"),
				childSessionFile: join(directory, "child", "session.jsonl"),
				agentId: "SubAgentCoder",
				taskName: "Refresh parent lease",
				creationOrder: 1,
				invocationId: "old-invocation",
				runtimeLeaseId: "old-child-lease",
				ownerRuntimeLeaseId: "old-parent-lease",
				invocationMetadata: INVOCATION_METADATA,
				state: "terminal-success" as const,
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session,
			});
			const continuedMetadata = {
				...INVOCATION_METADATA,
				startedAtMs: 1_700_000_010_000,
				elapsedMs: 500,
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "continuation-accepted",
				sessionKey: session.key,
				invocationId: "new-invocation",
				runtimeLeaseId: "new-child-lease",
				ownerRuntimeLeaseId: "new-parent-lease",
				invocationMetadata: continuedMetadata,
			});
			const folded = new SessionStore().fold(manager.getBranch());

			expect(folded.sessions).toEqual([
				{
					...session,
					invocationId: "new-invocation",
					runtimeLeaseId: "new-child-lease",
					ownerRuntimeLeaseId: "new-parent-lease",
					invocationMetadata: continuedMetadata,
					state: "active",
				},
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("releases a failed lease writer before idempotent offline reconciliation", async () => {
		// Purpose: failed remote persistence must become offline-writable only after explicit lease release.
		// Input and expected output: one rejected remote append is followed by one released owner and one durable forced-abort record across two reconciliations.
		// Edge case: the unmatched active session keeps its stable key and receives no duplicate terminal record.
		// Dependencies: public SessionManager file, production remote routing, lease release, and offline reconstruction.
		// Arrange.
		const directory = mkdtempSync(join(tmpdir(), "subagents-release-"));
		try {
			const manager = createPersistedSession(directory);
			const sessionFile = manager.getSessionFile();
			if (sessionFile === undefined) {
				throw new Error("public SessionManager did not create a session file");
			}
			const owner: OwnerIdentity = {
				ownerPiSessionId: manager.getSessionId(),
				ownerSessionFile: sessionFile,
			};
			const accepted: JournalRecord = {
				kind: "session-accepted",
				session: {
					key: {
						ownerPiSessionId: owner.ownerPiSessionId,
						ownerLocalSessionId: 1,
					},
					childPiSessionId: "stopped-child",
					childSessionDir: directory,
					childSessionFile: join(directory, "missing-child.jsonl"),
					agentId: "SubAgentCoder",
					taskName: "Recover stopped writer",
					creationOrder: 1,
					invocationId: "stopped-invocation",
					runtimeLeaseId: "stopped-child-lease",
					invocationMetadata: INVOCATION_METADATA,
					state: "active",
				},
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, accepted);
			const store = new SessionStore({
				append: async () => {
					throw new Error("remote writer failed");
				},
				appendHistory: async () => {
					throw new Error("remote writer failed");
				},
			});
			store.registerActive({
				owner,
				sessionManager: manager,
				appendJournal: (record) => {
					manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				},
				appendHistory: () => undefined,
			});
			const evidenceBeforeRemote = await store.hasAcceptedInvocationEvidence(
				owner,
				accepted.session.key,
				accepted.session.invocationId,
			);
			store.unregisterActive(owner.ownerPiSessionId);
			store.registerRemote(owner, "failed-runtime-lease");
			const evidenceWhileRemote = await store.hasAcceptedInvocationEvidence(
				owner,
				accepted.session.key,
				accepted.session.invocationId,
			);

			// Act.
			let appendRejected = false;
			try {
				await store.append(owner, {
					kind: "terminal",
					sessionKey: accepted.session.key,
					invocationId: accepted.session.invocationId,
					state: "terminal-aborted",
					disposition: "withheld-forced-abort",
				});
			} catch {
				appendRejected = true;
			}
			const released = store.releaseRemoteLease("failed-runtime-lease");
			const evidenceAfterRelease = await store.hasAcceptedInvocationEvidence(
				owner,
				accepted.session.key,
				accepted.session.invocationId,
			);
			await store.reconcileOffline(owner);
			await store.reconcileOffline(owner);
			const reopened = SessionManager.open(sessionFile, directory, directory);
			const folded = store.fold(reopened.getBranch());

			// Assert.
			expect({
				appendRejected,
				evidenceBeforeRemote,
				evidenceWhileRemote,
				evidenceAfterRelease,
				released,
				sessions: folded.sessions.map((session) => ({
					key: session.key,
					state: session.state,
				})),
				terminalRecords: folded.records.filter(
					(record) => record.kind === "terminal",
				).length,
			}).toEqual({
				appendRejected: true,
				evidenceBeforeRemote: true,
				evidenceWhileRemote: false,
				evidenceAfterRelease: true,
				released: [owner],
				sessions: [
					{
						key: accepted.session.key,
						state: "terminal-aborted",
					},
				],
				terminalRecords: 1,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps an active wait claim out of history until tool-result evidence exists", async () => {
		// Purpose: active reconciliation must not duplicate feedback while Pi is appending the claimed wait result.
		// Input and expected output: a claimed terminal stays pending before the tool result, then gains one wait commit without history.
		// Edge case: message-end reconciliation can run between wait-claimed durability and Pi's tool-result append.
		// Dependencies: active public SessionManager writer and exact feedback identity matching.
		const directory = mkdtempSync(join(tmpdir(), "subagents-active-claim-"));
		try {
			const manager = createPersistedSession(directory);
			const sessionFile = manager.getSessionFile();
			if (sessionFile === undefined) {
				throw new Error("public SessionManager did not create a session file");
			}
			const owner: OwnerIdentity = {
				ownerPiSessionId: manager.getSessionId(),
				ownerSessionFile: sessionFile,
			};
			const feedback: SubagentFeedback = {
				feedbackId: "feedback-active-claim",
				invocationId: "invocation-active-claim",
				sessionKey: {
					ownerPiSessionId: owner.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				status: "success",
				output: "done",
				presentation: {
					agentId: "SubAgentCoder",
					taskName: "Trace active claim",
					invocationMetadata: INVOCATION_METADATA,
				},
			};
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "terminal",
				sessionKey: feedback.sessionKey,
				invocationId: feedback.invocationId,
				state: "terminal-success",
				disposition: "pending",
				feedback,
			} satisfies JournalRecord);
			manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "wait-claimed",
				feedback,
				waitToolCallId: "wait-call",
				waitRequestId: "wait-request",
			} satisfies JournalRecord);
			const historyFeedbackIds: string[] = [];
			const store = new SessionStore();
			const writer = {
				owner,
				sessionManager: manager,
				appendJournal: (record: JournalRecord) => {
					manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				},
				appendHistory: (value: SubagentFeedback) => {
					historyFeedbackIds.push(value.feedbackId);
				},
			};

			await store.reconcileActive(writer);
			const commitsBeforeResult = manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
						isWaitCommit(entry.data),
				).length;
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "wait-call",
				toolName: "subagent_wait",
				content: [{ type: "text", text: '{"outcome":"feedback"}' }],
				details: { feedbackId: feedback.feedbackId },
				isError: false,
				timestamp: 2,
			});
			await store.reconcileActive(writer);
			const commitsAfterResult = manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
						isWaitCommit(entry.data),
				).length;

			expect({
				historyFeedbackIds,
				commitsBeforeResult,
				commitsAfterResult,
			}).toEqual({
				historyFeedbackIds: [],
				commitsBeforeResult: 0,
				commitsAfterResult: 1,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("serializes reentrant active reconciliation for concurrent feedback", async () => {
		// Purpose: a feedback insertion that re-enters message reconciliation must not replay every pending terminal record.
		// Input and expected output: two pending feedback obligations each produce one history message despite one synchronous re-entry.
		// Edge case: the nested scan starts before the first history evidence is appended, matching Pi sendMessage event re-entry.
		// Dependencies: public session-entry shapes and the active owner reconciliation boundary.
		const owner: OwnerIdentity = {
			ownerPiSessionId: "owner-reentrant",
			ownerSessionFile: "/tmp/owner-reentrant.jsonl",
		};
		const entries: SessionEntry[] = [];
		const feedbacks = [1, 2].map(
			(id): SubagentFeedback => ({
				feedbackId: `feedback-reentrant-${id}`,
				invocationId: `invocation-reentrant-${id}`,
				sessionKey: {
					ownerPiSessionId: owner.ownerPiSessionId,
					ownerLocalSessionId: id,
				},
				status: "success",
				output: "OK",
				presentation: {
					agentId: "SubAgentAnalystJunior",
					taskName: `Check ${id}`,
					invocationMetadata: INVOCATION_METADATA,
				},
			}),
		);
		for (const [index, feedback] of feedbacks.entries()) {
			entries.push({
				type: "custom",
				customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
				data: {
					kind: "terminal",
					sessionKey: feedback.sessionKey,
					invocationId: feedback.invocationId,
					state: "terminal-success",
					disposition: "pending",
					feedback,
				} satisfies JournalRecord,
				id: `terminal-${index}`,
				parentId: null,
				timestamp: new Date(index).toISOString(),
			});
		}
		const store = new SessionStore();
		const historyFeedbackIds: string[] = [];
		let reentered = false;
		let nestedReconciliation: Promise<void> | undefined;
		let sequence = entries.length;
		const sessionManager = {
			getBranch: () => entries,
		} as unknown as ActiveOwnerSessionWriter["sessionManager"];
		const writer: ActiveOwnerSessionWriter = {
			owner,
			sessionManager,
			appendJournal: (record) => {
				sequence += 1;
				entries.push({
					type: "custom",
					customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
					data: record,
					id: `journal-${sequence}`,
					parentId: null,
					timestamp: new Date(sequence).toISOString(),
				});
			},
			appendHistory: (feedback) => {
				historyFeedbackIds.push(feedback.feedbackId);
				if (!reentered) {
					reentered = true;
					nestedReconciliation = store.reconcileActive(writer);
				}
				// Pi queues sendMessage delivery, so branch evidence is not visible yet.
			},
		};

		await store.reconcileActive(writer);
		await nestedReconciliation;

		expect(historyFeedbackIds).toEqual([
			"feedback-reentrant-1",
			"feedback-reentrant-2",
		]);
	});

	test("writes inactive history and finds active-branch wait evidence", async () => {
		// Purpose: public SessionManager access must support both inactive-owner history and wait-result evidence.
		// Input and expected output: one offline feedback append is idempotent and one subagent_wait tool result matches its feedback ID.
		// Edge case: reopening the owner twice does not duplicate the history message.
		// Dependencies: system temporary files and public SessionManager append, open, and getBranch methods.
		const directory = mkdtempSync(join(tmpdir(), "subagents-evidence-"));
		try {
			const manager = createPersistedSession(directory);
			const sessionFile = manager.getSessionFile();
			if (sessionFile === undefined) {
				throw new Error("public SessionManager did not create a session file");
			}
			const owner: OwnerIdentity = {
				ownerPiSessionId: manager.getSessionId(),
				ownerSessionFile: sessionFile,
			};
			const feedback = {
				feedbackId: "feedback-evidence",
				invocationId: "invocation-evidence",
				sessionKey: {
					ownerPiSessionId: owner.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				status: "success" as const,
				output: "complete",
				presentation: {
					agentId: "SubAgentCoder",
					taskName: "Trace persistence",
					invocationMetadata: INVOCATION_METADATA,
				},
			};
			const waitResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "wait-call",
				toolName: "subagent_wait",
				content: [{ type: "text", text: '{"outcome":"feedback"}' }],
				details: { feedbackId: feedback.feedbackId },
				isError: false,
				timestamp: 2,
			};
			manager.appendMessage(waitResult);
			const store = new SessionStore();
			await store.appendHistory(owner, feedback);
			await store.appendHistory(owner, feedback);
			const reopened = SessionManager.open(sessionFile, directory, directory);

			expect({
				waitEvidence: await store.hasWaitEvidence(owner, feedback.feedbackId),
				historyEvidence: await store.hasHistoryEvidence(
					owner,
					feedback.feedbackId,
				),
				historyCount: reopened
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE,
					).length,
			}).toEqual({
				waitEvidence: true,
				historyEvidence: true,
				historyCount: 1,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

/** Reads the last durable terminal disposition from public branch entries. */
function lastTerminalDisposition(
	entries: ReturnType<SessionManager["getBranch"]>,
): unknown {
	return entries
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			"kind" in entry.data &&
			entry.data.kind === "terminal" &&
			"disposition" in entry.data
				? [entry.data.disposition]
				: [],
		)
		.at(-1);
}

/** Recognizes a durable wait-result commit in one public journal entry. */
function isWaitCommit(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "wait-committed"
	);
}

/** Recognizes only the journal commit discriminator needed by this behavior test. */
function isHistoryCommit(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "history-committed"
	);
}

/** Returns undefined when journal folding fails so the assertion reports missing reconstructed state. */
function safeFold(
	store: SessionStore,
	entries: ReturnType<SessionManager["getBranch"]>,
): ReturnType<SessionStore["fold"]> | undefined {
	try {
		return store.fold(entries);
	} catch {
		return undefined;
	}
}
