import { describe, expect, test } from "bun:test";
import {
	A4_PAGE_ANCHOR_TEXT,
	formatA4Fraction,
	nextReducedFraction,
	parseSimpleFraction,
} from "./size-target";

/** Default denominator used by the bundled configuration. */
const DEFAULT_DENOMINATOR = 8;

describe("knowledge size target", () => {
	/**
	 * Proves A4-page size targets are emitted as simple fractions, never decimals.
	 * Inputs and expected outputs: 2/3, 1/2, 3/8, and a full page map to stable fraction phrases.
	 * Edge case: the full-page target uses a dedicated phrase instead of "8/8".
	 * Dependencies: the fixed 500-word A4 anchor is exported for prompt embedding.
	 */
	test("formats size targets as simple A4 page fractions", () => {
		expect(formatA4Fraction(2 / 3, DEFAULT_DENOMINATOR)).toBe(
			"2/3 of an A4 page",
		);
		expect(formatA4Fraction(1 / 2, DEFAULT_DENOMINATOR)).toBe(
			"1/2 of an A4 page",
		);
		expect(formatA4Fraction(3 / 8, DEFAULT_DENOMINATOR)).toBe(
			"3/8 of an A4 page",
		);
		expect(formatA4Fraction(1, DEFAULT_DENOMINATOR)).toBe("a full A4 page");
		expect(A4_PAGE_ANCHOR_TEXT).toBe("One A4 page is about 500 words.");
	});

	/**
	 * Proves a larger denominator admits finer size targets.
	 * Inputs and expected outputs: with denominator 16, 5/16 formats as 5/16 and 1/3 formats as the closest sixteenth.
	 * Edge case: the emitted denominator never exceeds the configured maximum.
	 * Dependencies: formatA4Fraction uses the configured denominator.
	 */
	test("formats size targets with a configured denominator", () => {
		expect(formatA4Fraction(5 / 16, 16)).toBe("5/16 of an A4 page");
		expect(formatA4Fraction(7 / 16, 16)).toBe("7/16 of an A4 page");
		expect(formatA4Fraction(1 / 3, 16)).toBe("1/3 of an A4 page");
		expect(formatA4Fraction(1 / 2, 16)).toBe("1/2 of an A4 page");
	});

	/**
	 * Proves the default reduction chain stays within eighths: 2/3 → 1/2 → 3/8.
	 * Inputs and expected outputs: the default coefficient 3/4 maps each step to the exact next fraction.
	 * Edge case: results that are not exact eighths round to the nearest eighth.
	 * Dependencies: nextReducedFraction owns the chain step.
	 */
	test("reduces fractions by the configured coefficient", () => {
		expect(nextReducedFraction(2 / 3, 3 / 4, DEFAULT_DENOMINATOR)).toBe(1 / 2);
		expect(nextReducedFraction(1 / 2, 3 / 4, DEFAULT_DENOMINATOR)).toBe(3 / 8);
		expect(nextReducedFraction(3 / 8, 3 / 4, DEFAULT_DENOMINATOR)).toBe(1 / 4);
	});

	/**
	 * Proves equidistant results round toward the smaller eighth.
	 * Input and expected output: 1/4 × 3/4 = 3/16 sits exactly between 1/8 and 1/4 and rounds down to 1/8.
	 * Edge case: tie-break direction is stable for repeated retries.
	 * Dependencies: rounding rule defined by nextReducedFraction.
	 */
	test("rounds ties toward the lower eighth", () => {
		expect(nextReducedFraction(1 / 4, 3 / 4, DEFAULT_DENOMINATOR)).toBe(1 / 8);
	});

	/**
	 * Proves a larger denominator produces finer reduction steps.
	 * Inputs and expected outputs: with denominator 16, 1/2 × 3/4 stays 3/8 of a page on the sixteenth scale and ties round down.
	 * Edge case: the minimum applies at the configured scale.
	 * Dependencies: nextReducedFraction uses the configured denominator.
	 */
	test("reduces fractions with a configured denominator", () => {
		expect(nextReducedFraction(1 / 2, 3 / 4, 16)).toBe(3 / 8);
		expect(nextReducedFraction(3 / 8, 3 / 4, 16)).toBe(5 / 16);
		expect(nextReducedFraction(1 / 4, 3 / 4, 16)).toBe(3 / 16);
	});

	/**
	 * Proves the retry chain never drops below one part of the configured scale.
	 * Input and expected output: the minimum fraction stays at 1/maxDenominator regardless of the coefficient magnitude.
	 * Edge case: the minimum applies regardless of the coefficient magnitude.
	 * Dependencies: the configured-scale floor contract.
	 */
	test("never reduces below one part of the configured scale", () => {
		expect(nextReducedFraction(1 / 8, 3 / 4, DEFAULT_DENOMINATOR)).toBe(1 / 8);
		expect(nextReducedFraction(1 / 8, 1 / 4, DEFAULT_DENOMINATOR)).toBe(1 / 8);
		expect(nextReducedFraction(1 / 16, 1 / 4, 16)).toBe(1 / 16);
	});

	/**
	 * Proves config strings parse to numeric fractions with denominators up to the configured maximum.
	 * Inputs and expected outputs: "2/3" and "1/2" resolve to their exact numeric values.
	 * Edge case: the maximal configured denominator is accepted.
	 * Dependencies: parseSimpleFraction validates the simple-fraction contract.
	 */
	test("parses simple fractions with denominators up to the configured maximum", () => {
		expect(parseSimpleFraction("2/3", DEFAULT_DENOMINATOR)).toBe(2 / 3);
		expect(parseSimpleFraction("1/2", DEFAULT_DENOMINATOR)).toBe(0.5);
		expect(parseSimpleFraction("7/8", DEFAULT_DENOMINATOR)).toBe(7 / 8);
		expect(parseSimpleFraction("7/8", 16)).toBe(7 / 8);
		expect(parseSimpleFraction("15/16", 16)).toBe(15 / 16);
	});

	/**
	 * Proves invalid fraction strings are rejected with a stable diagnostic.
	 * Inputs and expected outputs: decimals, over-one values, oversized denominators, and non-fractions return error strings.
	 * Edge case: numerator-only input without a slash is rejected; a valid fraction exceeding the configured maximum is rejected.
	 * Dependencies: parseSimpleFraction is the single validation point.
	 */
	test("rejects invalid fraction strings", () => {
		for (const invalid of ["0.5", "3/2", "x", "2", "2/3 ", ""]) {
			expect(typeof parseSimpleFraction(invalid, DEFAULT_DENOMINATOR)).toBe(
				"string",
			);
		}
		expect(parseSimpleFraction(0.5, DEFAULT_DENOMINATOR)).toContain(
			"simple fraction",
		);
		expect(parseSimpleFraction("15/16", DEFAULT_DENOMINATOR)).toContain(
			"denominator must not exceed 8",
		);
	});
});
