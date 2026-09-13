import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	HELPER_API_COST_CUSTOM_TYPE,
	HELPER_API_COST_SOURCES,
	recordHelperApiCost,
	sumHelperApiCost,
} from "./helper-api-cost";
import {
	USAGE_EVENT_RECORD_CHANNEL,
	USAGE_EVENT_RECORD_VERSION,
	type UsageEventRecordRequest,
} from "./usage-events";

/** Creates the minimal assistant message shape needed for helper cost accounting. */
function createAssistantMessage(cost: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				total: cost,
				input: 0,
				output: cost,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Creates a session custom entry for helper cost aggregation tests. */
function createCustomEntry(
	data: unknown,
	customType = HELPER_API_COST_CUSTOM_TYPE,
): SessionEntry {
	return {
		type: "custom",
		id: "entry-id",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		data,
	};
}

describe("helper API cost accounting", () => {
	test("records one custom entry for a positive finite assistant cost", () => {
		// Purpose: each helper model response must persist one cost entry outside LLM context.
		// Input and expected output: consult-advisor response with cost 0.125 appends `{ source, cost }`.
		// Edge case: only the minimal cost data is persisted; session entry timestamp owns chronology.
		// Dependencies: fake appendEntry records calls in memory.
		const appendCalls: unknown[] = [];

		recordHelperApiCost(
			{
				appendEntry(customType: string, data?: unknown): void {
					appendCalls.push({ customType, data });
				},
			},
			"consult-advisor",
			createAssistantMessage(0.125),
		);

		expect(appendCalls).toEqual([
			{
				customType: HELPER_API_COST_CUSTOM_TYPE,
				data: { source: "consult-advisor", cost: 0.125 },
			},
		]);
	});

	test("publishes every approved complete response with stable distinct event IDs", () => {
		// Purpose: usage history must receive the complete response for each approved auxiliary source independently of footer cost filtering.
		// Input and expected output: one zero-cost response for every approved source emits one versioned request with the original message and a unique stable ID.
		// Edge case: valid zero cost creates no footer entry but still publishes usage.
		// Dependencies: an in-memory event-bus fake and the approved helper source list.
		const requests: UsageEventRecordRequest[] = [];
		const appendCalls: unknown[] = [];
		const pi = {
			appendEntry(customType: string, data?: unknown): void {
				appendCalls.push({ customType, data });
			},
			events: {
				emit(name: string, value: unknown): void {
					if (name === USAGE_EVENT_RECORD_CHANNEL) {
						requests.push(value as UsageEventRecordRequest);
					}
				},
			},
		};
		const message = createAssistantMessage(0);

		for (const source of HELPER_API_COST_SOURCES) {
			recordHelperApiCost(pi, source, message);
		}

		expect(appendCalls).toEqual([]);
		expect(requests).toHaveLength(HELPER_API_COST_SOURCES.length);
		expect(requests.map(({ source }) => source)).toEqual([
			...HELPER_API_COST_SOURCES,
		]);
		expect(
			requests.every(({ version }) => version === USAGE_EVENT_RECORD_VERSION),
		).toBe(true);
		expect(requests.every((request) => request.message === message)).toBe(true);
		expect(new Set(requests.map(({ eventId }) => eventId)).size).toBe(
			HELPER_API_COST_SOURCES.length,
		);
		expect(requests.every(({ eventId }) => eventId.length > 0)).toBe(true);
	});

	test("does not record missing, zero, negative, or non-finite costs", () => {
		// Purpose: helper accounting must not persist costs that cannot increase the displayed amount.
		// Input and expected output: zero, negative, NaN, and Infinity costs append no entries.
		// Edge case: provider data can cross runtime boundaries, so non-finite values are rejected.
		// Dependencies: fake appendEntry records calls in memory.
		const appendCalls: unknown[] = [];
		const pi = {
			appendEntry(customType: string, data?: unknown): void {
				appendCalls.push({ customType, data });
			},
		};

		for (const cost of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
			recordHelperApiCost(
				pi,
				"custom-compaction",
				createAssistantMessage(cost),
			);
		}

		expect(appendCalls).toEqual([]);
	});

	test("ignores appendEntry failures and clears the mutable entry payload", () => {
		// Purpose: user-approved accounting persistence failures must not fail the helper result.
		// Input and expected output: appendEntry throws after observing data; the recorder does not throw and clears the observed payload.
		// Edge case: pi can keep the same data object in memory before persistence fails.
		// Dependencies: fake appendEntry captures the data reference and throws.
		let capturedData: unknown;

		expect(() =>
			recordHelperApiCost(
				{
					appendEntry(_customType: string, data?: unknown): void {
						capturedData = data;
						throw new Error("persistence failed");
					},
				},
				"context-projection",
				createAssistantMessage(0.5),
			),
		).not.toThrow();
		expect(capturedData).toEqual({ source: "context-projection", cost: 0 });
	});

	test("sums only valid helper API cost custom entries", () => {
		// Purpose: footer aggregation must ignore malformed persisted data instead of corrupting the displayed total.
		// Input and expected output: two valid helper entries sum to 0.75 while invalid entries are ignored.
		// Edge case: unknown source, wrong custom type, zero, negative, non-finite, and non-custom entries are rejected.
		// Dependencies: in-memory session entry fixtures only.
		const entries: SessionEntry[] = [
			createCustomEntry({ source: "consult-advisor", cost: 0.25 }),
			createCustomEntry({ source: "context-projection", cost: 0.5 }),
			createCustomEntry({ source: "unknown", cost: 100 }),
			createCustomEntry({ source: "custom-compaction", cost: 0 }),
			createCustomEntry({ source: "convene-council", cost: -1 }),
			createCustomEntry({ source: "context-projection", cost: Number.NaN }),
			createCustomEntry({ source: "consult-advisor", cost: 10 }, "other"),
			{
				type: "message",
				id: "message-id",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: createAssistantMessage(10),
			},
		];

		expect(sumHelperApiCost(entries)).toBe(0.75);
	});
});
