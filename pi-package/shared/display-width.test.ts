import { describe, expect, test } from "bun:test";
import { truncateTextByCodeUnits } from "./display-width";

const EXCESS_COMBINING_MARK_COUNT = 300;

describe("display width", () => {
	test("truncates storage text only between complete graphemes", () => {
		// Purpose: hard storage bounds must not split multi-code-point user-perceived characters.
		// Input and expected output: three family emoji fit as one family plus ellipsis under a one-family content budget.
		// Edge case: the family emoji contains surrogate pairs and several ZWJ separators.
		// Dependencies: Intl.Segmenter defines the shared grapheme boundary contract.
		const family = "👨‍👩‍👧‍👦";
		const maxCodeUnits = family.length + 1;
		const result = truncateTextByCodeUnits(family.repeat(3), maxCodeUnits, "…");

		expect(result).toBe(`${family}…`);
		expect(result.length).toBeLessThanOrEqual(maxCodeUnits);
	});

	test("uses only the ellipsis when the first grapheme exceeds the storage bound", () => {
		// Purpose: an oversized first grapheme must not be retained partially to satisfy the hard bound.
		// Input and expected output: one base character with hundreds of combining marks becomes only an ellipsis.
		// Edge case: the input has minimal terminal width despite exceeding the storage limit.
		// Dependencies: the same storage helper is used by live subagent progress capture.
		const oversizedGrapheme = `e${"\u0301".repeat(EXCESS_COMBINING_MARK_COUNT)}`;

		expect(truncateTextByCodeUnits(oversizedGrapheme, 20, "…")).toBe("…");
	});
});
