import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AUXILIARY_USAGE_SOURCES,
	publishUsageEvent,
	USAGE_EVENT_RECORD_CHANNEL,
	USAGE_EVENT_RECORD_VERSION,
	type UsageEventRecordRequest,
} from "./usage-events";

function assistantMessage(): AssistantMessage {
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
				total: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1_000,
	};
}

describe("auxiliary usage publication", () => {
	test("publishes every complete auxiliary response with one stable event ID", () => {
		// Purpose: the usage store must receive the complete response for every approved auxiliary source.
		// Inputs and expected output: one response per source emits one versioned request with the original message and a distinct ID.
		// Edge case: a complete zero-cost response is still published for all-or-nothing recorder validation.
		// Dependencies: an in-memory Pi event publisher and the shared auxiliary source list.
		const requests: UsageEventRecordRequest[] = [];
		const message = assistantMessage();
		let nextId = 0;
		const pi = {
			events: {
				emit(name: string, value: unknown): void {
					if (name === USAGE_EVENT_RECORD_CHANNEL) {
						requests.push(value as UsageEventRecordRequest);
					}
				},
			},
		};

		for (const source of AUXILIARY_USAGE_SOURCES) {
			publishUsageEvent(pi, source, message, () => `event-${nextId++}`);
		}

		expect(requests).toHaveLength(AUXILIARY_USAGE_SOURCES.length);
		expect(requests.map(({ source }) => source)).toEqual([
			...AUXILIARY_USAGE_SOURCES,
		]);
		expect(
			requests.every(({ version }) => version === USAGE_EVENT_RECORD_VERSION),
		).toBe(true);
		expect(requests.every((request) => request.message === message)).toBe(true);
		expect(requests.map(({ eventId }) => eventId)).toEqual(
			AUXILIARY_USAGE_SOURCES.map((_, index) => `event-${index}`),
		);
	});
});
