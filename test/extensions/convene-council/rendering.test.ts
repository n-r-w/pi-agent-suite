import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
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

const colorTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
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

	test("renders collapsed council progress as latest fixed-width rows", () => {
		// Purpose: live council progress must look like compact tool progress without wrapping one event into multiple rows.
		// Input and expected output: more progress events than the preview limit render the latest events and a standard expand hint.
		// Edge case: participant runtime metadata uses two different providers while event text contains mixed Unicode.
		// Dependencies: public renderer functions and shared renderer state between result and call renderers.
		const eventCount = 8;
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "running" }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Which TUI should convene_council use?",
				status: "running",
				phase: "B reviews A",
				elapsedMs: 18_200,
				iteration: 2,
				iterationLimit: 3,
				participants: [
					{
						label: "A",
						participantId: "llm1",
						modelId: "openai-codex/gpt-5.5",
						thinking: "high",
						display: "openai-codex/gpt-5.5/high",
					},
					{
						label: "B",
						participantId: "llm2",
						modelId: "anthropic/claude-sonnet-4-5",
						thinking: "medium",
						display: "anthropic/claude-sonnet-4-5/medium",
					},
				],
				events: Array.from({ length: eventCount }, (_, index) => ({
					kind: index === 6 ? "retry" : "request",
					title: `event-${index + 1}`,
					text:
						index === 7 ? "Unicode ⚠️ 👨‍👩‍👧‍👦 שלום עולם العربية" : undefined,
					timestampMs: index + 1,
				})),
				omittedEventCount: 0,
			},
		};
		const rendererState = {};

		const progressLines = renderConveneCouncilResult(
			result,
			{ expanded: false },
			theme,
			{
				args: { question: "Which TUI should convene_council use?" },
				state: rendererState,
				isError: false,
			},
		).render(96);
		const callLines = renderConveneCouncilCall(
			{ question: "Which TUI should convene_council use?" },
			theme,
			{ state: rendererState },
		).render(96);

		expect(callLines[0]).toBe(
			"convene_council · B reviews A · iter 2/3 · 18.2s",
		);
		expect(callLines.join("\n")).toContain("Question: Which TUI should");
		expect(callLines.join("\n")).toContain("A openai-codex/gpt-5.5/high");
		expect(callLines.join("\n")).toContain(
			"B anthropic/claude-sonnet-4-5/medium",
		);
		expect(progressLines).toHaveLength(6);
		expect(progressLines.some((line) => line.includes("→ event-1"))).toBe(
			false,
		);
		expect(progressLines.some((line) => line.includes("→ event-4"))).toBe(true);
		expect(progressLines.some((line) => line.includes("! event-7"))).toBe(true);
		expect(progressLines.some((line) => line.includes("→ event-8"))).toBe(true);
		expect(progressLines.at(-1)).toContain("... (");
		expect(progressLines.at(-1)).toContain("more lines");
		expect(progressLines.at(-1)).toContain("to expand");
		for (const line of [...callLines, ...progressLines]) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(96);
		}
	});

	test("colors participant labels and statuses without coloring whole progress rows", () => {
		// Purpose: A/B identity colors must stay separate from semantic status and retry colors.
		// Input and expected output: A and B labels use different theme colors, while DIFF keeps warning semantics.
		// Edge case: answer previews stay dim instead of inheriting participant or status colors.
		// Dependencies: public renderer functions and theme color callbacks.
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "running" }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Question",
				status: "running",
				phase: "A reviews B",
				elapsedMs: 1_000,
				iteration: 1,
				iterationLimit: 3,
				participants: [
					{
						label: "A",
						participantId: "llm1",
						modelId: "z-ai/glm-5.1",
						thinking: "high",
						display: "z-ai/glm-5.1/high",
					},
					{
						label: "B",
						participantId: "llm2",
						modelId: "openai-codex/gpt-5.5",
						thinking: "xhigh",
						display: "openai-codex/gpt-5.5/xhigh",
					},
				],
				events: [
					{
						kind: "response",
						title: "A DIFF",
						text: "PostgreSQL fits core storage, but search needs analysis.",
						timestampMs: 1,
					},
					{
						kind: "retry",
						title: "B provider retry 1/4",
						text: undefined,
						timestampMs: 2,
					},
				],
				omittedEventCount: 0,
			},
		};

		const rendered = renderConveneCouncilResult(
			result,
			{ expanded: false },
			colorTheme,
			{ isError: false },
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("<accent>A</accent> <warning>DIFF</warning>");
		expect(rendered).toContain(
			"<toolOutput>B</toolOutput> <warning>provider retry 1/4</warning>",
		);
		expect(rendered).toContain("<dim>PostgreSQL fits core storage");
		expect(rendered).not.toContain("<accent>A DIFF</accent>");
		expect(rendered).not.toContain(
			"<toolOutput>B provider retry 1/4</toolOutput>",
		);
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
