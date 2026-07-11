import { afterEach, describe, expect, test } from "bun:test";
import {
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { SubagentRunDetails } from "./progress";
import { createSubagentWidgetState, recordSubagentWidgetRun } from "./widget";
import {
	AUTOMATIC_SUBAGENT_VIEW,
	createSubagentBrowserController,
	createSubagentBrowserItems,
	SubagentBrowserList,
} from "./widget-browser";

/** Standard terminal sequence matched by the SelectList Down binding. */
const DOWN = "\u001b[B";
/** Standard terminal sequence matched by the SelectList confirmation binding. */
const ENTER = "\r";

/** Leaves style markers out of behavior-focused browser assertions. */
const plainTheme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

/** Creates one recursive run snapshot for browser ordering and refresh tests. */
function createRun(
	runId: string,
	taskName: string,
	children: readonly SubagentRunDetails[] = [],
): SubagentRunDetails {
	return {
		runId,
		agentId: "SubAgentSage",
		taskName,
		depth: 1,
		runtime: undefined,
		contextUsage: undefined,
		contextProjectionStatus: undefined,
		status: "running",
		elapsedMs: 1000,
		exitCode: undefined,
		finalOutput: "",
		stderr: "",
		stopReason: undefined,
		errorMessage: undefined,
		events: [],
		omittedEventCount: 0,
		children,
	};
}

/** Records roots in creation order so the presentation registry owns numbering. */
function createState(roots: readonly SubagentRunDetails[]) {
	const state = createSubagentWidgetState();
	for (const [index, root] of roots.entries()) {
		recordSubagentWidgetRun(state, root, index + 1);
	}
	return state;
}

describe("subagent widget browser", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	test("pins the selected run and redraws the widget", async () => {
		// Purpose: a browser selection must become the persistent widget view immediately.
		// Input and expected output: two Down inputs select run-2, Enter pins it, and setWidget receives a refreshed factory.
		// Edge case: Automatic view occupies the first SelectList item.
		// Dependencies: ctx.ui.custom supplies focus and completion while the controller owns pin state.
		const state = createState([
			createRun("run-1", "Inspect first area"),
			createRun("run-2", "Inspect second area"),
		]);
		const widgetUpdates: unknown[] = [];
		let renderRequests = 0;
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				async custom(
					factory: (
						tui: { requestRender(): void },
						theme: typeof plainTheme,
						keybindings: unknown,
						done: (result: unknown) => void,
					) => {
						handleInput(data: string): void;
					},
				): Promise<unknown> {
					return new Promise((resolve) => {
						const component = factory(
							{
								requestRender(): void {
									renderRequests += 1;
								},
							},
							plainTheme,
							undefined,
							resolve,
						);
						component.handleInput(DOWN);
						component.handleInput(DOWN);
						component.handleInput(ENTER);
					});
				},
				setWidget(_key: string, content: unknown): void {
					widgetUpdates.push(content);
				},
				notify(): void {},
			},
		};
		const controller = createSubagentBrowserController(state, 4);

		await controller.open(context as never);

		expect(state.pinnedRunId).toBe("run-2");
		expect(widgetUpdates).toHaveLength(1);
		expect(renderRequests).toBeGreaterThan(0);
	});

	test("refreshes and closes an active browser without changing the pin", async () => {
		// Purpose: throttled progress and session replacement must control the focused browser lifecycle safely.
		// Input and expected output: an appended run triggers a render request, then close resolves the dialog without changing run-1 pinning.
		// Edge case: the custom dialog remains pending until the controller closes it.
		// Dependencies: the controller retains only the active component and its done callback.
		const state = createState([createRun("run-1", "Inspect first area")]);
		state.pinnedRunId = "run-1";
		let focusedComponent: { handleInput(data: string): void } | undefined;
		let renderRequests = 0;
		const context = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom(
					factory: (
						tui: { requestRender(): void },
						theme: typeof plainTheme,
						keybindings: unknown,
						done: (result: unknown) => void,
					) => { handleInput(data: string): void },
				): Promise<unknown> {
					return new Promise((resolve) => {
						focusedComponent = factory(
							{
								requestRender(): void {
									renderRequests += 1;
								},
							},
							plainTheme,
							undefined,
							resolve,
						);
					});
				},
				setWidget(): void {},
				notify(): void {},
			},
		};
		const controller = createSubagentBrowserController(state, 4);
		const opened = controller.open(context as never);
		await Promise.resolve();
		expect(focusedComponent).toBeDefined();
		recordSubagentWidgetRun(
			state,
			createRun("run-2", "Inspect second area"),
			2,
		);

		controller.refresh();
		controller.close();
		await opened;

		expect(renderRequests).toBeGreaterThan(0);
		expect(state.pinnedRunId).toBe("run-1");
	});

	test("labels every run with its root-relative level", () => {
		// Purpose: every browser item must expose hierarchy depth without rebuilding an unbounded ancestor path.
		// Input and expected output: root labels end with Root, while the nested label ends with Depth 1 and keeps direct parent details.
		// Edge case: every run shares the same agent type and therefore depends on instance numbers and task names.
		// Dependencies: widget recording assigns presentation identity before browser flattening.
		const nested = createRun("nested", "Review widget model");
		const state = createState([
			createRun("root-a", "Design widget model", [nested]),
			createRun("root-b", "Test widget model"),
		]);

		const items = createSubagentBrowserItems(state);

		expect(items.map((item) => item.value)).toEqual([
			AUTOMATIC_SUBAGENT_VIEW,
			"root-a",
			"nested",
			"root-b",
		]);
		expect(items[1]?.label).toBe("Sage #1 · Design widget model · Root");
		expect(items[2]?.label).toBe("Sage #2 · Review widget model · Depth 1");
		expect(items[2]?.description).toContain(
			"Parent: SubAgentSage · Design widget model",
		);
		expect(items[3]?.label).toBe("Sage #3 · Test widget model · Root");
		expect(items[3]?.description).not.toContain("Parent:");
	});

	test("reaches every run through repeated Down navigation", () => {
		// Purpose: the bounded SelectList must make every recorded run reachable without PageDown support.
		// Input and expected output: twelve Down inputs from Automatic view select the twelfth run, then Enter returns its runId.
		// Edge case: the target is below the visible SelectList window.
		// Dependencies: SelectList owns scrolling and standard key matching.
		const state = createState(
			Array.from({ length: 12 }, (_, index) =>
				createRun(`run-${index + 1}`, `Inspect area ${index + 1}`),
			),
		);
		const selected: Array<string | undefined> = [];
		const browser = new SubagentBrowserList({
			state,
			theme: plainTheme,
			onSelect: (runId) => selected.push(runId),
			onCancel(): void {},
			requestRender(): void {},
		});

		for (let index = 0; index < 12; index += 1) {
			browser.handleInput(DOWN);
		}
		browser.handleInput(ENTER);

		expect(selected).toEqual(["run-12"]);
	});

	test("retains selection by runId when live data changes", () => {
		// Purpose: browser refresh must not move the user's selection when progress updates recreate SelectList.
		// Input and expected output: run-2 is selected, run-3 is appended, refresh occurs, and Enter still returns run-2.
		// Edge case: insertion changes the item fingerprint while preserving the selected run.
		// Dependencies: the component reads the current SelectList item before rebuilding it.
		const state = createState([
			createRun("run-1", "Inspect first area"),
			createRun("run-2", "Inspect second area"),
		]);
		const selected: Array<string | undefined> = [];
		let renderRequests = 0;
		const browser = new SubagentBrowserList({
			state,
			theme: plainTheme,
			onSelect: (runId) => selected.push(runId),
			onCancel(): void {},
			requestRender: () => {
				renderRequests += 1;
			},
		});
		browser.handleInput(DOWN);
		browser.handleInput(DOWN);
		recordSubagentWidgetRun(state, createRun("run-3", "Inspect third area"), 3);

		browser.refresh();
		browser.handleInput(ENTER);

		expect(selected).toEqual(["run-2"]);
		expect(renderRequests).toBeGreaterThan(0);
	});
});
