import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	assertThinkingLevelSupported,
	isModelId,
	isModelSettings,
	parseModelSettings,
	splitModelId,
} from "./model-settings";

/** Creates a model fixture with the requested reasoning capability. */
function createModel(reasoning: boolean): Model<Api> {
	return {
		provider: "openai",
		id: "gpt-test",
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning,
		...(reasoning ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : {}),
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
	});

	/** Verifies optional model fields share one closed validation contract. */
	test("parses independently optional model fields", () => {
		expect(parseModelSettings({ thinking: "max" }, "model")).toEqual({
			thinking: "max",
		});
		expect(isModelSettings({ id: "openai/gpt-test" })).toBe(true);
		expect(isModelSettings({ id: "openai/gpt-test", extra: true })).toBe(false);
		expect(() => parseModelSettings({ id: "gpt-test" }, "model")).toThrow(
			"model.id must use provider/model",
		);
	});

	/** Verifies capability checks accept model-supported levels and reject unsupported levels. */
	test("checks thinking support before runtime application", () => {
		expect(() =>
			assertThinkingLevelSupported(createModel(true), "max"),
		).not.toThrow();
		expect(() =>
			assertThinkingLevelSupported(createModel(false), "high"),
		).toThrow("thinking high is not supported");
	});
});
