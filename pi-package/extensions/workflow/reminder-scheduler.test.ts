import { describe, expect, test } from "bun:test";
import { WorkflowReminderScheduler } from "./reminder-scheduler";

describe("workflow reminder scheduler", () => {
	/**
	 * Proves completed tool calls accumulate across turns and trigger at the configured interval.
	 * Input and expected output: batches of 20 and 30 at interval 50 return false and then true.
	 * Edge case: the threshold is reached across separate turns.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("schedules after completed tool calls reach the interval", () => {
		const scheduler = new WorkflowReminderScheduler(50);

		scheduler.startTurn();
		expect(scheduler.completeTurn(20, false, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(30, false, true, false)).toBe(true);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, true, false)).toBe(false);
	});

	/**
	 * Proves one parallel batch can schedule at most one reminder and its overshoot is discarded.
	 * Input and expected output: 125 calls return one true decision, then 49 calls remain below threshold.
	 * Edge case: a batch exceeds two complete intervals.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("discards parallel batch overshoot", () => {
		const scheduler = new WorkflowReminderScheduler(50);

		scheduler.startTurn();
		expect(scheduler.completeTurn(125, false, true, false)).toBe(true);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, true, false)).toBe(false);
	});

	/**
	 * Proves fresh workflow state resets the interval and excludes that turn's tool batch.
	 * Input and expected output: 40 calls, publication in a 20-call turn, then 49 and 1 calls trigger only at the end.
	 * Edge case: publication and a threshold-crossing batch occur in the same turn.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("resets and skips a turn that publishes workflow state", () => {
		const scheduler = new WorkflowReminderScheduler(50);

		scheduler.startTurn();
		expect(scheduler.completeTurn(40, false, true, false)).toBe(false);
		scheduler.startTurn();
		scheduler.workflowStatePublished();
		expect(scheduler.completeTurn(20, false, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(1, false, true, false)).toBe(true);
	});

	/**
	 * Proves an all-terminating batch suppresses its decision without discarding completed-call progress.
	 * Input and expected output: two terminating calls do not schedule, then one ordinary call reaches interval three.
	 * Edge case: the suppressed batch remains counted for a later non-terminating batch.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("suppresses only all-terminating tool batches", () => {
		const scheduler = new WorkflowReminderScheduler(3);

		scheduler.startTurn();
		expect(scheduler.completeTurn(2, false, true, true)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(1, false, true, false)).toBe(true);
	});

	/**
	 * Proves reasoning-only turns can reach the configured reminder interval.
	 * Input and expected output: two reasoning turns return false and then true at interval two.
	 * Edge case: neither turn has tool results.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("schedules after reasoning-only turns reach the interval", () => {
		const scheduler = new WorkflowReminderScheduler(2);

		scheduler.startTurn();
		expect(scheduler.completeTurn(0, true, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(0, true, true, false)).toBe(true);
	});

	/**
	 * Proves a zero-activity turn cannot release a reminder deferred by a terminating batch.
	 * Input and expected output: two terminating calls retain progress, an empty turn does nothing, then one tool call schedules.
	 * Edge case: retained progress already equals the configured interval before the empty turn.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("does not schedule retained progress on a zero-activity turn", () => {
		const scheduler = new WorkflowReminderScheduler(2);

		scheduler.startTurn();
		expect(scheduler.completeTurn(2, false, true, true)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(0, false, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(1, false, true, false)).toBe(true);
	});

	/**
	 * Proves lifecycle reset, inactive workflow state, and a zero interval suppress stale reminders.
	 * Input and expected output: reset or inactive completion clears accumulated calls, and interval zero never schedules.
	 * Edge case: inactive completion occurs exactly at the configured threshold.
	 * Dependencies: the Pi-independent scheduler only.
	 */
	test("resets for lifecycle events and suppresses inactive or disabled reminders", () => {
		const scheduler = new WorkflowReminderScheduler(50);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, true, false)).toBe(false);
		scheduler.reset();
		scheduler.startTurn();
		expect(scheduler.completeTurn(1, false, true, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, false, false)).toBe(false);
		scheduler.startTurn();
		expect(scheduler.completeTurn(49, false, true, false)).toBe(false);

		const disabled = new WorkflowReminderScheduler(0);
		disabled.startTurn();
		expect(
			disabled.completeTurn(Number.MAX_SAFE_INTEGER, true, true, false),
		).toBe(false);
	});
});
