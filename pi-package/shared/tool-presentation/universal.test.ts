import { afterEach, describe, expect, test } from "bun:test";
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
	KeybindingsManager,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createToolRenderContext } from "../../../test/support/tool-render-context.ts";
import { createUniversalToolDefinition } from "./universal.ts";

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
	theme: Theme = MARKED_THEME,
): string[] {
	if (definition.renderCall === undefined) {
		throw new Error("universal definition has no call renderer");
	}
	const component = definition.renderCall(
		args,
		theme,
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
	theme: Theme = MARKED_THEME,
): string[] {
	if (definition.renderResult === undefined) {
		throw new Error("universal definition has no result renderer");
	}
	const component = definition.renderResult(
		result,
		{ expanded: options.expanded, isPartial: false },
		theme,
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
	// Restore the global binding registry after the test-specific expansion shortcut.
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	test("renders unknown tools through bounded default shell", () => {
		// Purpose: unknown third-party tools must stay bounded while preserving Pi's public default shell and expansion behavior.
		// Input and expected output: long Unicode JSON and Markdown produce bounded previews with Pi's standard collapsed-content hint.
		// Edge case: the default shell stays width-bounded while expanded content retains the final Markdown text.
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
		setKeybindings(
			new KeybindingsManager({
				...TUI_KEYBINDINGS,
				"app.tools.expand": {
					defaultKeys: "ctrl+o",
					description: "Expand collapsed tool output",
				},
			}),
		);

		// ACT: render collapsed and expanded paths, then place the collapsed renderer in Pi's standard shell width contract.
		const callLines = renderCall(definition, args, width - 2);
		const collapsedLines = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			width - 2,
		);
		const standardHintLines = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			80,
			PLAIN_THEME,
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

		// ASSERT: visual budgets apply after Pi wrapping and the standard hint consumes one collapsed row.
		const standardHint = `... (3 more lines, 7 total, ${expansionKeys} to expand)`;
		expect({
			callLineCount: callLines.length,
			callHasName: callLines.join("\n").includes("third_party_tool"),
			collapsedLineCount: collapsedLines.length,
			standardHint: standardHintLines.at(-1) === standardHint,
			expandedHasTail: expandedLines.join("\n").includes("line 14:"),
			errorStyled: errorLines.join("\n").includes("<error>"),
			defaultShell: definition.renderShell,
			shellWithinWidth: shellLines.every((line) => visibleWidth(line) <= width),
		}).toEqual({
			callLineCount: 2,
			callHasName: true,
			collapsedLineCount: 5,
			standardHint: true,
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

	test("summarizes content beyond four collapsed visual lines", () => {
		// Purpose: the standard preview must reserve a separate hint row after four content rows.
		// Input and expected output: five visual lines produce four content rows followed by a one-line summary.
		// Edge case: the first hidden line sits exactly one row beyond the content budget.
		// Dependencies: the universal result renderer uses Pi's shared keybinding registry.
		const definition = createUniversalToolDefinition("third_party_tool");
		const contentLines = ["1", "2", "3", "4", "5"].map((value) =>
			value.repeat(79),
		);
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: contentLines.join(" ") }],
			details: undefined,
		};
		const expansionKeys = getKeybindings()
			.getKeys("app.tools.expand")
			.join("/");

		const lines = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			80,
			PLAIN_THEME,
		).map((line) => line.trimEnd());

		expect(lines).toEqual([
			...contentLines.slice(0, 4),
			`... (1 more line, 5 total, ${expansionKeys} to expand)`,
		]);
	});

	test("starts unknown tool arguments on the label row", () => {
		// Purpose: unknown tools must use available label-row width before wrapping serialized arguments.
		// Input and expected output: a long JSON argument starts immediately after the tool name and continues on later rows.
		// Edge case: the first JSON token is wider than the remaining label-row width and contains no spaces.
		// Dependencies: the universal call renderer uses Pi-compatible visual wrapping.
		const definition = createUniversalToolDefinition(
			"asteria_find_referencing_symbols",
		);
		const args = {
			workspace_root:
				"/Users/example/workspaces/pi-harness/pi-new-agents/with-a-long-suffix",
		};

		const lines = renderCall(definition, args, 80, PLAIN_THEME);

		expect(lines[0]).toStartWith(
			'asteria_find_referencing_symbols: {"workspace_root":',
		);
		expect(lines.length).toBe(2);
	});

	test("normalizes unknown tool previews without changing expanded output", () => {
		// Purpose: tools without package renderers must follow the same compact text contract as MCP tools.
		// Input and expected output: call and result JSON controls collapse while expanded output retains them.
		// Edge case: literal path and regular-expression backslashes remain data rather than formatting controls.
		// Dependencies: the universal definition delegates to bounded call and result components.
		const args = {
			body: "first\n\tsecond  third",
			path: String.raw`C:\temp\new`,
			regex: String.raw`\n+`,
		};
		const text = String.raw`{"body":"first\n\tsecond  third","path":"C:\\temp\\new","regex":"\\n+"}`;
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text }],
			details: undefined,
		};
		const definition = createUniversalToolDefinition("third_party_tool");

		const call = renderCall(definition, args, 240).join("\n");
		const collapsed = renderResult(
			definition,
			result,
			{ expanded: false, isError: false },
			240,
		).join("\n");
		const expanded = renderResult(
			definition,
			result,
			{ expanded: true, isError: false },
			240,
		).join("\n");

		expect(call).toContain('"body":"first second third"');
		expect(call).toContain(String.raw`"path":"C:\\temp\\new"`);
		expect(call).toContain(String.raw`"regex":"\\n+"`);
		expect(collapsed).toContain('"body":"first second third"');
		expect(collapsed).toContain(String.raw`"path":"C:\\temp\\new"`);
		expect(collapsed).toContain(String.raw`"regex":"\\n+"`);
		expect(expanded).toContain(String.raw`first\n\tsecond  third`);
	});
});
