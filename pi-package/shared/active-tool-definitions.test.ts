import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildActiveToolDefinitions } from "./active-tool-definitions";

/** Minimal Pi tool registry contract consumed by the shared builder. */
type ToolSource = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

/** Creates ordered registered tools with a different active-name order. */
function createToolSource(): {
	readonly source: ToolSource;
	readonly alphaParameters: { readonly type: "object" };
	readonly gammaParameters: { readonly type: "object" };
} {
	const alphaParameters = { type: "object" } as const;
	const betaParameters = { type: "object" } as const;
	const gammaParameters = { type: "object" } as const;
	const allTools = [
		{
			name: "alpha",
			label: "Alpha",
			description: "First tool",
			parameters: alphaParameters,
			execute: async () => ({ content: [] }),
		},
		{
			name: "beta",
			label: "Beta",
			description: "Inactive tool",
			parameters: betaParameters,
			execute: async () => ({ content: [] }),
		},
		{
			name: "gamma",
			label: "Gamma",
			description: "Last tool",
			parameters: gammaParameters,
			execute: async () => ({ content: [] }),
		},
	] as unknown as ReturnType<ExtensionAPI["getAllTools"]>;

	return {
		source: {
			getActiveTools: () => ["gamma", "alpha"],
			getAllTools: () => allTools,
		},
		alphaParameters,
		gammaParameters,
	};
}

describe("active tool definitions", () => {
	test("returns only active public schemas in registration order", () => {
		// Purpose: request budgeting must use the same public tool schemas that Pi exposes to the model.
		// Input and expected output: active alpha and gamma return name, description, and parameters in getAllTools order.
		// Edge case: getActiveTools order differs and inactive beta sits between both active tools.
		// Dependencies: an in-memory ExtensionAPI tool source.
		const { source, alphaParameters, gammaParameters } = createToolSource();

		expect(buildActiveToolDefinitions(source)).toEqual([
			{
				name: "alpha",
				description: "First tool",
				parameters: alphaParameters,
			},
			{
				name: "gamma",
				description: "Last tool",
				parameters: gammaParameters,
			},
		]);
	});

	test("omits every inactive tool", () => {
		// Purpose: inactive schemas must not inflate the provider request estimate.
		// Input and expected output: no active names return an empty definition list.
		// Edge case: registered tools remain available through getAllTools.
		// Dependencies: an in-memory ExtensionAPI tool source.
		const { source } = createToolSource();
		const inactiveSource: ToolSource = {
			...source,
			getActiveTools: () => [],
		};

		expect(buildActiveToolDefinitions(inactiveSource)).toEqual([]);
	});
});
