import { afterEach, describe, expect, test } from "bun:test";
import {
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderVisionCall, renderVisionResult } from "./rendering";

const HIDDEN_LINES_HINT = /\.\.\. \(\d+ more lines, \d+ total, .+ to expand\)/;
const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

function setExpandKeybinding() {
	setKeybindings(
		new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.tools.expand": {
				defaultKeys: "ctrl+o",
				description: "Expand collapsed tool output",
			},
		}),
	);
}

describe("vision rendering", () => {
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
	test("renders a collapsed call with its complete path and a bounded prompt preview", () => {
		// Purpose: collapsed calls preserve the full image path while limiting only the prompt preview.
		// Input and expected output: a wrapped path is complete, two prompt rows remain, and the prompt hint reports hidden rows.
		// Edge case: whitespace in the prompt collapses only in the preview.
		// Dependencies: renderVisionCall uses shared visual wrapping and keybinding presentation.
		setExpandKeybinding();
		const path = `${"images/".repeat(20)}cat.png`;
		const component = renderVisionCall(
			{
				image_path: path,
				prompt: "first\n second third fourth fifth sixth ".repeat(8),
			},
			theme,
			{ expanded: false },
		);
		const lines = component.render(80);
		expect(lines[0]).toContain("describe_image:");
		expect(lines.join("")).toContain(path);
		expect(lines.filter((line) => line.includes("Prompt:")).length).toBe(1);
		const promptLine = lines.findIndex((line) => line.includes("Prompt:"));
		expect(lines.slice(promptLine, -1)).toHaveLength(2);
		expect(lines.at(-2)).toEndWith("...");
		expect(lines.at(-1)).toMatch(HIDDEN_LINES_HINT);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders an expanded call with the original prompt", () => {
		// Purpose: expansion exposes the submitted prompt without collapsed-text normalization.
		// Input and expected output: the prompt heading precedes the original multiline text.
		// Edge case: duplicate whitespace remains visible.
		// Dependencies: renderVisionCall selects its full-text branch from context.expanded.
		const component = renderVisionCall(
			{ image_path: "cat.png", prompt: "first\n\tsecond  third" },
			theme,
			{ expanded: true },
		);
		const lines = component.render(80).map((line) => line.trimEnd());
		expect(lines).toEqual([
			"describe_image: cat.png",
			"--- Prompt ---",
			"first",
			"   second  third",
		]);
	});

	test("renders collapsed results with an independent expansion hint", () => {
		// Purpose: result previews use their own two-line visual limit and error label.
		// Input and expected output: normalized result text is labeled Error and followed by its hidden-line hint.
		// Edge case: result wrapping is independent from call rendering.
		// Dependencies: renderVisionResult extracts public text and uses the shared collapsed-text helper.
		setExpandKeybinding();
		const component = renderVisionResult(
			{
				content: [
					{
						type: "text",
						text: "one two three four five six seven eight ".repeat(10),
					},
				],
				details: {},
			},
			{ expanded: false },
			theme,
			{ isError: true },
		);
		const lines = component.render(80);
		expect(lines[0]).toContain("Error:");
		expect(lines.at(-2)).toEndWith("...");
		expect(lines.at(-1)).toMatch(HIDDEN_LINES_HINT);
		expect(lines).toHaveLength(3);
	});

	test("renders expanded results as raw text", () => {
		// Purpose: result expansion preserves raw output rather than interpreting Markdown.
		// Input and expected output: a description heading precedes literal Markdown characters and original newlines.
		// Edge case: stars remain visible instead of becoming formatting.
		// Dependencies: renderVisionResult selects the expanded Text rendering branch.
		const component = renderVisionResult(
			{
				content: [{ type: "text", text: "**image**\nsecond line" }],
				details: {},
			},
			{ expanded: true },
			theme,
			{ isError: false },
		);
		expect(component.render(80).map((line) => line.trimEnd())).toEqual([
			"--- Description ---",
			"**image**",
			"second line",
		]);
	});
});
