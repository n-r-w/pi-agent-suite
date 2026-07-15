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
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "root-session",
		});
		const unnamedNestedDetails = {
			formatVersion: 1,
			runId: "nested",
			agentId: "SubAgentExtractor",
			sessionId: 1,
			depth: 2,
			runtime: undefined,
			contextUsage: undefined,
			contextProjectionStatus: undefined,
			isResume: false,
			childSessionId: "nested-session",
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

	test("accepts resumed identity through the nested RPC boundary", () => {
		// Purpose: a parent widget must retain continuation metadata streamed by a nested subagent tool call.
		// Input and expected output: valid resumed child details survive validation, cloning, and widget rendering with ⇆ and #3.
		// Edge case: the nested run uses a local session number independent of its parent runId.
		// Dependencies: tool_execution_update uses the same runtime validator as nested final tool results.
		const state = createSubagentProgressState({
			runId: "root",
			agentId: "SubAgentSage",
			taskName: "Review nested progress",
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "root-session",
		});
		const nestedDetails = {
			formatVersion: 1,
			runId: "nested-resume",
			agentId: "SubAgentExtractor",
			taskName: "Continue nested extraction",
			sessionId: 3,
			isResume: true,
			depth: 2,
			runtime: undefined,
			childSessionId: "019f0000-0000-7000-8000-000000000003",
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
				toolName: "resume_subagent",
				partialResult: { details: nestedDetails },
			},
			10,
		);
		const details = toSubagentRunDetails(state, "running", 10);
		const widgetState = createSubagentWidgetState();
		recordSubagentWidgetRun(widgetState, details, 10);
		const rendered = createSubagentWidgetFactory(widgetState, 3)()
			.render(120)
			.join("\n");

		expect(details.children[0]).toMatchObject({
			runId: "nested-resume",
			sessionId: 3,
			isResume: true,
			childSessionId: "019f0000-0000-7000-8000-000000000003",
		});
		expect(rendered).toContain("⇆ Extractor #3 · Continue nested extraction");
	});

	test("preserves resumed session identity through progress and widget snapshots", () => {
		// Purpose: presentation layers must distinguish a resumed invocation while retaining its stable child-session relationship.
		// Input and expected output: resumed progress produces isResume true and the same childSessionId in details and the widget node.
		// Edge case: runId remains invocation-specific and is not replaced by childSessionId.
		// Dependencies: progress snapshots feed widget conversion without another identity lookup.
		const state = createSubagentProgressState({
			runId: "resume-run",
			agentId: "SubAgentSage",
			taskName: "Continue TUI analysis",
			depth: 1,
			startedAtMs: 0,
			sessionId: 2,
			childSessionId: "019f0000-0000-7000-8000-000000000001",
			isResume: true,
		});
		const details = toSubagentRunDetails(state, "running", 10);
		const widgetState = createSubagentWidgetState();
		recordSubagentWidgetRun(widgetState, details, 10);
		const widgetNode = widgetState.roots[0];

		expect(details).toMatchObject({
			runId: "resume-run",
			sessionId: 2,
			childSessionId: "019f0000-0000-7000-8000-000000000001",
			isResume: true,
		});
		expect(widgetNode).toMatchObject({
			runId: "resume-run",
			sessionId: 2,
			isResume: true,
		});
	});

	test("resets widget sessions and pin state for a new main session", () => {
		// Purpose: recorded widget sessions and explicit selection must not leak across main sessions.
		// Input and expected output: a recorded pinned session is followed by reset, leaving roots and pin state empty.
		// Edge case: the reset follows a fully recorded widget node.
		// Dependencies: widget recording stores invocation state before the session lifecycle clears it.
		const progress = createSubagentProgressState({
			runId: "root",
			agentId: "SubAgentSage",
			taskName: "Inspect session reset",
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "root-session",
		});
		const state = createSubagentWidgetState();
		recordSubagentWidgetRun(
			state,
			toSubagentRunDetails(progress, "running", 10),
			10,
		);
		state.pinnedChildSessionId = "root-session";

		resetSubagentWidgetState(state);

		expect(state.roots).toEqual([]);
		expect(state.pinnedChildSessionId).toBeUndefined();
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
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "root-session",
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
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "unicode-session",
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
			sessionId: 1,
			isResume: false,
			depth: 1,
			startedAtMs: 0,
			childSessionId: "bounded-session",
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
