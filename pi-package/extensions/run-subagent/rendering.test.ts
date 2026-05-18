import { afterEach, describe, expect, test } from "bun:test";
import {
	type KeybindingDefinitions,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderRunSubagentCall } from "./rendering.ts";

const WIDTH = 72;
const HIDDEN_LINE_HINT =
	"<muted>... (4 more lines, 7 total, </muted><dim>ctrl+o</dim><muted> to expand)</muted>";

const plainTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const markerTheme = {
	fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
	bold: (text: string): string => `<bold>${text}</bold>`,
};

const keybindingsWithToolExpansion: KeybindingDefinitions = {
	...TUI_KEYBINDINGS,
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand collapsed tool output",
	},
};

describe("run-subagent rendering", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	test("wraps long task text in the tool call preview", () => {
		const renderedLines = renderRunSubagentCall(
			{
				agentId: "SubAgentSage",
				prompt:
					"Analyze the design issue in the active tool renderer and explain the smallest safe fix that preserves collapsed previews.",
			},
			plainTheme as never,
			{},
		).render(WIDTH);

		expect(renderedLines.length).toBeGreaterThan(2);
		expect(renderedLines[1]).toContain("Task:");
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("limits collapsed task rows and colors the hidden-line hint by segment", () => {
		setKeybindings(new KeybindingsManager(keybindingsWithToolExpansion));
		const args = {
			agentId: "SubAgentSage",
			prompt: "0123456789 ".repeat(40),
		};
		const renderedLines = renderRunSubagentCall(
			args,
			plainTheme as never,
			{},
		).render(WIDTH);
		const coloredLines = renderRunSubagentCall(
			args,
			markerTheme as never,
			{},
		).render(WIDTH);

		expect(renderedLines).toHaveLength(5);
		expect(coloredLines.at(-1)).toBe(HIDDEN_LINE_HINT);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("shows all wrapped task rows when the tool call is expanded", () => {
		const args = {
			agentId: "SubAgentSage",
			prompt: "0123456789 ".repeat(40),
		};
		const collapsedLines = renderRunSubagentCall(
			args,
			plainTheme as never,
			{},
		).render(WIDTH);
		const expandedLines = renderRunSubagentCall(
			args,
			plainTheme as never,
			{ expanded: true } as never,
		).render(WIDTH);

		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
		expect(expandedLines.join("\n")).not.toContain("to expand");
		for (const line of expandedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});
});
