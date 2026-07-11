import { describe, expect, test } from "bun:test";
import {
	createSubagentProgressState,
	recordSubagentSessionEvent,
	toSubagentRunDetails,
} from "./progress";
import {
	createSubagentWidgetFactory,
	createSubagentWidgetState,
	recordSubagentWidgetRun,
	resetSubagentWidgetState,
} from "./widget";

const MAX_EXPECTED_STORED_PROGRESS_TEXT_LENGTH = 240;
const ZERO_WIDTH_STRESS_COUNT = 10_000;

describe("run-subagent progress", () => {
	test("propagates taskName and rejects unnamed nested runs", () => {
		// Purpose: semantic run identity must survive snapshots and remain mandatory at nested RPC boundaries.
		// Input and expected output: a named root retains its taskName, while nested details without taskName are ignored.
		// Edge case: the unnamed nested payload otherwise has a complete valid progress shape.
		// Dependencies: progress snapshots and nested tool updates share SubagentRunDetails validation.
		const state = createSubagentProgressState({
			runId: "root",
			agentId: "SubAgentSage",
			taskName: "Trace TUI redraws",
			depth: 1,
			startedAtMs: 0,
		} as Parameters<typeof createSubagentProgressState>[0]);
		const unnamedNestedDetails = {
			runId: "nested",
			agentId: "SubAgentExtractor",
			depth: 2,
			runtime: undefined,
			contextUsage: undefined,
			contextProjectionStatus: undefined,
			status: "running",
			elapsedMs: 10,
			exitCode: undefined,
			finalOutput: "",
			stderr: "",
			stopReason: undefined,
			errorMessage: undefined,
			events: [],
			omittedEventCount: 0,
			children: [],
		};

		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_update",
				toolName: "run_subagent",
				partialResult: { details: unnamedNestedDetails },
			},
			10,
		);
		const details = toSubagentRunDetails(state, "running", 10) as unknown as {
			readonly taskName?: string;
			readonly children: readonly unknown[];
		};

		expect(details.taskName).toBe("Trace TUI redraws");
		expect(details.children).toEqual([]);
	});

	test("resets widget identity and pin state for a new session", () => {
		// Purpose: run numbering and explicit selection must not leak across Pi sessions.
		// Input and expected output: a recorded pinned run is followed by reset, leaving roots, pin, and numbering maps empty.
		// Edge case: both per-run and per-agent numbering structures contain assigned values.
		// Dependencies: widget recording assigns identity before the session lifecycle clears it.
		const progress = createSubagentProgressState({
			runId: "root",
			agentId: "SubAgentSage",
			taskName: "Inspect session reset",
			depth: 1,
			startedAtMs: 0,
		});
		const state = createSubagentWidgetState();
		recordSubagentWidgetRun(
			state,
			toSubagentRunDetails(progress, "running", 10),
			10,
		);
		state.pinnedRunId = "root";

		resetSubagentWidgetState(state);

		expect(state.roots).toEqual([]);
		expect(state.pinnedRunId).toBeUndefined();
		expect(state.instanceNumberByRunId.size).toBe(0);
		expect(state.instanceCountByAgentId.size).toBe(0);
	});

	test("preserves tool call IDs across interleaved same-name events", () => {
		// Purpose: widget activity must have a stable ownership key for parallel calls to one tool.
		// Input and expected output: grep A and grep B start before grep A completes, retaining three matching IDs.
		// Edge case: completion order differs from start order, so tool title cannot identify ownership.
		// Dependencies: child Pi RPC events expose toolCallId on start and end events.
		const state = createSubagentProgressState({
			runId: "root",
			agentId: "SubAgentSage",
			taskName: "Correlate tool calls",
			depth: 1,
			startedAtMs: 0,
		});
		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_start",
				toolName: "grep",
				toolCallId: "grep-a",
				args: { pattern: "A.ts" },
			},
			10,
		);
		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_start",
				toolName: "grep",
				toolCallId: "grep-b",
				args: { pattern: "B.ts" },
			},
			11,
		);
		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_end",
				toolName: "grep",
				toolCallId: "grep-a",
				result: { content: [{ type: "text", text: "No matches found" }] },
			},
			12,
		);

		expect(state.events.map((event) => event.toolCallId)).toEqual([
			"grep-a",
			"grep-b",
			"grep-a",
		]);
	});

	test("preserves valid Unicode through live progress capture and widget rendering", () => {
		// Purpose: the real child-event path must retain serialized arguments and valid Unicode before width clipping.
		// Input and expected output: a read call shows its full JSON with Unicode spaces, composed text, ZWJ, RTL, and BiDi isolates.
		// Edge case: a line break remains visible as a safe JSON escape instead of creating another terminal row.
		// Dependencies: progress capture serializes tool arguments before the public widget factory renders them.
		const state = createSubagentProgressState({
			runId: "unicode",
			agentId: "SubAgentSage",
			taskName: "Preserve Unicode progress",
			depth: 1,
			startedAtMs: 0,
		});
		const path = "A\u00a0B\u2003C\u202fD/👩🏽‍💻é\n\u2067עברית\u2069";
		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_start",
				toolName: "read",
				toolCallId: "unicode-read",
				args: { path },
			},
			10,
		);
		const widgetState = createSubagentWidgetState();
		recordSubagentWidgetRun(
			widgetState,
			toSubagentRunDetails(state, "running", 10),
			10,
		);
		const rendered = createSubagentWidgetFactory(widgetState, 2)()
			.render(160)
			.join("\n");

		expect(rendered).toContain(
			'read {"path":"A\u00a0B\u2003C\u202fD/👩🏽‍💻é\\n\u2067עברית\u2069"}',
		);
	});

	test("keeps zero-width-heavy progress text within the storage bound", () => {
		// Purpose: retained progress history must stay finite independently of terminal display width.
		// Input and expected output: one visible path character followed by ten thousand valid BiDi controls is truncated with an ellipsis.
		// Edge case: zero-width characters cannot bypass a code-unit storage limit even though they remain valid Unicode.
		// Dependencies: the public child-event boundary stores normalized tool arguments before widget snapshots clone them.
		const state = createSubagentProgressState({
			runId: "bounded",
			agentId: "SubAgentSage",
			taskName: "Bound progress storage",
			depth: 1,
			startedAtMs: 0,
		});
		recordSubagentSessionEvent(
			state,
			{
				type: "tool_execution_start",
				toolName: "read",
				toolCallId: "bounded-read",
				args: { path: `A${"\u2067".repeat(ZERO_WIDTH_STRESS_COUNT)}` },
			},
			10,
		);
		const storedText = state.events.at(-1)?.text;

		expect(storedText).toBeDefined();
		expect(storedText?.length).toBeLessThanOrEqual(
			MAX_EXPECTED_STORED_PROGRESS_TEXT_LENGTH,
		);
		expect(storedText).toEndWith("…");
	});
});
