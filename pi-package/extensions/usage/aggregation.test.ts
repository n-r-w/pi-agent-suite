import { describe, expect, test } from "bun:test";
import { aggregateAllAgents } from "./aggregation";
import type { UsageEvent } from "./store";

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: 1,
		sessionId: "session",
		rootSessionId: "root-session",
		agentId: "agent",
		source: "agent-turn",
		provider: "provider",
		model: "model",
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		cost: 1,
		saved: 2,
		...overrides,
	};
}

describe("all-agent aggregation", () => {
	test("builds total and sorts models by exact visible cost share", () => {
		// Purpose: the visible total must own the denominator, while model rows use exact cost shares for ordering.
		// Inputs and expected output: four events produce Total first, descending unequal shares, then lexical provider/model ties.
		// Edge case: two shares that both render as 25.0 still sort by their exact unrounded values.
		// Dependencies: pure usage-event aggregation only.
		const rows = aggregateAllAgents([
			event({ eventId: "low", provider: "zeta", model: "m", cost: 0.999 }),
			event({ eventId: "high", provider: "omega", model: "m", cost: 1.001 }),
			event({ eventId: "tie-b", provider: "beta", model: "m", cost: 1 }),
			event({ eventId: "tie-a", provider: "alpha", model: "m", cost: 1 }),
		]);

		expect(rows.map((row) => row.label)).toEqual([
			"Total",
			"omega/m",
			"alpha/m",
			"beta/m",
			"zeta/m",
		]);
		expect(rows.map((row) => row.costPercent)).toEqual([
			100,
			(1.001 / 4) * 100,
			25,
			25,
			(0.999 / 4) * 100,
		]);
		expect(rows[0]).toMatchObject({
			label: "Total",
			tokens: 400,
			cacheRead: 120,
			cacheWrite: 160,
			hitPercent: (120 / (40 + 120 + 160)) * 100,
			cost: 4,
			saved: 8,
		});
	});

	test("uses zero cost shares when visible total cost is zero", () => {
		// Purpose: zero-cost views must not produce NaN or infinite percentages.
		// Inputs and expected output: two zero-cost models produce zero for Total and both model shares.
		// Edge case: lexical provider/model order resolves the equal zero shares.
		// Dependencies: pure usage-event aggregation only.
		const rows = aggregateAllAgents([
			event({ eventId: "b", provider: "beta", cost: 0 }),
			event({ eventId: "a", provider: "alpha", cost: 0 }),
		]);

		expect(rows.map((row) => [row.label, row.costPercent])).toEqual([
			["Total", 0],
			["alpha/model", 0],
			["beta/model", 0],
		]);
	});
});
