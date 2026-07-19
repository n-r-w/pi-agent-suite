import { describe, expect, test } from "bun:test";
import { estimateTextTokens, takeTextTokenPrefix } from "./context-size";

describe("estimateTextTokens", () => {
	/** Proves text-only adaptive budgets use the selected model encoding without request framing. */
	test("counts standalone text with the selected model tokenizer", () => {
		// ARRANGE: Dense text distinguishes tokenizer counting from character heuristics.
		const text = "antidisestablishmentarianism".repeat(40);

		// ACT: Count the same text for a known modern OpenAI model and an unknown model.
		const knownModelTokens = estimateTextTokens(text, "gpt-5", "openai");
		const fallbackTokens = estimateTextTokens(text, undefined, undefined);

		// ASSERT: Both paths return usable conservative counts without request overhead.
		expect(knownModelTokens).toBeGreaterThan(0);
		expect(fallbackTokens).toBeGreaterThanOrEqual(knownModelTokens);
		expect(estimateTextTokens("", "gpt-5", "openai")).toBe(0);
	});

	/** Proves hard fragment fallback returns a lossless prefix at a selected tokenizer boundary. */
	test("takes a bounded prefix at a model token boundary", () => {
		// ARRANGE: Dense text has no useful paragraph, line, sentence, or word boundary.
		const text = "antidisestablishmentarianism".repeat(10);

		// ACT: Keep only the first five selected-model tokens.
		const prefix = takeTextTokenPrefix(text, 5, "gpt-5", "openai");

		// ASSERT: The decoded token prefix is non-empty, lossless, and within the token limit.
		expect(prefix.length).toBeGreaterThan(0);
		expect(text.startsWith(prefix)).toBeTrue();
		expect(estimateTextTokens(prefix, "gpt-5", "openai")).toBeLessThanOrEqual(
			5,
		);
	});

	/** Proves token-prefix decoding never returns replacement text for split Unicode tokens. */
	test("keeps decoded Unicode token prefixes lossless", () => {
		// ARRANGE: Emoji sequences can span several tokenizer byte tokens.
		const text = "👩‍💻界🚀".repeat(4);
		const totalTokens = estimateTextTokens(text, "gpt-5", "openai");

		// ACT: Decode every bounded token-prefix size.
		const prefixes = Array.from({ length: totalTokens }, (_, index) =>
			takeTextTokenPrefix(text, index + 1, "gpt-5", "openai"),
		);

		// ASSERT: Empty early limits can become lossless later, and every returned value stays exact.
		expect(prefixes.findIndex((prefix) => prefix.length > 0)).toBeGreaterThan(
			0,
		);
		for (const [index, prefix] of prefixes.entries()) {
			expect(prefix.length === 0 || text.startsWith(prefix)).toBeTrue();
			expect(estimateTextTokens(prefix, "gpt-5", "openai")).toBeLessThanOrEqual(
				index + 1,
			);
		}
	});
});
