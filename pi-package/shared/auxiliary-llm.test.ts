import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAuxiliaryLlmRuntime } from "./auxiliary-llm";

/** Creates one deterministic model fixture. */
function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

/** Creates caller-local model resolution with deterministic authentication. */
function createContext(model: Model<Api>): ExtensionContext {
	return {
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	} as unknown as ExtensionContext;
}

describe("resolveAuxiliaryLlmRuntime", () => {
	test("keeps explicit thinking when no model id is configured", async () => {
		// Purpose: an auxiliary request must keep an explicitly configured thinking level even without a model id.
		// Input and expected output: no model id with explicit thinking resolves the current model and returns that thinking.
		// Edge case: the current model has no alias default, so only the explicit thinking may set the reasoning level.
		// Dependencies: deterministic model registry and authentication fakes.
		const model = createModel("provider", "current");
		const result = await resolveAuxiliaryLlmRuntime(
			createContext(model),
			undefined,
			"high",
		);
		if ("issue" in result) {
			throw new Error(result.issue);
		}
		expect(result.runtime.model).toBe(model);
		expect(result.thinking).toBe("high");
	});
});
