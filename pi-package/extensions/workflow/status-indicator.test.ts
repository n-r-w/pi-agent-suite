import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installWorkflowStatusIndicator } from "./status-indicator";
import type { WorkflowState } from "./workflow";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

/** Captures public widget updates on one shared Pi event carrier. */
function createIndicatorFake(): {
	readonly pi: ExtensionAPI;
	readonly ui: ExtensionContext["ui"];
	readonly updates: Array<{ key: string; content: WidgetContent }>;
} {
	const updates: Array<{ key: string; content: WidgetContent }> = [];
	const pi = { events: {} } as unknown as ExtensionAPI;
	const ui = {
		setWidget(key: string, content: WidgetContent): void {
			updates.push({ key, content });
		},
	} as unknown as ExtensionContext["ui"];
	return { pi, ui, updates };
}

/** Provides the minimum theme required by the shared widget factory. */
function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

/** Marks theme colors without changing status text. */
function markedTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

/** Creates one dynamic workflow state with caller-controlled display text and route. */
function workflowState(
	description: string,
	route: readonly string[] = ["ideation"],
): WorkflowState {
	return {
		source: "dynamic",
		workflow: {
			id: "TuiBrainstorming",
			description: "TUI brainstorming",
			stages: [
				{
					id: "ideation",
					description,
					prompt: "Generate concepts",
					initial: true,
					final: false,
				},
				{
					id: "synthesis",
					description: "Summarize the strongest concepts",
					prompt: "Summarize concepts",
					initial: false,
					final: true,
				},
			],
			transitions: [
				{ from: "ideation", to: "synthesis", type: "advance" },
				{ from: "synthesis", to: "ideation", type: "rework" },
			],
		},
		route,
	};
}

/** Renders the latest shared widget factory at one viewport width. */
function renderLatest(
	updates: readonly { key: string; content: WidgetContent }[],
	width: number,
	selectedTheme: Theme = theme(),
): string[] {
	const factory = updates.at(-1)?.content;
	if (typeof factory !== "function") {
		throw new Error("workflow status widget factory is missing");
	}
	return factory({} as TUI, selectedTheme).render(width);
}

describe("workflow session status indicator", () => {
	test("normalizes and bounds the active workflow row", () => {
		// Purpose: the compact row must remain a readable single line for persisted workflow text.
		// Inputs and expected output: layout whitespace collapses and one sentence-ending period is removed before rendering.
		// Edge case: a narrow viewport ends the visible row with one Unicode ellipsis.
		// Dependencies: workflow route identity, terminal display normalization, and shared panel truncation.
		const fake = createIndicatorFake();
		const indicator = installWorkflowStatusIndicator(fake.pi, fake.ui);
		indicator.publish(
			workflowState("  Generate   and\t discuss\r\nTUI\u2028concepts.  "),
		);

		const fullRows = renderLatest(fake.updates, 120).map((row) =>
			stripVTControlCharacters(row),
		);
		const narrowRows = renderLatest(fake.updates, 36).map((row) =>
			stripVTControlCharacters(row),
		);
		const styledRows = renderLatest(fake.updates, 120, markedTheme());
		indicator.dispose();

		expect(fullRows).toEqual([
			"─".repeat(120),
			"Workflow: TuiBrainstorming · Generate and discuss TUI concepts",
		]);
		expect(styledRows[1]).toBe(
			"<dim>Workflow: TuiBrainstorming · Generate and discuss TUI concepts</dim>",
		);
		expect(narrowRows[1]?.endsWith("…")).toBe(true);
		expect(visibleWidth(narrowRows[1] ?? "")).toBe(36);
	});

	test("replaces the active stage and clears absent workflow state", () => {
		// Purpose: the row must follow the last route stage and disappear when no workflow is effective.
		// Inputs and expected output: a transitioned route replaces ideation with synthesis, then undefined clears the widget.
		// Edge case: clearing Workflow must not require a transition target or graph rendering.
		// Dependencies: validated route ordering and independent shared-row ownership.
		const fake = createIndicatorFake();
		const indicator = installWorkflowStatusIndicator(fake.pi, fake.ui);
		indicator.publish(workflowState("Generate concepts"));
		indicator.publish(
			workflowState("Generate concepts", ["ideation", "synthesis"]),
		);
		const rows = renderLatest(fake.updates, 120).map((row) =>
			stripVTControlCharacters(row),
		);
		indicator.publish(undefined);
		const cleared = fake.updates.at(-1)?.content;
		indicator.dispose();

		expect(rows[1]).toBe(
			"Workflow: TuiBrainstorming · Summarize the strongest concepts",
		);
		expect(cleared).toBeUndefined();
	});
});
