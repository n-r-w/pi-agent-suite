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

	test("renders collapsed successful result with a prominent TUI-only header", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "result text" }],
			details: {},
		};

		expect(
			renderMcpToolResult(result, {}, MARKED_THEME as never, {})
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
			renderMcpToolResult(result, {}, MARKED_THEME as never, { isError: true })
				.render(WIDTH)
				.join("\n"),
		).toBe(
			"<toolTitle><bold>Result:</bold></toolTitle><error> error text</error>",
		);
	});

	test("renders collapsed result with bounded preview and segmented expand hint colors", () => {
		const result: AgentToolResult<unknown> = {
			content: [
				{
					type: "text",
					text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join(
						"\n",
					),
				},
			],
			details: {},
		};
		const markedOutput = renderMcpToolResult(
			result,
			{},
			MARKED_THEME as never,
			{},
		)
			.render(200)
			.join("\n");
		const component = new Box(1, 1);
		component.addChild(renderMcpToolResult(result, {}, THEME as never, {}));
		const lines = component.render(WIDTH);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(markedOutput).toContain("<muted>... (15 more lines, 20 total, ");
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
			{},
		).render(WIDTH);
		const output = lines.join("\n");

		expect(output).toContain("<toolTitle><bold>Result:</bold></toolTitle>");
		expect(output).toContain("full result");
	});
});
