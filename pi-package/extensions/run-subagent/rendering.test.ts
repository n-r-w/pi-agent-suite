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
import {
	renderResumeSubagentCall,
	renderRunSubagentCall,
	renderRunSubagentResult,
} from "./rendering.ts";

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
		formatVersion: 1,
		runId: "run-1",
		childSessionId: "session-1",
		agentId: "SubAgentSage",
		taskName: "Design widget navigation",
		sessionId: 1,
		depth: 1,
		runtime: undefined,
		contextUsage: undefined,
		contextProjectionStatus: undefined,
		isResume: false,
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

	test("renders resume tool identity before and after runtime resolution", () => {
		// Purpose: the dedicated resume tool name must carry continuation semantics without a second marker.
		// Input and expected output: a known session immediately renders its persisted agent, while resolved details add runtime, context, and elapsed time.
		// Edge case: an unknown session renders its number without an agent placeholder, and a long runtime preserves the number within component width.
		// Dependencies: registration resolves the initial agent from the session registry before partial updates arrive.
		const args = {
			resumeSession: 7,
			taskName: "Continue widget analysis",
			prompt: "Continue the analysis.",
		};
		const immediate = renderResumeSubagentCall(
			args,
			plainTheme as never,
			{},
			"SubAgentSage",
		).render(WIDTH)[0];
		const unknown = renderResumeSubagentCall(
			{ ...args, resumeSession: 404 },
			plainTheme as never,
			{},
			undefined,
		).render(WIDTH)[0];
		const resolvedContext = {
			state: {
				headerDetails: {
					agentId: "SubAgentSage",
					sessionId: 7,
					runtime: {
						modelId: "openai-codex/gpt-5.6-sol",
						thinking: "medium",
						contextWindow: 372_000,
					},
					contextUsage: {
						tokens: 43_000,
						contextWindow: 372_000,
						percent: 11.56,
					},
					contextProjectionStatus: undefined,
					elapsedMs: 16_000,
				},
			},
		};
		const resolved = renderResumeSubagentCall(
			args,
			plainTheme as never,
			resolvedContext,
			"SubAgentSage",
		).render(120)[0];
		const narrowContext = {
			state: {
				headerDetails: {
					...resolvedContext.state.headerDetails,
					agentId: "SubAgentWithAnExtremelyLongIdentifier",
					runtime: {
						...resolvedContext.state.headerDetails.runtime,
						modelId: "openai-codex/gpt-5.6-sol-with-long-name",
					},
				},
			},
		};
		const narrow = renderResumeSubagentCall(
			args,
			plainTheme as never,
			narrowContext,
			"SubAgentSage",
		).render(42)[0];

		expect(immediate).toBe("resume_subagent SubAgentSage · #7");
		expect(unknown).toBe("resume_subagent · #404");
		expect(resolved).toContain(
			"resume_subagent SubAgentSage · openai-codex/gpt-5.6-sol/medium · #7 · 43k/372k · 16.0s",
		);
		expect(narrow).toContain("#7");
		expect(visibleWidth(narrow ?? "")).toBeLessThanOrEqual(42);
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
						sessionId: 1,
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

	test("shows the prompt preview only when the tool call is collapsed", () => {
		// Purpose: expansion must replace the compact task preview with the formatted prompt instead of duplicating it.
		// Input and expected output: the collapsed call contains Task and the prompt, while the combined expanded view contains the prompt once in the result.
		// Edge case: the expanded call must retain its tool and Name rows without retaining any task preview text.
		// Dependencies: Pi renders the call and result components together with the same expansion state.
		const prompt = "Design a navigable widget.";
		const args = {
			agentId: "SubAgentSage",
			taskName: "Design widget navigation",
			prompt,
		};
		const collapsedCall = renderRunSubagentCall(
			args,
			plainTheme as never,
			{},
		).render(WIDTH);
		const expandedCall = renderRunSubagentCall(
			args,
			plainTheme as never,
			{ expanded: true } as never,
		).render(WIDTH);
		const expandedView = [
			...expandedCall,
			...renderResult("succeeded", true),
		].join("\n");

		expect(collapsedCall.join("\n")).toContain(`Task: ${prompt}`);
		expect(expandedCall.join("\n")).not.toContain("Task:");
		expect(expandedCall.join("\n")).not.toContain(prompt);
		expect(expandedView.split(prompt)).toHaveLength(2);
		for (const line of expandedCall) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});
});
