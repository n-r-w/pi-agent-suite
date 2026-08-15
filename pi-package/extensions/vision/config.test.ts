import { describe, expect, test } from "bun:test";
import { parseVisionConfig } from "./config";

describe("vision configuration", () => {
	test("applies defaults and preserves configured provider and model", () => {
		// Purpose: parsing produces the supported single-image configuration contract.
		// Input and expected output: provider and model retain their values with compression and retry defaults.
		// Dependencies: parseVisionConfig owns config validation and defaults.
		expect(
			parseVisionConfig({
				provider: "openai",
				model: "gpt-4.1-mini",
			}),
		).toEqual({
			kind: "valid",
			config: {
				enabled: false,
				provider: "openai",
				model: "gpt-4.1-mini",
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
			parseVisionConfig({ enabled: true, provider: "p", model: "m" }),
		).toMatchObject({
			kind: "valid",
			config: { enabled: true, provider: "p", model: "m" },
		});
	});

	test("rejects unsupported and invalid fields", () => {
		expect(parseVisionConfig({ unexpected: true })).toEqual({
			kind: "invalid",
			issue: "config contains unsupported fields",
		});
	});
});
