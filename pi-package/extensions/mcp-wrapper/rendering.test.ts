import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderMcpToolCall, renderMcpToolResult } from "./rendering.ts";

const WIDTH = 48;
const THEME = {
	bold: (value: string) => value,
	fg: (_name: string, value: string) => value,
};
const MARKED_THEME = {
	bold: (value: string) => `<bold>${value}</bold>`,
	fg: (name: string, value: string) => `<${name}>${value}</${name}>`,
};

describe("mcp-wrapper rendering", () => {
	test("renders call rows with the Pi tool name", () => {
		const component = new Box(1, 1);
		component.addChild(
			renderMcpToolCall(
				"fetch_fetch",
				{ url: "https://pi.dev/docs/latest/extensions" },
				THEME as never,
			),
		);
		const output = component.render(WIDTH).join("\n");

		expect(output).toContain("fetch_fetch:");
		expect(output).not.toContain("MCP:");
		for (const line of component.render(WIDTH)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("dims call arguments while keeping the Pi tool name prominent", () => {
		const output = renderMcpToolCall(
			"fetch_fetch",
			{ url: "https://pi.dev/docs/latest/extensions" },
			MARKED_THEME as never,
		)
			.render(120)
			.join("\n");

		expect(output).toStartWith(
			"<toolTitle><bold>fetch_fetch:</bold></toolTitle><dim> ",
		);
		expect(output).toContain(
			'{"url":"https://pi.dev/docs/latest/extensions"}</dim>',
		);
	});

	test("wraps long call arguments within the default Pi tool shell width", () => {
		const component = new Box(1, 1);
		component.addChild(
			renderMcpToolCall(
				"team_message_create",
				{
					topic_id: "17537fcd-7230-49bf-ab1d-a78b5ff4ab30",
					title: "Audit task context",
					content: "Task: audit implementation against pricing rules",
				},
				THEME as never,
				{ expanded: true } as never,
			),
		);
		const lines = component.render(WIDTH);
		const output = lines.join("\n");

		expect(lines.length).toBeGreaterThan(3);
		expect(output).toContain("team_message_create:");
		expect(output).toContain("pricing rules");
		expect(output).not.toContain("…");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("counts wrapped call arguments against the call preview line budget", () => {
		// Purpose: mcp-wrapper call rendering must not let huge wrapped arguments consume unbounded TUI height.
		// Input and expected output: huge arguments are capped when collapsed and show a standard hidden-line hint.
		// Edge case: the limit is checked through the default Box shell, whose padding adds two outer rows.
		// Dependencies: this test uses the public Pi Box shell and visible-width measurement.
		const component = new Box(1, 1);
		component.addChild(
			renderMcpToolCall(
				"team_message_create",
				{
					content: Array.from(
						{ length: 80 },
						(_, index) => `argument-token-${index}`,
					).join(" "),
				},
				THEME as never,
			),
		);
		const lines = component.render(WIDTH);
		const output = lines.join("\n");

		expect(lines).toHaveLength(6);
		expect(output).toContain("team_message_create:");
		expect(output).toContain("more lines");
		expect(output).toContain("total");
		expect(output).toContain("to expand");
		expect(output).not.toContain("argument-token-79");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("shows full wrapped call arguments when the call header is expanded", () => {
		// Purpose: mcp-wrapper must not lose hidden argument text when the user expands the call header.
		// Input and expected output: huge arguments are capped when collapsed and fully visible when expanded.
		// Edge case: the final token is beyond the collapsed line budget.
		// Dependencies: this test uses the renderCall expanded flag from Pi's ToolRenderContext.
		const args = {
			content: Array.from(
				{ length: 80 },
				(_, index) => `argument-token-${index}`,
			).join(" "),
		};

		const collapsedLines = renderMcpToolCall(
			"team_message_create",
			args,
			THEME as never,
			{ expanded: false } as never,
		).render(WIDTH);
		const expandedLines = renderMcpToolCall(
			"team_message_create",
			args,
			THEME as never,
			{ expanded: true } as never,
		).render(WIDTH);

		expect(collapsedLines.join("\n")).toContain("more lines");
		expect(collapsedLines.join("\n")).not.toContain("argument-token-79");
		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
		expect(expandedLines.join("")).toContain("argument-token-79");
		expect(expandedLines.join("\n")).not.toContain("more lines");
		for (const line of expandedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("normalizes collapsed JSON call arguments without changing expanded arguments", () => {
		// Purpose: compact MCP calls must hide formatting controls without corrupting literal backslashes.
		// Input and expected output: collapsed source text becomes one spaced line while expanded JSON retains its escaped formatting.
		// Edge case: Windows-style paths and regular expressions contain literal backslash sequences that must remain unchanged.
		// Dependencies: the public MCP call renderer owns both collapsed and expanded presentation.
		const args = {
			body: "first\n\tsecond  third\r\nfourth",
			path: String.raw`C:\temp\new`,
			regex: String.raw`\n+`,
		};

		const collapsed = renderMcpToolCall(
			"asteria_find_symbol",
			args,
			THEME as never,
			{ expanded: false } as never,
		)
			.render(240)
			.join("\n");
		const expanded = renderMcpToolCall(
			"asteria_find_symbol",
			args,
			THEME as never,
			{ expanded: true } as never,
		)
			.render(240)
			.join("\n");

		expect(collapsed).toContain('"body":"first second third fourth"');
		expect(collapsed).toContain(String.raw`"path":"C:\\temp\\new"`);
		expect(collapsed).toContain(String.raw`"regex":"\\n+"`);
		expect(collapsed).not.toContain(String.raw`first\n\tsecond`);
		expect(expanded).toContain(String.raw`first\n\tsecond  third\r\nfourth`);
	});

	test("normalizes collapsed JSON results without changing data lexemes", () => {
		// Purpose: serialized MCP results must become readable previews without changing their represented data.
		// Input and expected output: JSON string controls collapse while literal escapes and a large integer remain exact.
		// Edge case: parsing and reserializing the complete JSON value would round the integer beyond JavaScript's safe range.
		// Dependencies: the public result renderer receives the original MCP text and the expansion state.
		const text = String.raw`{"symbols":[{"body":"first\n\tsecond  third\r\nfourth","path":"C:\\temp\\new","regex":"\\n+","id":9007199254740993}]}`;
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text }],
			details: {},
		};

		const collapsed = renderMcpToolResult(
			result,
			{ expanded: false },
			THEME as never,
			{ widgetLineBudget: 5 },
		)
			.render(240)
			.join("\n");
		const expanded = renderMcpToolResult(
			result,
			{ expanded: true },
			THEME as never,
			{ widgetLineBudget: 5 },
		)
			.render(240)
			.join("\n");

		expect(collapsed).toContain('"body":"first second third fourth"');
		expect(collapsed).toContain(String.raw`"path":"C:\\temp\\new"`);
		expect(collapsed).toContain(String.raw`"regex":"\\n+"`);
		expect(collapsed).toContain("9007199254740993");
		expect(collapsed).not.toContain(String.raw`first\n\tsecond`);
		expect(expanded).toContain(String.raw`first\n\tsecond  third\r\nfourth`);
	});

	test("renders collapsed successful result with a prominent TUI-only header", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "result text" }],
			details: {},
		};

		expect(
			renderMcpToolResult(result, {}, MARKED_THEME as never, {
				widgetLineBudget: 5,
			})
				.render(WIDTH)
				.join("\n"),
		).toBe(
			"<toolTitle><bold>Result:</bold></toolTitle><dim> result text</dim>",
		);
	});

	test("keeps collapsed error result text styled as error", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "error text" }],
			details: {},
		};

		expect(
			renderMcpToolResult(result, {}, MARKED_THEME as never, {
				isError: true,
				widgetLineBudget: 5,
			})
				.render(WIDTH)
				.join("\n"),
		).toBe(
			"<toolTitle><bold>Result:</bold></toolTitle><error> error text</error>",
		);
	});

	test("renders collapsed result with bounded preview and segmented expand hint colors", () => {
		// Purpose: the visual-line budget must apply after collapsed whitespace normalization and Pi wrapping.
		// Input and expected output: normalized long text still produces a bounded preview and segmented expansion hint.
		// Edge case: source newlines no longer define the preview line count.
		// Dependencies: the public result renderer and Pi's width-aware text wrapping.
		const result: AgentToolResult<unknown> = {
			content: [
				{
					type: "text",
					text: Array.from(
						{ length: 20 },
						(_, index) => `line ${index} ${"content ".repeat(20)}`,
					).join("\n"),
				},
			],
			details: {},
		};
		const markedOutput = renderMcpToolResult(
			result,
			{},
			MARKED_THEME as never,
			{ widgetLineBudget: 2 },
		)
			.render(200)
			.join("\n");
		const component = new Box(1, 1);
		component.addChild(
			renderMcpToolResult(result, {}, THEME as never, { widgetLineBudget: 2 }),
		);
		const lines = component.render(WIDTH);

		expect(lines.length).toBeLessThanOrEqual(5);
		expect(markedOutput).toContain("<muted>... (");
		expect(markedOutput).toContain("more lines");
		expect(markedOutput).toContain("total, ");
		expect(markedOutput).toContain("</dim><muted> to expand)</muted>");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("renders expanded full result content with a prominent TUI-only header", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "full result" }],
			details: {},
		};
		const lines = renderMcpToolResult(
			result,
			{ expanded: true },
			MARKED_THEME as never,
			{ widgetLineBudget: 5 },
		).render(WIDTH);
		const output = lines.join("\n");

		expect(output).toContain("<toolTitle><bold>Result:</bold></toolTitle>");
		expect(output).toContain("full result");
	});
});
