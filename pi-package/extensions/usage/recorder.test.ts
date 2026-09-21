import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { PiUsageEntry } from "../../shared/usage-events";
import {
	createAssistantUsageEvent,
	createUsageEntryEvent,
	NO_AGENT_ID,
	type UsageAttribution,
} from "./recorder";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "model-a",
		name: "Model A",
		api: "test",
		provider: "provider-a",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 12 },
		contextWindow: 100_000,
		maxTokens: 10_000,
		...overrides,
	};
}

function message(overrides: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "test",
		provider: "provider-a",
		model: "model-a",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 100_000,
			cacheWrite: 30,
			totalTokens: 100_060,
			cost: {
				input: 0.0001,
				output: 0.0004,
				cacheRead: 0.2,
				cacheWrite: 0.00036,
				total: 0.20086,
			},
		},
		stopReason: "stop",
		timestamp: 5_000,
		...overrides,
	} as AssistantMessage;
}

function usageEntry(overrides: Partial<PiUsageEntry> = {}): PiUsageEntry {
	return {
		type: "usage",
		id: "entry-a",
		parentId: null,
		timestamp: "2026-09-20T10:00:00.000Z",
		kind: "future-usage-kind",
		provider: "provider-a",
		model: "model-a",
		usage: message().usage,
		...overrides,
	};
}

describe("Pi usage entry recording", () => {
	test("copies complete usage with a session-qualified identity", () => {
		// Purpose: Pi-owned usage must enter the existing store without recalculating its cost.
		// Inputs and expected output: an arbitrary-kind entry and complete attribution produce copied tokens, Pi total cost, pi-usage source, and a session-qualified event ID.
		// Edge case: the unknown kind is accepted and tier-aware cache savings use the current pricing path.
		// Dependencies: an injected model lookup only.
		expect(
			createUsageEntryEvent(
				usageEntry(),
				{
					sessionId: "session-a",
					rootSessionId: "root-session-a",
					agentId: "agent-a",
				},
				() =>
					model({
						cost: {
							input: 10,
							output: 20,
							cacheRead: 2,
							cacheWrite: 12,
						},
					}),
			),
		).toEqual({
			eventId: "pi-usage:session-a:entry-a",
			timestampMs: Date.parse("2026-09-20T10:00:00.000Z"),
			sessionId: "session-a",
			rootSessionId: "root-session-a",
			agentId: "agent-a",
			source: "pi-usage",
			provider: "provider-a",
			model: "model-a",
			input: 10,
			output: 20,
			cacheRead: 100_000,
			cacheWrite: 30,
			cost: 0.20086,
			saved: 0.8,
		});
	});

	test("keeps validation for usage entries and qualifies equal IDs by session", () => {
		// Purpose: the new recorder must retain all-or-nothing validation and cross-session identity isolation.
		// Inputs and expected output: equal entry IDs in two valid sessions produce different IDs, while an invalid timestamp or unavailable pricing produces no event.
		// Edge case: Pi entry IDs are not globally unique across sessions.
		// Dependencies: deterministic entries and an injected model lookup.
		const findModel = () => model();
		const attribution = {
			rootSessionId: "root-session-a",
			agentId: undefined,
		};
		const first = createUsageEntryEvent(
			usageEntry(),
			{ ...attribution, sessionId: "session-a" },
			findModel,
		);
		const second = createUsageEntryEvent(
			usageEntry(),
			{ ...attribution, sessionId: "session-b" },
			findModel,
		);

		expect(first?.eventId).toBe("pi-usage:session-a:entry-a");
		expect(second?.eventId).toBe("pi-usage:session-b:entry-a");
		expect(first?.eventId).not.toBe(second?.eventId);
		expect(first?.agentId).toBe(NO_AGENT_ID);
		expect(
			createUsageEntryEvent(
				usageEntry({ timestamp: "not-a-timestamp" }),
				{ ...attribution, sessionId: "session-a" },
				findModel,
			),
		).toBeUndefined();
		expect(
			createUsageEntryEvent(
				usageEntry(),
				{ ...attribution, sessionId: "session-a" },
				() => undefined,
			),
		).toBeUndefined();
	});
});

