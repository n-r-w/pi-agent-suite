import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import {
	renderConsultAdvisorCall,
	renderConsultAdvisorResult,
} from "./rendering.ts";

const WIDTH = 48;
const THEME = {
	bold: (value: string) => value,
	fg: (_name: string, value: string) => value,
};

describe("consult-advisor rendering", () => {
	test("wraps long question text within the default Pi tool shell width", () => {
		// Purpose: consult_advisor must wrap the question in the call header instead of clipping it to one row.
		// Input and expected output: a long question renders across multiple bounded Box-contained rows.
		// Edge case: Box padding reduces the child width, so every rendered row must stay within the outer shell width.
		// Dependencies: this test uses the public Pi Box shell and visible-width measurement.
		const component = new Box(1, 1);
		component.addChild(
			renderConsultAdvisorCall(
				{
					question:
						"Final report check in Russian. Current user asked to fix color segmentation in mcp-wrapper hidden hint after approving.",
				},
				THEME as never,
			),
		);
		const lines = component.render(WIDTH);
		const output = lines.join("\n");

		expect(lines.length).toBeGreaterThan(3);
		expect(output).toContain("consult_advisor:");
		expect(output).toContain("Current user asked");
		expect(output).not.toContain("…");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("counts wrapped question rows against the call preview line budget", () => {
		// Purpose: consult_advisor call rendering must not let a long wrapped question consume unbounded TUI height.
		// Input and expected output: a huge question is wrapped, then capped to the call preview budget with a hidden-line hint.
		// Edge case: the limit is checked through the default Box shell, whose padding adds two outer rows.
		// Dependencies: this test uses the public Pi Box shell and visible-width measurement.
		const component = new Box(1, 1);
		component.addChild(
			renderConsultAdvisorCall(
				{
					question: Array.from(
						{ length: 80 },
						(_, index) => `question-token-${index}`,
					).join(" "),
				},
				THEME as never,
			),
		);
		const lines = component.render(WIDTH);
		const output = lines.join("\n");

		expect(lines).toHaveLength(6);
		expect(output).toContain("consult_advisor:");
		expect(output).toContain("more lines");
		expect(output).toContain("total");
		expect(output).toContain("to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("normalizes only the collapsed question", () => {
		// Purpose: compact questions must remove layout whitespace while expansion preserves the submitted question.
		// Input and expected output: a multiline question becomes one spaced preview and remains multiline when expanded.
		// Edge case: duplicate spaces after a tab remain observable only in the expanded view.
		// Dependencies: the public call renderer selects presentation from the expansion flag.
		const question = "first\n\tsecond  third";

		const collapsed = renderConsultAdvisorCall(
			{ question },
			THEME as never,
			{ expanded: false } as never,
		).render(200);
		const expanded = renderConsultAdvisorCall(
			{ question },
			THEME as never,
			{ expanded: true } as never,
		).render(200);

		expect(collapsed).toEqual(["consult_advisor: first second third"]);
		expect(expanded).toEqual(["consult_advisor: first", "\tsecond  third"]);
	});

	test("normalizes JSON escapes only in collapsed advice", () => {
		// Purpose: advisor previews must use the package-wide JSON-aware normalization contract.
		// Input and expected output: escaped formatting collapses in preview while expanded advice keeps the original JSON text.
		// Edge case: a literal escaped newline used as data remains unchanged.
		// Dependencies: the public result renderer owns collapsed Text and expanded Markdown paths.
		const text = String.raw`{"body":"first\n\tsecond  third","regex":"\\n+"}`;
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text }],
			details: {},
		};

		const collapsed = renderConsultAdvisorResult(
			result,
			{ expanded: false },
			THEME as never,
			{ isError: false },
		)
			.render(200)
			.join("\n");
		const expanded = renderConsultAdvisorResult(
			result,
			{ expanded: true },
			THEME as never,
			{ isError: false },
		)
			.render(200)
			.join("\n");

		expect(collapsed).toContain('"body":"first second third"');
		expect(collapsed).toContain(String.raw`"regex":"\\n+"`);
		expect(collapsed).not.toContain(String.raw`first\n\tsecond`);
		expect(expanded).toContain(String.raw`first\n\tsecond  third`);
	});

	test("shows full wrapped question when the call header is expanded", () => {
		// Purpose: consult_advisor must not lose hidden question text when the user expands the call header.
		// Input and expected output: a huge question is capped when collapsed and fully visible when expanded.
		// Edge case: the final token is beyond the collapsed line budget.
		// Dependencies: this test uses the renderCall expanded flag from Pi's ToolRenderContext.
		const question = Array.from(
			{ length: 80 },
			(_, index) => `question-token-${index}`,
		).join(" ");

		const collapsedLines = renderConsultAdvisorCall(
			{ question },
			THEME as never,
			{ expanded: false } as never,
		).render(WIDTH);
		const expandedLines = renderConsultAdvisorCall(
			{ question },
			THEME as never,
			{ expanded: true } as never,
		).render(WIDTH);

		expect(collapsedLines.join("\n")).toContain("more lines");
		expect(collapsedLines.join("\n")).toContain("total");
		expect(collapsedLines.join("\n")).toContain("to expand");
		expect(collapsedLines.join("\n")).not.toContain("question-token-79");
		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
		expect(expandedLines.join("")).toContain("question-token-79");
		expect(expandedLines.join("\n")).not.toContain("more lines");
		for (const line of expandedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});
});
