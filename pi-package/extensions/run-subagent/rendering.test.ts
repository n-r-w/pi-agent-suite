import { afterEach, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type KeybindingDefinitions,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentRunDetails, SubagentRunStatus } from "./progress.ts";
import { renderRunSubagentCall, renderRunSubagentResult } from "./rendering.ts";

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

/** Creates final details with retained progress that historical rendering must ignore. */
function createDetails(status: SubagentRunStatus): SubagentRunDetails {
	return {
		runId: "run-1",
		agentId: "SubAgentSage",
		taskName: "Design widget navigation",
		depth: 1,
		runtime: undefined,
		contextUsage: undefined,
		contextProjectionStatus: undefined,
		status,
		elapsedMs: 1000,
		exitCode: status === "succeeded" ? 0 : 1,
		finalOutput: status === "succeeded" ? "Final answer" : "",
		stderr: "retained child diagnostic",
		stopReason: undefined,
		errorMessage: status === "failed" ? "Child failed" : undefined,
		events: [
			{
				kind: "assistant",
				title: "intermediate activity",
				text: undefined,
				timestampMs: 1,
			},
		],
		omittedEventCount: 2,
		children: [],
	};
}

/** Renders a final result through the same state-sharing context as Pi tool components. */
function renderResult(
	status: SubagentRunStatus,
	expanded: boolean,
	content = status === "succeeded" ? "Final answer" : "Child failed",
): string[] {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: content }],
		details: createDetails(status),
	};
	return renderRunSubagentResult(
		result,
		{ expanded },
		plainTheme as never,
		{
			args: {
				agentId: "SubAgentSage",
				taskName: "Design widget navigation",
				prompt: "Design a navigable widget.",
			},
			state: {},
			invalidate(): void {},
		} as never,
	).render(WIDTH);
}

describe("run-subagent rendering", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	test("keeps collapsed history empty and renders only the final expanded result", () => {
		// Purpose: historical tool results must stay compact while retaining the task and final answer on demand.
		// Input and expected output: succeeded details with retained events and stderr render no collapsed rows, while expansion renders prompt and final answer sections.
		// Edge case: retained intermediate diagnostics must not become independent expanded sections.
		// Dependencies: the renderer receives final AgentToolResult content and shared render state.
		const collapsed = renderResult("succeeded", false);
		const expanded = renderResult("succeeded", true).join("\n");

		expect(collapsed).toEqual([]);
		expect(expanded).toContain("Prompt");
		expect(expanded).toContain("Design a navigable widget.");
		expect(expanded).toContain("Final output");
		expect(expanded).toContain("Final answer");
		expect(expanded).not.toContain("Progress");
		expect(expanded).not.toContain("intermediate activity");
		expect(expanded).not.toContain("retained child diagnostic");
	});

	test("renders a final failure message without a progress timeline", () => {
		// Purpose: failed runs must expose their terminal result even when no final assistant output exists.
		// Input and expected output: failed details render the AgentToolResult error text under the final output section.
		// Edge case: details contain retained stderr and progress events that are not the selected terminal result.
		// Dependencies: errorResult content is the final user-visible failure message.
		const expanded = renderResult("failed", true).join("\n");

		expect(expanded).toContain("Final output");
		expect(expanded).toContain("Child failed");
		expect(expanded).not.toContain("Progress");
	});

	test("shows the semantic name before the wrapped task preview", () => {
		// Purpose: historical calls must distinguish the semantic run name from the full delegated prompt.
		// Input and expected output: taskName renders on a Name row before the wrapped Task rows.
		// Edge case: every row remains within the default Pi tool-shell child width.
		// Dependencies: renderCall receives the validated public tool arguments.
		const renderedLines = renderRunSubagentCall(
			{
				agentId: "SubAgentSage",
				taskName: "Design widget navigation",
				prompt:
					"Analyze the design issue in the active tool renderer and explain the smallest safe fix that preserves collapsed previews.",
			},
			plainTheme as never,
			{},
		).render(WIDTH);

		expect(renderedLines.length).toBeGreaterThan(3);
		expect(renderedLines[1]).toContain("Name:");
		expect(renderedLines[1]).toContain("Design widget navigation");
		expect(renderedLines[2]).toContain("Task:");
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("uses muted values with bold Name and Task labels", () => {
		// Purpose: historical call metadata must separate labels from long values without muting the runtime model.
		// Input and expected output: name and task values use muted text while only Name and Task labels are bold.
		// Edge case: partial runtime state omits final context and elapsed segments.
		// Dependencies: marker tags expose color and bold styling without relying on a terminal theme.
		const rendered = renderRunSubagentCall(
			{
				agentId: "SubAgentSage",
				taskName: "Verify panel requirements",
				prompt: "Review the implemented panel behavior.",
			},
			markerTheme as never,
			{
				state: {
					headerDetails: {
						agentId: "SubAgentSage",
						runtime: {
							modelId: "openai-codex/gpt-5.6-sol",
							thinking: "high",
							contextWindow: 372_000,
						},
						contextUsage: undefined,
						contextProjectionStatus: undefined,
						elapsedMs: undefined,
					},
				},
			} as never,
		).render(WIDTH);

		expect(rendered[0]).toContain("openai-codex/gpt-5.6-sol/high");
		expect(rendered[0]).not.toContain(
			"<muted>openai-codex/gpt-5.6-sol/high</muted>",
		);
		expect(rendered[1]).toBe(
			"<bold>Name:</bold><muted> Verify panel requirements</muted>",
		);
		expect(rendered[2]).toBe(
			"<bold>Task:</bold><muted> Review the implemented panel behavior.</muted>",
		);
	});

	test("limits collapsed task rows and colors the hidden-line hint by segment", () => {
		setKeybindings(new KeybindingsManager(keybindingsWithToolExpansion));
		const args = {
			agentId: "SubAgentSage",
			taskName: "Inspect collapsed preview",
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

		expect(renderedLines).toHaveLength(6);
		expect(coloredLines.at(-1)).toBe(HIDDEN_LINE_HINT);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("shows all wrapped task rows when the tool call is expanded", () => {
		const args = {
			agentId: "SubAgentSage",
			taskName: "Inspect expanded preview",
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