describe("regular assistant usage recording", () => {
	test("normalizes one complete response and calculates tier-aware cache savings", () => {
		// Purpose: prove that one attributable finalized response becomes one complete persisted event.
		// Inputs and expected output: complete identity, usage, timestamp, and tiered pricing produce normalized fields and non-negative savings.
		// Edge case: total input crosses a strict pricing tier and must use that tier for the complete cache-read volume.
		// Dependencies: an injected model lookup and deterministic event-id source.
		const pricedModel = model({
			cost: {
				input: 10,
				output: 20,
				cacheRead: 2,
				cacheWrite: 12,
				tiers: [
					{
						inputTokensAbove: 50_000,
						input: 20,
						output: 30,
						cacheRead: 4,
						cacheWrite: 24,
					},
				],
			},
		});

		expect(
			createAssistantUsageEvent(
				message(),
				{
					sessionId: "session-a",
					rootSessionId: "root-session-a",
					agentId: "agent-a",
				},
				() => pricedModel,
				() => "event-a",
			),
		).toEqual({
			eventId: "event-a",
			timestampMs: 5_000,
			sessionId: "session-a",
			rootSessionId: "root-session-a",
			agentId: "agent-a",
			source: "agent-turn",
			provider: "provider-a",
			model: "model-a",
			input: 10,
			output: 20,
			cacheRead: 100_000,
			cacheWrite: 30,
			cost: 0.20086,
			saved: 1.6,
		});
	});

	test("ignores the complete request when required data is missing or invalid", () => {
		// Purpose: prevent partial or synthetic history rows.
		// Inputs and expected output: missing session-family, pricing, model identity, timestamp, usage, or cost produces no event; a missing agent uses the reserved identity.
		// Edge case: unsafe, negative, and non-finite numeric values are rejected as complete units.
		// Dependencies: only deterministic attribution and model lookup fakes.
		const validModel = model();
		const create = (
			candidate: AssistantMessage,
			attribution: UsageAttribution = {
				sessionId: "session-a",
				rootSessionId: "root-session-a",
				agentId: "agent-a",
			},
			lookup: () => Model<Api> | undefined = () => validModel,
		) =>
			createAssistantUsageEvent(
				candidate,
				attribution,
				lookup,
				() => "event-a",
			);

		expect(
			create(message(), {
				sessionId: undefined,
				rootSessionId: "root-session-a",
				agentId: "agent-a",
			}),
		).toBeUndefined();
		expect(
			create(message(), {
				sessionId: "session-a",
				rootSessionId: undefined,
				agentId: "agent-a",
			}),
		).toBeUndefined();
		expect(
			create(message(), {
				sessionId: "session-a",
				rootSessionId: "root-session-a",
				agentId: undefined,
			}),
		).toMatchObject({ agentId: NO_AGENT_ID });
		expect(create(message(), undefined, () => undefined)).toBeUndefined();
		expect(
			create(message(), undefined, () => model({ cost: undefined as never })),
		).toBeUndefined();
		expect(create(message({ provider: "" }))).toBeUndefined();
		expect(create(message({ timestamp: Number.NaN }))).toBeUndefined();
		expect(
			create(
				message({
					usage: {
						...message().usage,
						input: -1,
					},
				}),
			),
		).toBeUndefined();
		expect(
			create(
				message({
					usage: {
						...message().usage,
						output: Number.MAX_SAFE_INTEGER + 1,
					},
				}),
			),
		).toBeUndefined();
		expect(
			create(
				message({
					usage: {
						...message().usage,
						cost: { ...message().usage.cost, total: Number.POSITIVE_INFINITY },
					},
				}),
			),
		).toBeUndefined();
	});
});
