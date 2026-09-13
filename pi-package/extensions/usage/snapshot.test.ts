import { describe, expect, test } from "bun:test";
import { prepareUsageSnapshot } from "./snapshot";
import type { UsageEvent } from "./store";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OPENED_AT = 100 * DAY_MS;

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: OPENED_AT,
		sessionId: "session",
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
	test("filters all four ranges from one event snapshot", () => {
		// Purpose: range selection must derive rolling views from the one 90-day query result.
		// Input and expected output: events aged 1, 3, 20, and 60 days produce increasing totals for 24h, 7d, 30d, and 90d.
		// Edge case: the event exactly on the 24-hour inclusive boundary remains selected.
		// Dependencies: pure snapshot filtering and aggregation only.
		const events = [
			event({ eventId: "24", timestampMs: OPENED_AT - DAY_MS, input: 1 }),
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

		const snapshot = prepareUsageSnapshot(events, OPENED_AT);

		expect(snapshot["24h"].rows[0]?.tokens).toBe(10);
		expect(snapshot["7d"].rows[0]?.tokens).toBe(29);
		expect(snapshot["30d"].rows[0]?.tokens).toBe(138);
		expect(snapshot["90d"].rows[0]?.tokens).toBe(1_147);
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

		const view = prepareUsageSnapshot(events, OPENED_AT)["24h"];
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

		const snapshot = prepareUsageSnapshot(events, OPENED_AT);

		expect(snapshot["7d"].agentIds).toEqual([]);
		expect(snapshot["7d"].rows).toEqual([]);
		expect(snapshot["7d"].agentRows.size).toBe(0);
		expect(snapshot["30d"].rows.length).toBeGreaterThan(0);
	});
});
