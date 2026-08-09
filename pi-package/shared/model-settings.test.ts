import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	isModelId,
	isModelSelectorId,
	isModelSettings,
	parseModelSettings,
	resolveThinkingLevel,
	splitModelId,
} from "./model-settings";
import { REASONING_LEVELS, type ReasoningLevel } from "./reasoning-levels";

/** Creates a model fixture with the requested thinking-level map. */
function createModel(
	reasoning: boolean,
	supportedThinkingLevels: readonly ReasoningLevel[] = REASONING_LEVELS,
): Model<Api> {
	const thinkingLevelMap = Object.fromEntries(
		REASONING_LEVELS.map((level) => [
			level,
			supportedThinkingLevels.includes(level) ? level : null,
		]),
	);
	return {
		provider: "openai",
		id: "gpt-test",
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning,
		thinkingLevelMap,
		name: "openai/gpt-test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

describe("model settings contract", () => {
	/** Verifies model IDs split at the first slash and preserve nested model slashes. */
	test("splits provider and model identifiers", () => {
		expect(splitModelId("openrouter/ai21/jamba")).toEqual({
			provider: "openrouter",
			id: "ai21/jamba",
		});
		expect(isModelId("openai/gpt-test")).toBe(true);
		expect(isModelId("missing-provider")).toBe(false);
		expect(isModelSelectorId("missing-provider")).toBe(true);
		expect(isModelSelectorId("")).toBe(false);
	});

	/** Verifies optional model fields share one closed validation contract. */
	test("parses independently optional model fields", () => {
		expect(parseModelSettings({ thinking: "max" }, "model")).toEqual({
			thinking: "max",
		});
		expect(isModelSettings({ id: "openai/gpt-test" })).toBe(true);
		expect(isModelSettings({ id: "model-alias" })).toBe(true);
		expect(isModelSettings({ id: "openai/gpt-test", extra: true })).toBe(false);
		expect(() => parseModelSettings({ id: "" }, "model")).toThrow(
			"model.id must be a non-empty string",
		);
	});

	/** Verifies valid requested levels resolve to the nearest model-supported level. */
	test("resolves supported thinking levels", () => {
		// Purpose: valid configured levels remain usable when a model omits an exact level.
		// Input and expected output: mate, higher, and lower supported levels return the specified nearest level.
		// Edge cases: xhigh resolves to max, off resolves upward, and non-reasoning models resolve to off.
		// Dependencies: getSupportedThinkingLevels defines the model capability set.
		expect(
			resolveThinkingLevel(createModel(true, ["off", "low"]), "minimal"),
		).toBe("low");
		expect(
			resolveThinkingLevel(createModel(true, ["off", "high"]), "medium"),
		).toBe("high");
		expect(
			resolveThinkingLevel(createModel(true, ["off", "high"]), "low"),
		).toBe("high");
		expect(
			resolveThinkingLevel(createModel(true, ["off", "max"]), "xhigh"),
		).toBe("max");
		expect(
			resolveThinkingLevel(createModel(true, ["off", "high"]), "max"),
		).toBe("high");
		expect(resolveThinkingLevel(createModel(true, ["minimal"]), "off")).toBe(
			"minimal",
		);
		expect(resolveThinkingLevel(createModel(false), "high")).toBe("off");
	});
});
