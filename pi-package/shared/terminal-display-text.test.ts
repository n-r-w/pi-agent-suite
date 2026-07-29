import { describe, expect, test } from "bun:test";
import { normalizeCollapsedToolText } from "./terminal-display-text.ts";

describe("normalizeCollapsedToolText", () => {
	test("folds layout whitespace and removes terminal controls from plain text", () => {
		// Purpose: collapsed tool text must occupy one safe logical line before Pi wraps it visually.
		// Input and expected output: line controls become spaces while BEL and ANSI styling are removed.
		// Edge case: visible text inside an ANSI color sequence remains visible.
		// Dependencies: Node terminal-control stripping and the shared terminal whitespace contract.
		const input = " first\n\tsecond  third\r\n\u0007\u001b[31mred\u001b[0m ";

		expect(normalizeCollapsedToolText(input)).toBe("first second third red");
	});

	test("normalizes JSON strings without changing non-string lexemes", () => {
		// Purpose: JSON previews must compact encoded controls without changing represented paths, regular expressions, or numbers.
		// Input and expected output: source formatting controls collapse while literal backslashes and a large integer remain exact.
		// Edge case: parsing and reserializing the complete value would round the integer beyond JavaScript's safe range.
		// Dependencies: native JSON validation and per-token string decoding only.
		const unicode = "Русский 👨‍👩‍👧‍👦";
		const input = String.raw`{"body":"first\n\tsecond  third\r\nfourth\u001b[31mred\u001b[0m","path":"C:\\temp\\new","regex":"\\n+","unicode":"${unicode}","id":9007199254740993}`;
		const expected = String.raw`{"body":"first second third fourthred","path":"C:\\temp\\new","regex":"\\n+","unicode":"${unicode}","id":9007199254740993}`;

		expect(normalizeCollapsedToolText(input)).toBe(expected);
	});

	test("keeps textual escape sequences in non-JSON text", () => {
		// Purpose: plain output must not reinterpret a backslash sequence that can represent source code or a regular expression.
		// Input and expected output: duplicate spaces collapse but the literal backslash and letter remain unchanged.
		// Edge case: the text resembles one JSON escape but is not a complete JSON value.
		// Dependencies: complete JSON validation gates escaped-control decoding.
		const input = String.raw`literal \n  expression`;

		expect(normalizeCollapsedToolText(input)).toBe(
			String.raw`literal \n expression`,
		);
	});
});
