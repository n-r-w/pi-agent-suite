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

	test("clips long call rows within the default Pi tool shell width", () => {
		const component = new Box(1, 1);
		component.addChild(
			renderMcpToolCall(
				"very_long_mcp_tool_name_that_fills_the_provider_name_budget",
				{ query: "x".repeat(200) },
				THEME as never,
			),
		);

		for (const line of component.render(WIDTH)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("dims collapsed successful result text", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "result text" }],
			details: {},
		};

		expect(
			renderMcpToolResult(result, {}, MARKED_THEME as never, {})
				.render(WIDTH)
				.join("\n"),
		).toBe("<dim>result text</dim>");
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
		).toBe("<error>error text</error>");
	});

	test("renders collapsed result with bounded preview and expand hint", () => {
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
		const component = new Box(1, 1);
		component.addChild(renderMcpToolResult(result, {}, THEME as never, {}));
		const lines = component.render(WIDTH);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("renders expanded full result content", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "full result" }],
			details: {},
		};
		const lines = renderMcpToolResult(
			result,
			{ expanded: true },
			THEME as never,
			{},
		).render(WIDTH);

		expect(lines.join("\n")).toContain("full result");
	});
});
