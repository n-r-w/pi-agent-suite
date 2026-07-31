import { describe, expect, test } from "bun:test";
import {
	normalizePositiveProjectionStatus,
	projectionSavedTokensFromStatus,
} from "./context-projection-status";

describe("context projection status", () => {
	test("normalizes only positive projection savings", () => {
		// Purpose: every status consumer must receive the same unstyled positive display value.
		// Inputs and expected output: themed compact savings normalize while ready, invalid, missing, and unrelated states clear.
		// Edge case: terminal control styling and row-breaking whitespace do not change the accepted status value.
		// Dependencies: the shared status normalizer only.
		// ARRANGE: define positive and clearing status values from the child UI boundary.
		const escapeCharacter = String.fromCharCode(27);
		const cases = [
			[`${escapeCharacter}[33m\n ~65k\t${escapeCharacter}[39m`, "~65k"],
			["~139.0k", "~139.0k"],
			["~0", undefined],
			["CP!", undefined],
			["unrelated", undefined],
			[undefined, undefined],
		] as const;

		// ACT/ASSERT: normalize each boundary value through the shared contract.
		for (const [statusText, expected] of cases) {
			expect(normalizePositiveProjectionStatus(statusText)).toBe(expected);
		}
	});

	test("converts compact positive savings to complete token counts", () => {
		// Purpose: numeric consumers must use the shared compact-status conversion instead of parsing independently.
		// Inputs and expected output: bare, thousands, and fractional-thousands values become rounded positive token counts.
		// Edge case: values that round to zero, exceed safe integer precision, or do not represent savings clear.
		// Dependencies: shared normalization and saved-token conversion.
		// ARRANGE: define compact values at positive, rounding, and numeric-safety boundaries.
		const cases = [
			["~20", 20],
			["~139k", 139_000],
			["~1.25k", 1_250],
			["~0.4", undefined],
			["~9007199254740992", undefined],
			["CP!", undefined],
		] as const;

		// ACT/ASSERT: convert each status through the shared numeric contract.
		for (const [statusText, expected] of cases) {
			expect(projectionSavedTokensFromStatus(statusText)).toBe(expected);
		}
	});
});
