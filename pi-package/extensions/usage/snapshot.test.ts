import { describe, expect, test } from "bun:test";
import { prepareUsageSnapshot } from "./snapshot";
import type { UsageEvent } from "./store";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const OPENED_AT = 100 * DAY_MS;

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: OPENED_AT,
		sessionId: "session",
		rootSessionId: "root-session",
		agentId: "agent",
		source: "agent-turn",
		provider: "provider",
		model: "model",
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cost: 5,
		saved: 6,
		...overrides,
	};
}

describe("immutable usage snapshot views", () => {
	test("filters all five ranges from one event snapshot", () => {
		// Purpose: range selection must derive rolling views from the one 90-day query result.
		// Input and expected output: events aged 1 hour, 1, 3, 20, and 60 days produce increasing totals for 1h, 24h, 7d, 30d, and 90d.
		// Edge case: events exactly on the 1-hour and 24-hour inclusive boundaries remain selected.
		// Dependencies: pure snapshot filtering and aggregation only.
		const events = [
			event({ eventId: "1h", timestampMs: OPENED_AT - HOUR_MS, input: 1 }),
			event({ eventId: "24", timestampMs: OPENED_AT - DAY_MS, input: 10 }),
			event({ eventId: "7", timestampMs: OPENED_AT - 3 * DAY_MS, input: 10 }),
			event({
				eventId: "30",
				timestampMs: OPENED_AT - 20 * DAY_MS,
				input: 100,
			}),
			event({
				eventId: "90",
				timestampMs: OPENED_AT - 60 * DAY_MS,
				input: 1_000,
			}),
		];

		const snapshot = prepareUsageSnapshot(events, OPENED_AT, "root-session");

		expect(snapshot.all["1h"].rows[0]?.tokens).toBe(10);
		expect(snapshot.all["24h"].rows[0]?.tokens).toBe(29);
		expect(snapshot.all["7d"].rows[0]?.tokens).toBe(48);
		expect(snapshot.all["30d"].rows[0]?.tokens).toBe(157);
		expect(snapshot.all["90d"].rows[0]?.tokens).toBe(1_166);
	});

	test("sorts agents and filters per-agent model rows and totals", () => {
		// Purpose: agent selection must retain correct totals and lexical model ordering.
		// Input and expected output: mixed events expose lexical agent IDs, while selecting agent-b includes only its Total and sorted model rows.
		// Edge case: identical provider/model pairs from another agent do not leak into the selected total.
		// Dependencies: pure range filtering and usage aggregation only.
		const events = [
			event({
				eventId: "z",
				agentId: "agent-z",
				provider: "shared",
				model: "m",
				input: 100,
			}),
			event({
				eventId: "b2",
				agentId: "agent-b",
				provider: "zeta",
				model: "m",
				input: 10,
			}),
			event({
				eventId: "b1",
				agentId: "agent-b",
				provider: "alpha",
				model: "m",
				input: 1,
			}),
		];

		const view = prepareUsageSnapshot(events, OPENED_AT, "root-session").all[
			"24h"
		];
		const agentRows = view.agentRows.get("agent-b") ?? [];

		expect(view.agentIds).toEqual(["agent-b", "agent-z"]);
		expect(agentRows.map(({ label }) => label)).toEqual([
			"Total",
			"alpha/m",
			"zeta/m",
		]);
		expect(agentRows[0]?.tokens).toBe(29);
	});

	test("returns the approved empty-range view without changing its range", () => {
		// Purpose: an empty selected range must remain explicit instead of falling back to a broader period.
		// Input and expected output: a 20-day-old event produces no 7-day agents or model rows.
		// Edge case: the same immutable events still produce data for 30 days.
		// Dependencies: pure snapshot filtering only.
		const events = [event({ timestampMs: OPENED_AT - 20 * DAY_MS })];

		const snapshot = prepareUsageSnapshot(events, OPENED_AT, "root-session");

		expect(snapshot.all["7d"].agentIds).toEqual([]);
		expect(snapshot.all["7d"].rows).toEqual([]);
		expect(snapshot.all["7d"].agentRows.size).toBe(0);
		expect(snapshot.all["30d"].rows.length).toBeGreaterThan(0);
	});

	test("prepares current and all session scopes from one event snapshot", () => {
		// Purpose: session scope changes must use immutable prepared views rather than query storage again.
		// Inputs and expected output: two root families produce one Current total and one combined All total.
		// Edge case: a child event has its own session ID but remains in Current through rootSessionId.
		// Dependencies: pure snapshot filtering and aggregation only.
		const events = [
			event({
				eventId: "root",
				sessionId: "root-session",
				rootSessionId: "root-session",
				input: 10,
			}),
			event({
				eventId: "child",
				sessionId: "child-session",
				rootSessionId: "root-session",
				input: 100,
			}),
			event({
				eventId: "other",
				sessionId: "other-session",
				rootSessionId: "other-session",
				input: 1_000,
			}),
		];

		const snapshot = prepareUsageSnapshot(events, OPENED_AT, "root-session");

		expect(snapshot.current["24h"].rows[0]?.tokens).toBe(128);
		expect(snapshot.all["24h"].rows[0]?.tokens).toBe(1_137);
	});
});
