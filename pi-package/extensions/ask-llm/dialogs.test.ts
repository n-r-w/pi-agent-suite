import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AskAnswerDialog } from "./dialogs.ts";

const WIDTH = 72;
const TERMINAL_ROWS = 18;
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

describe("ask-llm dialogs", () => {
	test("keeps unicode answer rendering height and width stable while scrolling", async () => {
		// Purpose: scrolling a long Unicode answer must not leave stale overlay rows behind.
		// Input and expected output: long mixed-script text renders with a stable bounded row count before and after scrolling.
		// Edge case: lines include Cyrillic, emoji, CJK, accents, RTL text, symbols, and wrapped rows.
		// Dependencies: this test uses the dialog component directly with a fake TUI and plain theme.
		const dialog = new AskAnswerDialog({
			tui: {
				terminal: { rows: TERMINAL_ROWS },
				requestRender(): void {},
			} as never,
			theme: {
				fg: (_color, value) => value,
				bold: (value) => value,
			},
			question:
				"Для тестирования выведи длинный ответ с unicode, emoji 🧊, kana かな, арабским مثال и accents déjà vu.",
			answer: buildUnicodeAnswer(),
			onCopyAnswer: () => undefined,
			onDone: () => undefined,
		});
		const firstRender = dialog.render(WIDTH);

		await dialog.handleInput(PAGE_DOWN);
		const secondRender = dialog.render(WIDTH);
		await dialog.handleInput(PAGE_UP);
		const thirdRender = dialog.render(WIDTH);

		expect(firstRender).toHaveLength(TERMINAL_ROWS - 2);
		expect(secondRender).toHaveLength(firstRender.length);
		expect(thirdRender).toHaveLength(firstRender.length);
		for (const render of [firstRender, secondRender, thirdRender]) {
			for (const line of render) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
			}
		}
		expect(firstRender.join("\n")).toContain("Question");
		expect(firstRender.join("\n")).toContain("Answer");
		expect(secondRender.join("\n")).not.toEqual(firstRender.join("\n"));
		expect(thirdRender.join("\n")).toEqual(firstRender.join("\n"));
	});
});

function buildUnicodeAnswer(): string {
	const lines: string[] = [];
	for (let index = 1; index <= 50; index += 1) {
		lines.push(
			`${index.toString().padStart(2, "0")} Тестовая строка с кириллицей, emoji 🧊🚀, CJK 漢字, kana かな, accents café naïve, RTL مثال, symbols ∞ Ω Σ и длинным хвостом для переноса.`,
		);
	}
	return lines.join("\n");
}
