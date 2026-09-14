import { describe, expect, test } from "bun:test";
import { readUsageConfig, type UsageConfigReader } from "./config";

function found(content: string): ReturnType<UsageConfigReader> {
	return { kind: "found", file: { content } };
}

describe("usage configuration", () => {
	test("enables usage when configuration is missing", () => {
		// Purpose: prove that usage collection is available without setup.
		// Inputs and expected output: a missing config read produces the strict enabled default.
		// Edge case: no file content is available to parse.
		// Dependencies: only the injected suite config reader.
		expect(readUsageConfig(() => ({ kind: "missing" }))).toEqual({
			kind: "enabled",
			config: { enabled: true },
		});
	});

	test("requires an own boolean enabled field in a found configuration", () => {
		// Purpose: keep every present configuration closed and explicitly enabled or disabled.
		// Inputs and expected output: explicit true enables, explicit false disables, and missing, unknown, or mistyped fields are invalid.
		// Edge case: a found empty object is invalid instead of using the absent-file default.
		// Dependencies: JSON parsing and the injected suite config reader.
		expect(readUsageConfig(() => found("{}")).kind).toBe("invalid");
		expect(readUsageConfig(() => found('{"enabled":true}'))).toEqual({
			kind: "enabled",
			config: { enabled: true },
		});
		expect(readUsageConfig(() => found('{"enabled":false}'))).toEqual({
			kind: "disabled",
		});
		expect(readUsageConfig(() => found('{"enabled":"yes"}')).kind).toBe(
			"invalid",
		);
		expect(readUsageConfig(() => found('{"extra":true}')).kind).toBe("invalid");
		expect(readUsageConfig(() => found("{")).kind).toBe("invalid");
	});
});
