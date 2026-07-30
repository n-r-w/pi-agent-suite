import { describe, expect, test } from "bun:test";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import { getPackageToolPresentation } from "../../../pi-package/shared/tool-presentation/registry";
import { withIsolatedAgentDir, writeEnabledConfig } from "./support/env";
import { createExtensionApiFake } from "./support/fakes";
import { getCouncilTool } from "./support/tool";

describe("convene-council registration", () => {
	test("registers the public convene_council schema with only question", async () => {
		// Purpose: the public tool contract must stay limited to the caller question.
		// Input and expected output: extension load registers one required question field and publishes its exact renderers.
		// Edge case: enabled config only affects registration, not the public parameter schema.
		// Dependencies: isolated agent directory and in-memory ExtensionAPI fake with Pi's event bus.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const pi = createExtensionApiFake();

			conveneCouncil(pi);

			const tool = getCouncilTool(pi);
			const parameters = tool.parameters as unknown as {
				readonly additionalProperties: boolean;
				readonly properties: { readonly question?: { readonly type?: string } };
				readonly required: readonly string[];
			};
			const presentation = getPackageToolPresentation(
				pi.events,
				"convene_council",
			);
			expect({
				additionalProperties: parameters.additionalProperties,
				parameterNames: Object.keys(parameters.properties),
				questionType: parameters.properties.question?.type,
				renderCall: presentation?.renderCall === tool.renderCall,
				renderResult: presentation?.renderResult === tool.renderResult,
				required: parameters.required,
			}).toEqual({
				additionalProperties: false,
				parameterNames: ["question"],
				questionType: "string",
				renderCall: true,
				renderResult: true,
				required: ["question"],
			});
		});
	});
});
