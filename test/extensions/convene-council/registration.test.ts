import { describe, expect, test } from "bun:test";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import { withIsolatedAgentDir, writeEnabledConfig } from "./support/env";
import { createExtensionApiFake } from "./support/fakes";
import { getCouncilTool } from "./support/tool";

describe("convene-council registration", () => {
	test("registers the public convene_council schema with only question", async () => {
		// Purpose: the public tool contract must stay limited to the caller question.
		// Input and expected output: extension load registers one required question field.
		// Edge case: enabled config only affects registration, not the public parameter schema.
		// Dependencies: isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const pi = createExtensionApiFake();

			conveneCouncil(pi);

			const parameters = getCouncilTool(pi).parameters as unknown as {
				readonly additionalProperties: boolean;
				readonly properties: { readonly question?: { readonly type?: string } };
				readonly required: readonly string[];
			};
			expect(Object.keys(parameters.properties)).toEqual(["question"]);
			expect(parameters.properties.question?.type).toBe("string");
			expect(parameters.required).toEqual(["question"]);
			expect(parameters.additionalProperties).toBe(false);
		});
	});
});
