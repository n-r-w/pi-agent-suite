import { type TString, type TStringOptions, Type } from "typebox";

/** Provider-safe approximation for a non-empty identifier without whitespace. */
const TECHNICAL_IDENTIFIER_SCHEMA_PATTERN = "^\\S+$";

/** Provider-safe approximation for trimmed non-empty single-line text. */
const SINGLE_LINE_TEXT_SCHEMA_PATTERN = "^\\S(?:.*\\S)?$";

/** Detects every whitespace value forbidden by the exact identifier contract. */
const IDENTIFIER_WHITESPACE_PATTERN = /[\s\u0085]/u;

/** Detects every line separator forbidden by the exact single-line contract. */
const LINE_SEPARATOR_PATTERN = /[\r\n\u0085\u2028\u2029]/u;

/** Accepts caller-owned TypeBox metadata and LLM-specific length budgets. */
type StringContractOptions = Omit<TStringOptions, "pattern">;

/** Creates a provider-safe TypeBox schema for one technical identifier. */
export function technicalIdentifierSchema(
	options: StringContractOptions = {},
): TString {
	return Type.String({
		...options,
		pattern: TECHNICAL_IDENTIFIER_SCHEMA_PATTERN,
	});
}

/** Creates a provider-safe TypeBox schema for one human-readable single-line value. */
export function singleLineTextSchema(
	options: StringContractOptions = {},
): TString {
	return Type.String({ ...options, pattern: SINGLE_LINE_TEXT_SCHEMA_PATTERN });
}

/** Reports whether an unknown runtime value is a non-empty identifier without whitespace. */
export function isTechnicalIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!IDENTIFIER_WHITESPACE_PATTERN.test(value)
	);
}

/** Reports whether an unknown runtime value is trimmed, non-empty, and single-line. */
export function isSingleLineText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		!LINE_SEPARATOR_PATTERN.test(value)
	);
}
