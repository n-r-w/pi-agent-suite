import { describe, expect, test } from "bun:test";
import type { JournalRecord, LogicalSession, SubagentFeedback } from "./domain";
import { parseFeedback, parseJournalRecord } from "./journal-codec";

const SESSION: LogicalSession = {
	key: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
	childPiSessionId: "child-1",
	childSessionDir: "/tmp/child",
	childSessionFile: "/tmp/child/session.jsonl",
	agentId: "SubAgentCoder",
	taskName: "Trace journal",
	creationOrder: 1,
	invocationId: "invocation-1",
	runtimeLeaseId: "lease-1",
	ownerRuntimeLeaseId: "parent-lease",
	invocationMetadata: {
		startedAtMs: 1_700_000_000_000,
		elapsedMs: 2_000,
		modelId: "openai/test-model",
		thinking: "high",
		contextWindow: 128_000,
		contextTokens: 58_000,
		projectionSavedTokens: 20_000,
	},
	state: "active",
} as unknown as LogicalSession;
const FEEDBACK = {
	feedbackId: "feedback-1",
	invocationId: "invocation-1",
	sessionKey: SESSION.key,
	status: "success",
	output: "done",
	presentation: {
		agentId: SESSION.agentId,
		taskName: SESSION.taskName,
		invocationMetadata: SESSION.invocationMetadata,
	},
} as unknown as SubagentFeedback;

