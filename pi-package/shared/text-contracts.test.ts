import { describe, expect, test } from "bun:test";
import { Check } from "typebox/value";
import {
	isSingleLineText,
	isTechnicalIdentifier,
	singleLineTextSchema,
	technicalIdentifierSchema,
} from "./text-contracts";

/** Covers the shared structural contracts used by schemas and runtime boundaries. */
describe("text contracts", () => {
	test("keeps technical identifiers non-empty and free of whitespace", () => {
		// Purpose: technical references must preserve arbitrary non-whitespace Unicode while rejecting layout separators.
		// Inputs and expected outputs: words, punctuation, and Unicode pass; common whitespace fails in both adapters.
		// Edge cases: provider-safe `\S` may admit next-line, which the exact runtime predicate rejects.
		// Dependencies: TypeBox Check and the exact runtime predicate are adapters owned by one contract module.
		const schema = technicalIdentifierSchema();
		const cases = [
			["align_goals", true, true],
			["этап-1", true, true],
			["!", true, true],
			["", false, false],
			["two words", false, false],
			["two\twords", false, false],
			["two\u00a0words", false, false],
			["two\u0085words", true, false],
			["value\n", false, false],
		] as const;

		expect(
			cases.map(([value]) => ({
				value,
				schema: Check(schema, value),
				runtime: isTechnicalIdentifier(value),
			})),
		).toEqual(
			cases.map(([value, schema, runtime]) => ({
				value,
				schema,
				runtime,
			})),
		);
	});

	test("keeps human text trimmed, non-blank, and single-line", () => {
		// Purpose: one reusable contract must protect every human-readable single-line field without restricting its language.
		// Inputs and expected outputs: Unicode and internal spaces pass; blank, padded, and common multiline values fail in both adapters.
		// Edge cases: the provider-safe dot may admit next-line, which the exact runtime predicate rejects.
		// Dependencies: TypeBox Check and the exact runtime predicate are adapters owned by one contract module.
		const schema = singleLineTextSchema();
		const cases = [
			["Team Lead", true, true],
			["Тимлид", true, true],
			["技术负责人", true, true],
			["", false, false],
			["   ", false, false],
			[" padded", false, false],
			["padded\u00a0", false, false],
			["two\nlines", false, false],
			["two\rline", false, false],
			["two\u0085lines", true, false],
			["two\u2028lines", false, false],
			["two\u2029lines", false, false],
			["value\n", false, false],
		] as const;

		expect(
			cases.map(([value]) => ({
				value,
				schema: Check(schema, value),
				runtime: isSingleLineText(value),
			})),
		).toEqual(
			cases.map(([value, schema, runtime]) => ({
				value,
				schema,
				runtime,
			})),
		);
	});
});
