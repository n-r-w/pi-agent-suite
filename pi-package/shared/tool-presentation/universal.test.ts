import { describe, expect, test } from "bun:test";
import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	getKeybindings,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createToolRenderContext } from "../../../test/support/tool-render-context.ts";
import { createUniversalToolDefinition } from "./universal.ts";

const HIDDEN_COUNT_PATTERN = /\d+ hidden/;
const MARKED_THEME = {
	bold: (value: string) => value,
	fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
} as Theme;
const PLAIN_THEME = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

/** Renders one definition call through its public custom-renderer contract. */
function renderCall(
	definition: ToolDefinition,
	args: unknown,
	width: number,
): string[] {
	if (definition.renderCall === undefined) {
		throw new Error("universal definition has no call renderer");
	}
	const component = definition.renderCall(
		args,
		MARKED_THEME,
		createToolRenderContext({ args, expanded: false, isError: false }),
	);
	component.invalidate();
	return component.render(width);
}

/** Renders one definition result through its public custom-renderer contract. */
function renderResult(
	definition: ToolDefinition,
	result: AgentToolResult<unknown>,
	options: { readonly expanded: boolean; readonly isError: boolean },
	width: number,
): string[] {
	if (definition.renderResult === undefined) {
		throw new Error("universal definition has no result renderer");
	}
	const component = definition.renderResult(
		result,
		{ expanded: options.expanded, isPartial: false },
		MARKED_THEME,
		createToolRenderContext({
			args: {},
			expanded: options.expanded,
			isError: options.isError,
		}),
	);
	component.invalidate();
	return component.render(width);
}

describe("universal tool presentation", () => {
	test("renders unknown tools through bounded default shell", () => {
		// Purpose: unknown third-party tools must stay bounded while preserving Pi's public default shell and expansion behavior.
		// Input and expected output: long Unicode JSON and Markdown produce at most two call rows and five collapsed result rows including the configured key hint.
		// Edge case: expanded content retains the final Markdown text and error output uses the error theme color.
		// Dependencies: public Pi ToolDefinition, ToolExecutionComponent, Box, Text, Markdown, keybinding, and width contracts.
		const width = 30;
		const args = {
			question: "🙂 recursive unknown argument ".repeat(8),
		};
		const longOutput = Array.from(
			{ length: 14 },
			(_, index) => `line ${index + 1}: **unknown Markdown output**`,
		).join("\n");
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: longOutput }],
			details: undefined,
		};
		const definition = createUniversalToolDefinition("third_party_tool");
		initTheme(undefined, false);

		// ACT: render collapsed and expanded paths, then place the collapsed renderer in Pi's standard shell width contract.
		const callLines = renderCall(definition, args, width - 2);
		const collapsedLines = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			width - 2,
		);
		const narrowCollapsedLines = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			18,
		);
		const expandedLines = renderResult(
			definition,
			result,
			{ expanded: true, isError: false },
			width - 2,
		);
		const errorLines = renderResult(
			definition,
			result,
			{ expanded: false, isError: true },
			width - 2,
		);
		const shell = new Box(1, 1);
		if (definition.renderResult === undefined) {
			throw new Error("universal definition has no shell result renderer");
		}
		shell.addChild(
			definition.renderResult(
				result,
				{ expanded: false, isPartial: false },
				PLAIN_THEME,
				createToolRenderContext({ args, expanded: false, isError: false }),
			),
		);
		const shellLines = shell.render(width);
		const expansionKeys = getKeybindings()
			.getKeys("app.tools.expand")
			.join("/");

		// ASSERT: visual budgets apply after Pi wrapping and the hidden-line hint consumes one collapsed row.
		expect({
			callLineCount: callLines.length,
			callHasName: callLines.join("\n").includes("third_party_tool"),
			collapsedLineCount: collapsedLines.length,
			collapsedHasHint:
				(collapsedLines.at(-1) ?? "").includes("hidden") &&
				(collapsedLines.at(-1) ?? "").includes(expansionKeys),
			narrowHintHasCountAndKey:
				HIDDEN_COUNT_PATTERN.test(narrowCollapsedLines.at(-1) ?? "") &&
				(narrowCollapsedLines.at(-1) ?? "").includes(expansionKeys),
			expandedHasTail: expandedLines.join("\n").includes("line 14:"),
			errorStyled: errorLines.join("\n").includes("<error>"),
			defaultShell: definition.renderShell,
			shellWithinWidth: shellLines.every((line) => visibleWidth(line) <= width),
		}).toEqual({
			callLineCount: 2,
			callHasName: true,
			collapsedLineCount: 5,
			collapsedHasHint: true,
			narrowHintHasCountAndKey: true,
			expandedHasTail: true,
			errorStyled: true,
			defaultShell: "default",
			shellWithinWidth: true,
		});

		// ASSERT: ToolExecutionComponent accepts the same public definition without a private renderer lookup.
		const ui = { requestRender(): void {} } as TUI;
		const execution = new ToolExecutionComponent(
			"third_party_tool",
			"unknown-call-1",
			args,
			{},
			definition,
			ui,
			"/tmp",
		);
		execution.markExecutionStarted();
		execution.setArgsComplete();
		execution.updateResult({ ...result, isError: false });
		expect(
			execution.render(width).every((line) => visibleWidth(line) <= width),
		).toBe(true);
	});
});
