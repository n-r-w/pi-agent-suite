import { describe, expect, test } from "bun:test";
import { reduceLiveAgentStatus } from "./live-status";

/** Verifies the child Pi event-to-status state machine. */
describe("reduceLiveAgentStatus", () => {
	test("maps every built-in transient status and preserves conditional clearing", () => {
		// Purpose: the management screen must mirror Pi status transitions without storing presentation text.
		// Inputs and expected output: documented session events produce working, retrying, compacting, branch-summary, or idle state.
		// Edge cases: end events clear only their own status so late events cannot erase a newer status.
		// Dependencies: the pure production event reducer and a deterministic wall-clock value.
		const working = reduceLiveAgentStatus(
			undefined,
			{ type: "agent_start" },
			1_000,
		);
		const retrying = reduceLiveAgentStatus(
			working,
			{
				type: "auto_retry_start",
				attempt: 8,
				maxAttempts: 10,
				delayMs: 96_000,
			},
			1_000,
		);
		const retryReplacedByWorking = reduceLiveAgentStatus(
			retrying,
			{ type: "agent_start" },
			2_000,
		);
		const lateRetryEnd = reduceLiveAgentStatus(
			retryReplacedByWorking,
			{ type: "auto_retry_end" },
			2_000,
		);
		const compacting = reduceLiveAgentStatus(
			lateRetryEnd,
			{ type: "compaction_start", reason: "overflow" },
			2_000,
		);
		const idleAfterCompaction = reduceLiveAgentStatus(
			compacting,
			{ type: "compaction_end" },
			2_000,
		);
		const summarizationRetry = reduceLiveAgentStatus(
			idleAfterCompaction,
			{
				type: "summarization_retry_scheduled",
				attempt: 2,
				maxAttempts: 3,
				delayMs: 4_000,
			},
			3_000,
		);
		const summarizingBranch = reduceLiveAgentStatus(
			summarizationRetry,
			{
				type: "summarization_retry_attempt_start",
				source: "branchSummary",
			},
			7_000,
		);
		const compactingRetry = reduceLiveAgentStatus(
			summarizingBranch,
			{
				type: "summarization_retry_attempt_start",
				source: "compaction",
				reason: "manual",
			},
			7_000,
		);

		expect({
			working,
			retrying,
			lateRetryEnd,
			compacting,
			idleAfterCompaction,
			summarizationRetry,
			summarizingBranch,
			compactingRetry,
		}).toEqual({
			working: { kind: "working" },
			retrying: {
				kind: "retrying",
				attempt: 8,
				maxAttempts: 10,
				deadlineAtMs: 97_000,
			},
			lateRetryEnd: { kind: "working" },
			compacting: { kind: "compacting", reason: "overflow" },
			idleAfterCompaction: undefined,
			summarizationRetry: {
				kind: "retrying",
				attempt: 2,
				maxAttempts: 3,
				deadlineAtMs: 7_000,
			},
			summarizingBranch: { kind: "summarizingBranch" },
			compactingRetry: { kind: "compacting", reason: "manual" },
		});
	});

	test("ignores unknown and malformed status events", () => {
		// Purpose: malformed child output must not corrupt a valid visible status.
		// Inputs and expected output: unknown types and invalid retry or compaction fields preserve the prior state.
		// Edge cases: string numbers, inverted attempts, negative delays, and unknown compaction reasons are rejected.
		// Dependencies: the pure production event reducer.
		const current = { kind: "working" } as const;
		const events = [
			{ type: "unknown" },
			{
				type: "auto_retry_start",
				attempt: "1",
				maxAttempts: 3,
				delayMs: 1_000,
			},
			{
				type: "auto_retry_start",
				attempt: 4,
				maxAttempts: 3,
				delayMs: 1_000,
			},
			{
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 3,
				delayMs: -1,
			},
			{ type: "compaction_start", reason: "unknown" },
		];

		expect(
			events.map((event) => reduceLiveAgentStatus(current, event, 1_000)),
		).toEqual(events.map(() => current));
	});
});
