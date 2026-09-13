const TOKENS_PER_THOUSAND = 1_000;
const THOUSANDS_PER_MILLION = 1_000;
const DECIMAL_FACTOR = 10;
const TOKENS_PER_MILLION_TENTH = 100_000;
const TOKENS_PER_BILLION_TENTH = 100_000_000;
const MILLION_TENTHS_PER_BILLION = 10_000;

/** Formats processed tokens with the shared usage-history rounding contract. */
export function formatUsageTokenCount(value: number): string {
	if (value < TOKENS_PER_THOUSAND) {
		return Math.round(value).toString();
	}
	const thousands = Math.ceil(value / TOKENS_PER_THOUSAND);
	if (thousands < THOUSANDS_PER_MILLION) {
		return `${thousands}K`;
	}
	const millionTenths = Math.ceil(value / TOKENS_PER_MILLION_TENTH);
	if (millionTenths < MILLION_TENTHS_PER_BILLION) {
		return `${(millionTenths / DECIMAL_FACTOR).toFixed(1)}M`;
	}
	const billionTenths = Math.ceil(value / TOKENS_PER_BILLION_TENTH);
	return `${(billionTenths / DECIMAL_FACTOR).toFixed(1)}B`;
}
