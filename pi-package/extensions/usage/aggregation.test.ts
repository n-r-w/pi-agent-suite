import { describe, expect, test } from "bun:test";
import { aggregateAllAgents } from "./aggregation";
import type { UsageEvent } from "./store";

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: 1,
		sessionId: "session",
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

describe("24 hour all-agent aggregation", () => {
	test("builds total and sorted provider/model rows", () => {
		// Purpose: prove the first historical view combines all agents and keeps model ordering stable.
		// Inputs and expected output: three events across two agents and two model pairs produce one total followed by lexical provider/model rows.
		// Edge case: hit rate is calculated from aggregate counters instead of averaging request percentages.
		// Dependencies: pure usage-event aggregation only.
		const rows = aggregateAllAgents([
			event({ eventId: "z", provider: "zeta", model: "m", cacheRead: 0 }),
			event({ eventId: "a1", provider: "alpha", model: "m", agentId: "b" }),
			event({ eventId: "a2", provider: "alpha", model: "m", agentId: "a" }),
		]);

		expect(rows.map((row) => row.label)).toEqual([
			"Total",
			"alpha/m",
			"zeta/m",
		]);
		expect(rows[0]).toEqual({
			label: "Total",
			tokens: 270,
			cacheRead: 60,
			cacheWrite: 120,
			hitPercent: (60 / (30 + 60 + 120)) * 100,
			cost: 3,
			saved: 6,
		});
	});
});