describe("journal codec", () => {
	test("parses every durable record discriminator", () => {
		// Purpose: unknown persisted data must enter the runtime only through the closed journal union.
		// Input and expected output: every journal discriminator round-trips to the corresponding validated record.
		// Edge case: terminal feedback is optional while owner runtime identity remains optional on accepted sessions.
		// Dependencies: production journal parser and representative V2 domain values.
		const records: JournalRecord[] = [
			{ kind: "session-accepted", session: SESSION },
			{
				kind: "continuation-accepted",
				sessionKey: SESSION.key,
				invocationId: "invocation-2",
				runtimeLeaseId: "lease-2",
				invocationMetadata: {
					startedAtMs: 1_700_000_010_000,
					elapsedMs: 1_000,
					modelId: "openai/test-model-2",
					contextWindow: 200_000,
				},
			},
			{
				kind: "terminal",
				sessionKey: SESSION.key,
				invocationId: "invocation-1",
				state: "terminal-success",
				disposition: "pending",
				feedback: FEEDBACK,
			},
			{
				kind: "terminal",
				sessionKey: SESSION.key,
				invocationId: "invocation-1",
				state: "terminal-aborted",
				disposition: "withheld-forced-abort",
			},
			{
				kind: "wait-claimed",
				feedback: FEEDBACK,
				waitToolCallId: "wait-call",
				waitRequestId: "wait-request",
			},
			{
				kind: "history-pending",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
			},
			{
				kind: "wait-committed",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
			},
			{
				kind: "history-committed",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
			},
		];

		expect(records.map((record) => parseJournalRecord(record))).toEqual(
			records,
		);
	});

	test("rejects malformed records and parses both feedback variants", () => {
		// Purpose: malformed session data must fail closed without partial domain objects.
		// Input and expected output: success and failure feedback parse while malformed records return undefined.
		// Edge case: non-canonical IDs, illegal states, mismatched payload fields, and unknown kinds are rejected.
		// Dependencies: production journal and feedback boundary parsers.
		const failure = {
			feedbackId: "feedback-2",
			invocationId: "invocation-2",
			sessionKey: SESSION.key,
			status: "failure",
			error: "failed",
			presentation: FEEDBACK.presentation,
		} as unknown as SubagentFeedback;
		const malformed: unknown[] = [
			null,
			{},
			{ kind: "unknown" },
			{ kind: "session-accepted", session: { ...SESSION, state: "invalid" } },
			{
				kind: "continuation-accepted",
				sessionKey: { ownerPiSessionId: "", ownerLocalSessionId: 0 },
				invocationId: "invocation",
				runtimeLeaseId: "lease",
				invocationMetadata: { startedAtMs: 1 },
			},
			{
				kind: "invocation-metadata",
				sessionKey: SESSION.key,
				invocationId: "invocation",
				invocationMetadata: { startedAtMs: 1 },
			},
			{
				kind: "invocation-metadata",
				sessionKey: SESSION.key,
				invocationId: "invocation",
				invocationMetadata: {
					startedAtMs: 1,
					elapsedMs: 1,
					contextTokens: 1,
				},
			},
			{
				kind: "terminal",
				sessionKey: SESSION.key,
				invocationId: "invocation",
				state: "active",
				disposition: "pending",
			},
			{
				kind: "wait-claimed",
				feedback: { ...FEEDBACK, output: undefined },
				waitToolCallId: "wait",
				waitRequestId: "request",
			},
			{
				kind: "history-pending",
				feedbackId: "",
				invocationId: "invocation",
				sessionKey: SESSION.key,
			},
		];

		expect({
			feedback: [parseFeedback(FEEDBACK), parseFeedback(failure)],
			malformed: malformed.map(parseJournalRecord),
			malformedFeedback: parseFeedback({ ...failure, error: 1 }),
		}).toEqual({
			feedback: [FEEDBACK, failure],
			malformed: malformed.map(() => undefined),
			malformedFeedback: undefined,
		});
	});

	test("rejects unknown fields throughout journal and feedback objects", () => {
		// Purpose: journal and history IPC values must remain closed at every nested object boundary.
		// Input and expected output: every record discriminator plus session, key, and feedback extras return undefined.
		// Edge case: success, failure, and abort feedback variants reject the same unknown field without normalization.
		// Dependencies: production journal, logical-session, stable-key, and feedback parsers.
		const journalExtras: unknown[] = [
			{ kind: "session-accepted", session: SESSION, extra: true },
			{
				kind: "continuation-accepted",
				sessionKey: SESSION.key,
				invocationId: "invocation-2",
				runtimeLeaseId: "lease-2",
				extra: true,
			},
			{
				kind: "invocation-metadata",
				sessionKey: SESSION.key,
				invocationId: "invocation-1",
				invocationMetadata: SESSION.invocationMetadata,
				extra: true,
			},
			{
				kind: "terminal",
				sessionKey: SESSION.key,
				invocationId: "invocation-1",
				state: "terminal-success",
				disposition: "pending",
				feedback: FEEDBACK,
				extra: true,
			},
			{
				kind: "wait-claimed",
				feedback: FEEDBACK,
				waitToolCallId: "wait-call",
				waitRequestId: "wait-request",
				extra: true,
			},
			{
				kind: "history-pending",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
				extra: true,
			},
			{
				kind: "wait-committed",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
				extra: true,
			},
			{
				kind: "history-committed",
				feedbackId: FEEDBACK.feedbackId,
				invocationId: FEEDBACK.invocationId,
				sessionKey: FEEDBACK.sessionKey,
				extra: true,
			},
		];
		const failureFeedback = {
			feedbackId: "feedback-2",
			invocationId: "invocation-2",
			sessionKey: SESSION.key,
			status: "failure",
			error: "failed",
			extra: true,
		};
		const abortFeedback = {
			feedbackId: "feedback-3",
			invocationId: "invocation-3",
			sessionKey: SESSION.key,
			status: "abort",
			error: "aborted",
			extra: true,
		};

		expect({
			journalExtras: journalExtras.map(parseJournalRecord),
			logicalSessionExtra: parseJournalRecord({
				kind: "session-accepted",
				session: { ...SESSION, extra: true },
			}),
			stableKeyExtra: parseJournalRecord({
				kind: "continuation-accepted",
				sessionKey: { ...SESSION.key, extra: true },
				invocationId: "invocation-2",
				runtimeLeaseId: "lease-2",
			}),
			feedbackExtras: [
				parseFeedback({ ...FEEDBACK, extra: true }),
				parseFeedback(failureFeedback),
				parseFeedback(abortFeedback),
			],
		}).toEqual({
			journalExtras: journalExtras.map(() => undefined),
			logicalSessionExtra: undefined,
			stableKeyExtra: undefined,
			feedbackExtras: [undefined, undefined, undefined],
		});
	});
});
