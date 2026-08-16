import { describe, expect, test } from "bun:test";
import { parseVisionConfig } from "./config";

describe("vision configuration", () => {
	test("applies defaults and preserves configured model settings", () => {
		// Purpose: parsing produces the shared model-settings contract for vision delegation.
		// Input and expected output: an alias ID and explicit thinking retain their values with compression and retry defaults.
		// Edge case: model IDs do not need a provider separator because aliases are valid selectors.
		// Dependencies: parseVisionConfig owns config validation and defaults.
		expect(
			parseVisionConfig({
				model: { id: "vision-default", thinking: "high" },
			}),
		).toEqual({
			kind: "valid",
			config: {
				enabled: false,
				model: { id: "vision-default", thinking: "high" },
				compression: {
					enabled: true,
					jpegQuality: 85,
					maxBytes: 4_718_592,
				},
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
			},
		});
	});

	test("defaults enabled to false for an empty config", () => {
		expect(parseVisionConfig({})).toMatchObject({
			kind: "valid",
			config: { enabled: false },
		});
	});

	test("keeps enabled true when explicitly configured", () => {
		expect(
			parseVisionConfig({
				enabled: true,
				model: { id: "openai/gpt-4.1-mini" },
			}),
		).toMatchObject({
			kind: "valid",
			config: {
				enabled: true,
				model: { id: "openai/gpt-4.1-mini" },
			},
		});
	});

	test("rejects unsupported and invalid fields", () => {
		// Purpose: vision config must reject obsolete model fields and invalid shared thinking values.
		// Input and expected output: top-level provider and unsupported thinking both return validation issues.
		// Edge case: a syntactically valid model object still fails when thinking is unknown.
		// Dependencies: the closed vision and shared model-settings schemas.
		expect(parseVisionConfig({ provider: "openai" })).toEqual({
			kind: "invalid",
			issue: "config contains unsupported fields",
		});
		expect(
			parseVisionConfig({ model: { id: "vision-default", thinking: "ultra" } }),
		).toEqual({
			kind: "invalid",
			issue: "model.thinking is invalid",
		});
	});
});
