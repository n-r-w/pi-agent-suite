import { describe, expect, test } from "bun:test";
import { Box, visibleWidth } from "@mariozechner/pi-tui";
import {
	renderConveneCouncilCall,
	renderConveneCouncilResult,
} from "../../../pi-package/extensions/convene-council/rendering";

const SGR_RESET = "\u001b[0m";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

describe("convene-council rendering", () => {
	test("keeps call and collapsed result rows within visible width", () => {
		// Purpose: council tool rendering must keep compact rows inside the width Pi gives the component.
		// Input and expected output: complex Unicode question and answer render within 60 columns.
		// Edge case: emoji variation sequences appear near clipping boundaries.
		// Dependencies: public renderer functions and pi-tui visible-width measurement.
		const text =
			"Question before ⚠️ finding with Русский текст and emoji 👨‍👩‍👧‍👦 repeated for width";

		const callLines = renderConveneCouncilCall(
			{ question: text },
			theme,
		).render(60);
		const resultLines = renderConveneCouncilResult(
			{ content: [{ type: "text", text }], details: undefined },
			{ expanded: false },
			theme,
			{ isError: false },
		).render(60);

		expect(callLines).toHaveLength(1);
		expect(callLines[0]).toStartWith("convene_council:");
		for (const line of [...callLines, ...resultLines]) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("renders collapsed council output through the standard Pi tool box", () => {
		// Purpose: collapsed output must satisfy the default Box width contract without owning shell layout.
		// Input and expected output: boxed output contains the council label and visible answer text within width.
		// Edge case: a long word crosses the content boundary.
		// Dependencies: public Pi TUI Box component.
		const answer = "alpha beta supercalifragilisticexpialidocious omega";
		const boxWidth = 26;
		const component = renderConveneCouncilResult(
			{ content: [{ type: "text", text: answer }], details: undefined },
			{ expanded: false },
			theme,
			{ isError: false },
		);
		const box = new Box(1, 1, (text: string) => text);
		box.addChild(component);

		const renderedLines = box.render(boxWidth);
		const rendered = renderedLines.join("\n");

		expect(rendered).toContain("Council:");
		expect(rendered).toContain("alpha beta");
		expect(rendered).toContain("omega");
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(boxWidth);
		}
	});

	test("preserves full answer text in expanded rendering", () => {
		// Purpose: expanded rendering must expose the full council answer instead of the collapsed preview.
		// Input and expected output: expanded result contains both answer lines.
		// Edge case: multiple paragraphs should remain visible without relying on global Pi theme initialization.
		// Dependencies: public renderer function.
		const answer = "First line\n\nSecond line";

		const lines = renderConveneCouncilResult(
			{ content: [{ type: "text", text: answer }], details: undefined },
			{ expanded: true },
			theme,
			{ isError: false },
		).render(80);
		const rendered = lines.join("\n");

		expect(rendered).toContain("Council");
		expect(rendered).toContain("First line");
		expect(rendered).toContain("Second line");
	});
});
