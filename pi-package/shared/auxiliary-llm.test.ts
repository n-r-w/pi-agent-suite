import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	getCurrentTools,
	type Model,
	normalizeContext,
	type Tool,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	resolveAuxiliaryLlmRuntime,
	withoutSystemMessages,
} from "./auxiliary-llm";

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

describe("withoutSystemMessages", () => {
	test("keeps ordinary replay order and resolves no primary tools", () => {
		// Purpose: one shared policy must isolate primary system state before auxiliary normalization.
		// Input and expected output: an ordered user-system-tool-result replay becomes a dedicated-system, user, tool-result transcript with no tools.
		// Edge case: the removed system record declares a tool that would otherwise remain active.
		// Dependencies: Pi context normalization and transcript tool resolution.
		const primaryTool: Tool = {
			name: "primary_tool",
			description: "Primary transcript tool.",
			parameters: Type.Object({}),
		};
		const replayed: AgentMessage[] = [
			{ role: "user", content: "First ordinary message.", timestamp: 1 },
			{
				role: "system",
				content: "Primary system state.",
				toolsAdded: [primaryTool],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "primary_tool",
				content: [{ type: "text", text: "Ordinary result." }],
				isError: false,
				timestamp: 3,
			},
		];

		const normalized = normalizeContext({
			systemPrompt: "Auxiliary system state.",
			messages: convertToLlm(withoutSystemMessages(replayed)),
			tools: [],
		});

		expect(normalized.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"toolResult",
		]);
		expect(getCurrentTools(normalized.messages)).toEqual([]);
	});
});

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
