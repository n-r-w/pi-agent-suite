import { describe, expect, test } from "bun:test";
import { isReasoningLevel, REASONING_LEVELS } from "./reasoning-levels";

const EXPECTED_REASONING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

describe("reasoning levels", () => {
	test("exposes and accepts every supported reasoning level", () => {
		// Purpose: every configuration parser must share the complete provider-supported reasoning vocabulary.
		// Input and expected output: all seven supported levels appear in order and pass runtime validation.
		// Edge case: model-specific xhigh and max levels remain valid configuration values.
		// Dependencies: this test exercises only the shared reasoning-level contract.
		expect(REASONING_LEVELS).toEqual(EXPECTED_REASONING_LEVELS);
		for (const level of EXPECTED_REASONING_LEVELS) {
			expect(isReasoningLevel(level)).toBe(true);
		}
	});

	test("rejects values outside the supported reasoning levels", () => {
		// Purpose: configuration boundaries must reject unknown reasoning strings.
		// Input and expected output: an unsupported string and non-string values fail validation.
		// Edge case: undefined and null must not be treated as explicit reasoning levels.
		// Dependencies: this test exercises only the shared reasoning-level contract.
		for (const value of ["extreme", "", undefined, null, 1]) {
			expect(isReasoningLevel(value)).toBe(false);
		}
	});
});
