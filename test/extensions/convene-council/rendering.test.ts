import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
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

/** Returns the visual column where a marker starts in a rendered line. */
function visualColumnOf(line: string, marker: string): number {
	const index = line.indexOf(marker);
	expect(index).toBeGreaterThanOrEqual(0);
	return visibleWidth(line.slice(0, index));
}

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

		expect(callLines.length).toBeGreaterThan(1);
		expect(callLines[0]).toStartWith("convene_council:");
		for (const line of [...callLines, ...resultLines]) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("counts wrapped call question rows against the call preview line budget", () => {
		// Purpose: convene_council call rendering must not let a huge wrapped question consume unbounded TUI height.
		// Input and expected output: a huge question is capped when collapsed and shows the standard hidden-line hint.
		// Edge case: the final token is beyond the collapsed line budget.
		// Dependencies: public renderer function and pi-tui visible-width measurement.
		const question = Array.from(
			{ length: 80 },
			(_, index) => `question-token-${index}`,
		).join(" ");

		const collapsedLines = renderConveneCouncilCall({ question }, theme, {
			expanded: false,
		} as never).render(48);
		const expandedLines = renderConveneCouncilCall({ question }, theme, {
			expanded: true,
		} as never).render(48);
		const collapsed = collapsedLines.join("\n");

		expect(collapsedLines).toHaveLength(4);
		expect(collapsed).toContain("convene_council:");
		expect(collapsed).toContain("more lines");
		expect(collapsed).toContain("total");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("question-token-79");
		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
		expect(expandedLines.join("")).toContain("question-token-79");
		expect(expandedLines.join("\n")).not.toContain("more lines");
		for (const line of [...collapsedLines, ...expandedLines]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(48);
		}
	});

	test("renders collapsed call question hint with segmented colors", () => {
		// Purpose: convene_council call hidden-line hint must use the same color segmentation as result hints.
		// Input and expected output: a huge question produces muted count text, dim keybinding text, and muted suffix.
		// Edge case: keybinding text may be empty in tests, but the dim segment must still be present.
		// Dependencies: public renderer function and theme color callbacks.
		const question = Array.from(
			{ length: 80 },
			(_, index) => `question-token-${index}`,
		).join(" ");

		const rendered = renderConveneCouncilCall({ question }, colorTheme, {
			expanded: false,
		} as never)
			.render(200)
			.join("\n");

		expect(rendered).toContain("<muted>... (");
		expect(rendered).toContain("more lines, ");
		expect(rendered).toContain("total, </muted><dim>");
		expect(rendered).toContain("</dim><muted> to expand)</muted>");
	});

	test("counts wrapped persisted call question rows against the call preview line budget", () => {
		// Purpose: persisted council call headers must not clip or lose the question after progress details exist.
		// Input and expected output: the question row is capped when collapsed and fully visible when expanded.
		// Edge case: header and participant rows remain present around the wrapped question block.
		// Dependencies: public renderer function and a persisted headerDetails state object.
		const question = Array.from(
			{ length: 80 },
			(_, index) => `question-token-${index}`,
		).join(" ");
		const headerDetails = {
			type: "convene_council_progress",
			runId: "call-council",
			question,
			status: "running",
			phase: "review",
			elapsedMs: 1_000,
			iteration: 1,
			iterationLimit: 3,
			participants: [
				{
					label: "A",
					displayName: "Socrates",
					participantId: "llm1",
					modelId: "openai/model-a",
					thinking: "medium",
					display: "openai/model-a/medium",
					contextWindow: 272_000,
					status: "running",
					elapsedMs: 1_000,
					activity: "thinking",
				},
			],
			events: [],
			omittedEventCount: 0,
		};

		const collapsedLines = renderConveneCouncilCall({ question }, theme, {
			state: { headerDetails },
			expanded: false,
		} as never).render(64);
		const expandedLines = renderConveneCouncilCall({ question }, theme, {
			state: { headerDetails },
			expanded: true,
		} as never).render(64);
		const collapsed = collapsedLines.join("\n");

		expect(collapsed).toContain("convene_council · review");
		expect(collapsed).toContain("Question:");
		expect(collapsed).toContain("more lines");
		expect(collapsed).toContain("total");
		expect(collapsed).toContain("to expand");
		expect(collapsed).toContain("Socrates");
		expect(collapsed).not.toContain("question-token-79");
		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
		expect(expandedLines.join("")).toContain("question-token-79");
		expect(expandedLines.join("\n")).not.toContain("more lines");
		for (const line of [...collapsedLines, ...expandedLines]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		}
	});

	test("renders persisted participant rows and answer preview after success", () => {
		// Purpose: completed council progress must keep stable participant rows instead of reverting to answer-only output.
		// Input and expected output: final details carry two named participant rows followed by a bounded answer preview.
		// Edge case: answer text is long enough that the preview must stay within the component width.
		// Dependencies: public renderer functions and persisted tool-result details.
		const result: AgentToolResult<unknown> = {
			content: [
				{
					type: "text",
					text: "Use PostgreSQL as the source of truth and add search-specific indexes after measuring filter latency.",
				},
			],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Which storage should we use?",
				status: "succeeded",
				phase: "agreed",
				elapsedMs: 82_800,
				iteration: 2,
				iterationLimit: 10,
				participants: [
					{
						label: "A",
						displayName: "Socrates",
						participantId: "llm1",
						modelId: "openai-codex/gpt-5.5",
						thinking: "high",
						display: "openai-codex/gpt-5.5/high",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 82_800,
						activity: "AGREE PostgreSQL fits core storage.",
						contextUsage: {
							tokens: 120_000,
							contextWindow: 272_000,
							percent: 44.1,
						},
					},
					{
						label: "B",
						displayName: "Confucius",
						participantId: "llm2",
						modelId: "anthropic/claude-sonnet-4-5",
						thinking: "medium",
						display: "anthropic/claude-sonnet-4-5/medium",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 79_100,
						activity: "final answer accepted",
						contextUsage: {
							tokens: 98_000,
							contextWindow: 272_000,
							percent: 36.1,
						},
					},
				],
				events: [],
				omittedEventCount: 0,
			},
		};

		const rendererState = {};
		const lines = renderConveneCouncilResult(
			result,
			{ expanded: false },
			theme,
			{ isError: false, state: rendererState },
		).render(96);
		const callLines = renderConveneCouncilCall(
			{ question: "Which storage should we use?" },
			theme,
			{ state: rendererState },
		).render(96);
		const rendered = lines.join("\n");
		const callRendered = callLines.join("\n");

		expect(callRendered).toContain(
			"convene_council · agreed · iter 2/10 · 82.8s",
		);
		expect(rendered).not.toContain("convene_council");
		expect(rendered).toContain("✓ Socrates");
		expect(rendered).toContain(
			"82.8s · 120k/272k · AGREE PostgreSQL fits core storage.",
		);
		expect(rendered).toContain(
			"✓ Confucius 79.1s · 98k/272k · final answer accepted",
		);
		expect(rendered).toContain(
			"Council: Use PostgreSQL as the source of truth",
		);
		expect(rendered).not.toContain("(no progress events)");
		for (const line of lines) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(96);
		}
	});

	test("renders failure rows with subagent status indicator colors", () => {
		// Purpose: failed and aborted council participants must keep final rows with the same indicator colors as subagents.
		// Input and expected output: aborted and failed participants use error-colored square and cross icons.
		// Edge case: missing context usage is omitted instead of being fabricated as zero.
		// Dependencies: public renderer functions and theme color callbacks.
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "operation was aborted" }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Question",
				status: "failed",
				phase: "failed",
				elapsedMs: 32_000,
				iteration: 1,
				iterationLimit: 10,
				participants: [
					{
						label: "A",
						displayName: "Socrates",
						participantId: "llm1",
						modelId: "openai/model-a",
						thinking: "medium",
						display: "openai/model-a/medium",
						contextWindow: 272_000,
						status: "aborted",
						elapsedMs: 32_000,
						activity: "assistant This operation was aborted",
					},
					{
						label: "B",
						displayName: "Confucius",
						participantId: "llm2",
						modelId: "openai/model-b",
						thinking: "medium",
						display: "openai/model-b/medium",
						contextWindow: 272_000,
						status: "failed",
						elapsedMs: 32_000,
						activity: "assistant provider error",
					},
				],
				events: [],
				omittedEventCount: 0,
			},
		};

		const rendered = renderConveneCouncilResult(
			result,
			{ expanded: false },
			colorTheme,
			{ isError: true },
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("<error>■</error> Socrates");
		expect(rendered).toContain("assistant This operation was aborted");
		expect(rendered).toContain("<error>✗</error> Confucius");
		expect(rendered).toContain("assistant provider error");
		expect(rendered).toContain("<error>Error:</error>");
		expect(rendered).toContain("operation was aborted");
		expect(rendered).not.toContain("0/272k");
	});

	test("colors running and succeeded indicators and context pressure like subagents", () => {
		// Purpose: council participant rows must use subagent indicator colors and context pressure colors.
		// Input and expected output: running uses accent, succeeded uses success, warning and error context values are colored.
		// Edge case: participant names replace A/B labels without coloring the whole row.
		// Dependencies: public renderer functions and theme color callbacks.
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "running" }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Question",
				status: "running",
				phase: "B reviews Socrates",
				elapsedMs: 1_000,
				iteration: 1,
				iterationLimit: 3,
				participants: [
					{
						label: "A",
						displayName: "Socrates",
						participantId: "llm1",
						modelId: "z-ai/glm-5.1",
						thinking: "high",
						display: "z-ai/glm-5.1/high",
						contextWindow: 272_000,
						status: "running",
						elapsedMs: 1_000,
						activity: 'read {"path":"plan.md"}',
						contextUsage: {
							tokens: 140_000,
							contextWindow: 272_000,
							percent: 51.5,
						},
					},
					{
						label: "B",
						displayName: "Confucius",
						participantId: "llm2",
						modelId: "openai-codex/gpt-5.5",
						thinking: "xhigh",
						display: "openai-codex/gpt-5.5/xhigh",
						contextWindow: 272_000,
						status: "running",
						elapsedMs: 900,
						activity: "AGREE PostgreSQL fits core storage.",
						contextUsage: {
							tokens: 220_000,
							contextWindow: 272_000,
							percent: 80.9,
						},
					},
				],
				events: [],
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

		expect(rendered).toContain("<accent>⏳</accent> Socrates");
		expect(rendered).toContain("<warning>140k/272k</warning> · read");
		expect(rendered).toContain("<accent>⏳</accent> Confucius");
		expect(rendered).toContain("<error>220k/272k</error> · AGREE");
		expect(rendered).not.toContain("<accent>Socrates");
		expect(rendered).not.toContain("<success>Confucius");
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

	test("aligns participant row details after the widest current name", () => {
		// Purpose: participant row details must start in the same visual column when display names have different widths.
		// Input and expected output: `Plato` and `Marcus Aurelius` rows align their elapsed-time segment.
		// Edge case: the wider name contains a space and must use visible terminal width.
		// Dependencies: public renderer function and Pi visible-width utility.
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "running" }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Question",
				status: "running",
				phase: "review",
				elapsedMs: 32_400,
				iteration: 2,
				iterationLimit: 10,
				participants: [
					{
						label: "A",
						displayName: "Plato",
						participantId: "llm1",
						modelId: "openai/model-a",
						thinking: "medium",
						display: "openai/model-a/medium",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 32_400,
						activity: "AGREE",
					},
					{
						label: "B",
						displayName: "Marcus Aurelius",
						participantId: "llm2",
						modelId: "openai/model-b",
						thinking: "medium",
						display: "openai/model-b/medium",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 32_400,
						activity: "final answer accepted",
					},
				],
				events: [],
				omittedEventCount: 0,
			},
		};

		const lines = renderConveneCouncilResult(
			result,
			{ expanded: false },
			theme,
			{ isError: false },
		).render(96);
		const platoRow = lines.find((line) => line.includes("Plato"));
		const marcusRow = lines.find((line) => line.includes("Marcus Aurelius"));

		expect(platoRow).toBeDefined();
		expect(marcusRow).toBeDefined();
		expect(visualColumnOf(platoRow ?? "", "32.4s")).toBe(
			visualColumnOf(marcusRow ?? "", "32.4s"),
		);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(96);
		}
	});

	test("wraps persisted final answer preview below participant rows", () => {
		// Purpose: persisted council details must keep participant rows while preserving the wrapped answer preview and expand hint.
		// Input and expected output: a long final answer wraps below rows instead of being clipped as one fixed line.
		// Edge case: the collapsed result must remain bounded and each line must fit the component width.
		// Dependencies: public renderer function and persisted council progress details.
		const answer = [
			"First sentence explains the recommended storage direction with enough words to wrap.",
			"Second sentence adds operational constraints and migration details for the same recommendation.",
			"Third sentence contains the final caveat that must be available after expanding.",
		].join(" ");
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: answer }],
			details: {
				type: "convene_council_progress",
				runId: "call-council",
				question: "Question",
				status: "succeeded",
				phase: "agreed",
				elapsedMs: 1_000,
				iteration: 1,
				iterationLimit: 3,
				participants: [
					{
						label: "A",
						displayName: "Socrates",
						participantId: "llm1",
						modelId: "openai/model-a",
						thinking: "medium",
						display: "openai/model-a/medium",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 1_000,
						activity: "AGREE",
					},
					{
						label: "B",
						displayName: "Confucius",
						participantId: "llm2",
						modelId: "openai/model-b",
						thinking: "medium",
						display: "openai/model-b/medium",
						contextWindow: 272_000,
						status: "succeeded",
						elapsedMs: 1_000,
						activity: "final answer accepted",
					},
				],
				events: [],
				omittedEventCount: 0,
			},
		};

		const lines = renderConveneCouncilResult(
			result,
			{ expanded: false },
			theme,
			{ isError: false },
		).render(54);
		const rendered = lines.join("\n");

		expect(rendered).toContain("✓ Socrates");
		expect(rendered).toContain("✓ Confucius");
		expect(rendered).toContain("Council:");
		expect(rendered).toContain("First sentence explains");
		expect(rendered).toContain("sentence adds operational constraints");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("to expand");
		expect(lines.length).toBeLessThanOrEqual(6);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(54);
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
