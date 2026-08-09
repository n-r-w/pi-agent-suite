import { describe, expect, test } from "bun:test";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import {
	countKnowledgeTextTokens,
	estimateTextTokens,
	takeTextTokenPrefix,
} from "./context-size";

describe("estimateTextTokens", () => {
	/** Proves standalone text uses the fixed o200k tokenizer without request framing. */
	test("counts standalone text with the fixed o200k tokenizer", () => {
		// ARRANGE: Japanese text has different cl100k_base and o200k_base token counts.
		const text = "お誕生日おめでとう".repeat(40);

		// ACT: Count it through the public API and directly through o200k_base ranks.
		const estimatedTokens = estimateTextTokens(text);
		const o200kTokens = new Tiktoken(o200kBase).encode(text, [], []).length;

		// ASSERT: The public estimate is the fixed o200k_base count.
		expect(estimatedTokens).toBeGreaterThan(0);
		expect(estimatedTokens).toBe(o200kTokens);
		expect(estimateTextTokens("")).toBe(0);
	});

	/** Proves hard fragment fallback returns a lossless prefix at an o200k token boundary. */
	test("takes a bounded prefix at an o200k token boundary", () => {
		// ARRANGE: Dense text has no useful paragraph, line, sentence, or word boundary.
		const text = "antidisestablishmentarianism".repeat(10);

		// ACT: Keep only the first five o200k tokens.
		const prefix = takeTextTokenPrefix(text, 5);

		// ASSERT: The decoded token prefix is non-empty, lossless, and within the token limit.
		expect(prefix.length).toBeGreaterThan(0);
		expect(text.startsWith(prefix)).toBeTrue();
		expect(estimateTextTokens(prefix)).toBeLessThanOrEqual(5);
	});

	/** Proves token-prefix decoding never returns replacement text for split Unicode tokens. */
	test("keeps decoded Unicode token prefixes lossless", () => {
		// ARRANGE: Emoji sequences can span several tokenizer byte tokens.
		const text = "👩‍💻界🚀".repeat(4);
		const totalTokens = estimateTextTokens(text);

		// ACT: Decode every bounded token-prefix size.
		const prefixes = Array.from({ length: totalTokens }, (_, index) =>
			takeTextTokenPrefix(text, index + 1),
		);

		// ASSERT: Empty early limits can become lossless later, and every returned value stays exact.
		expect(prefixes.findIndex((prefix) => prefix.length > 0)).toBeGreaterThan(
			0,
		);
		for (const [index, prefix] of prefixes.entries()) {
			expect(prefix.length === 0 || text.startsWith(prefix)).toBeTrue();
			expect(estimateTextTokens(prefix)).toBeLessThanOrEqual(index + 1);
		}
	});
});

describe("countKnowledgeTextTokens", () => {
	/** Proves knowledge limit checks use the single fixed o200k encoding. */
	test("counts with the fixed o200k encoding", () => {
		// ARRANGE: Dense text distinguishes tokenizer counting from character heuristics.
		const text = "antidisestablishmentarianism".repeat(40);

		// ACT: Compare the fixed knowledge count with the standalone o200k estimate.
		const knowledgeTokens = countKnowledgeTextTokens(text);
		const o200kTokens = estimateTextTokens(text);

		// ASSERT: Both paths use o200k_base and agree exactly.
		expect(knowledgeTokens).toBeGreaterThan(0);
		expect(knowledgeTokens).toBe(o200kTokens);
		expect(countKnowledgeTextTokens("")).toBe(0);
	});
});
