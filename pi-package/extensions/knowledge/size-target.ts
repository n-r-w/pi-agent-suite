/** Maximum denominator accepted for A4-page size targets. */
export const MAX_FRACTION_DENOMINATOR = 8;

/** Half-way rounding offset used by the nearest-eighth reduction rule. */
const ROUNDING_HALF = 0.5;

/** Simple-fraction contract accepted by configuration parsing. */
const SIMPLE_FRACTION_PATTERN = /^\d+\/\d+$/u;

/** Fixed anchor so every model interprets one A4 page identically. */
export const A4_PAGE_ANCHOR_TEXT = "One A4 page is about 500 words.";

/** Formats one size target as a simple A4 page fraction, never as a decimal. */
export function formatA4Fraction(fraction: number): string {
	if (fraction >= 1) {
		return "a full A4 page";
	}
	const { numerator, denominator } = toSimpleFraction(fraction);
	return `${numerator}/${denominator} of an A4 page`;
}

/** Returns the next reduced size target for one retry step. */
export function nextReducedFraction(
	fraction: number,
	coefficient: number,
): number {
	const reduced = fraction * coefficient;
	const eighthCount = Math.floor(
		reduced * MAX_FRACTION_DENOMINATOR + ROUNDING_HALF - Number.EPSILON,
	);
	const clamped = Math.max(1, Math.min(MAX_FRACTION_DENOMINATOR, eighthCount));
	return clamped / MAX_FRACTION_DENOMINATOR;
}

/** Parses one "n/d" fraction string with a denominator of at most eight. */
export function parseSimpleFraction(value: unknown): number | string {
	if (typeof value !== "string" || !SIMPLE_FRACTION_PATTERN.test(value)) {
		return "must be a simple fraction like 2/3";
	}
	const [numeratorText, denominatorText] = value.split("/", 2);
	const numerator = Number(numeratorText);
	const denominator = Number(denominatorText);
	if (numerator < 1 || denominator < 1) {
		return "must be a simple fraction like 2/3";
	}
	if (numerator > denominator) {
		return "fraction must not exceed 1";
	}
	if (denominator > MAX_FRACTION_DENOMINATOR) {
		return `fraction denominator must not exceed ${MAX_FRACTION_DENOMINATOR}`;
	}
	return numerator / denominator;
}

/** Finds the closest simple fraction with a denominator of at most eight. */
function toSimpleFraction(value: number): {
	readonly numerator: number;
	readonly denominator: number;
} {
	let bestNumerator = 1;
	let bestDenominator = 1;
	let bestError = Number.POSITIVE_INFINITY;
	for (
		let denominator = 1;
		denominator <= MAX_FRACTION_DENOMINATOR;
		denominator += 1
	) {
		const numerator = Math.round(value * denominator);
		if (numerator < 1 || numerator > denominator) {
			continue;
		}
		const error = Math.abs(numerator / denominator - value);
		if (error < bestError) {
			bestError = error;
			bestNumerator = numerator;
			bestDenominator = denominator;
		}
	}
	return { numerator: bestNumerator, denominator: bestDenominator };
}
