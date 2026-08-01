import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LogicalSession } from "../domain";
import type { ManagementProjectionView, ProjectionNode } from "../projection";
import {
	installSubagentStatusIndicator,
	type SubagentStatusSource,
} from "./status-indicator";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

/** Publishes controlled immutable views to the installed indicator. */
class StatusSourceFake implements SubagentStatusSource {
	private readonly listeners = new Set<
		(view: ManagementProjectionView) => void
	>();

	public constructor(private view: ManagementProjectionView) {}

	/** Returns the current hierarchy revision. */
	public getView(): ManagementProjectionView {
		return this.view;
	}

	/** Subscribes one indicator and returns deterministic cleanup. */
	public subscribe(
		listener: (view: ManagementProjectionView) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Publishes one replacement hierarchy revision. */
	public publish(view: ManagementProjectionView): void {
		this.view = view;
		for (const listener of this.listeners) {
			listener(view);
		}
	}
}

/** Creates one main-window projection with no selected conversation. */
function view(nodes: readonly ProjectionNode[]): ManagementProjectionView {
	return {
		revision: 1,
		nodes,
		selectedStableKey: null,
		selectedConversation: [],
		selectedConversationComplete: true,
		selectedLiveStatus: undefined,
		selectedProjectionSavedTokens: undefined,
		affectedStableKeys: nodes.map((node) => node.stableKey),
	};
}

/** Creates one direct or nested projected session in a controlled state. */
function node(
	id: number,
	state: LogicalSession["state"],
	parentStableKey: string | null = null,
): ProjectionNode {
	return {
		stableKey: `stable-${id}`,
		key: { ownerPiSessionId: `owner-${id}`, ownerLocalSessionId: id },
		parentStableKey,
		childPiSessionId: `child-${id}`,
		agentId: "SubAgent",
		taskName: `Task ${id}`,
		creationOrder: id,
		state,
	};
}

/** Captures public Pi widget updates without rendering the full application. */
function createUiFake(): {
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

/** Provides marker-free theme methods required by the public widget factory. */
function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

/** Marks semantic foreground colors without changing the status values under test. */
function markedTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

describe("subagent main-window status indicator", () => {
	test("restores and updates all descendant state counts", () => {
		// Purpose: a resumed hierarchy and every later revision must drive one persistent main-window indicator.
		// Inputs and expected output: direct and nested sessions populate all four counters, then a terminal update replaces the rendered counts.
		// Edge case: ancestry does not exclude nested sessions from aggregation.
		// Dependencies: immutable management projection views and public Pi widget rendering.
		const source = new StatusSourceFake(
			view([
				node(1, "active"),
				node(2, "terminal-failure", "stable-1"),
				node(3, "terminal-success", "stable-1"),
				node(4, "terminal-aborted", "stable-2"),
			]),
		);
		const fake = createUiFake();

		// ACT: install from the resumed view, publish a replacement, and render both public widget factories.
		const dispose = installSubagentStatusIndicator(fake.pi, fake.ui, source);
		const resumedFactory = fake.updates.at(-1)?.content;
		source.publish(
			view([
				node(1, "terminal-success"),
				node(2, "terminal-failure", "stable-1"),
				node(3, "terminal-success", "stable-1"),
				node(4, "terminal-aborted", "stable-2"),
			]),
		);
		const updatedFactory = fake.updates.at(-1)?.content;
		if (
			typeof resumedFactory !== "function" ||
			typeof updatedFactory !== "function"
		) {
			throw new Error("subagent status widget factory is missing");
		}
		const resumedRows = resumedFactory({} as TUI, theme()).render(120);
		const updatedRows = updatedFactory({} as TUI, theme()).render(120);
		dispose();

		// ASSERT: the top separator is width-bound, every state is explicit, and disposal clears the widget.
		expect({
			resumedRows,
			resumedLineWidth: visibleWidth(resumedRows[0] ?? ""),
			updatedRows,
			cleared: fake.updates.at(-1)?.content,
		}).toEqual({
			resumedRows: [
				"─".repeat(120),
				"Agents: ⧗ 1 · ✓ 1 · ✗ 1 · ■ 1 · Ctrl+Shift+G",
			],
			resumedLineWidth: 120,
			updatedRows: [
				"─".repeat(120),
				"Agents: ⧗ 0 · ✓ 2 · ✗ 1 · ■ 1 · Ctrl+Shift+G",
			],
			cleared: undefined,
		});
	});

	test("colors every status icon with its lifecycle meaning", () => {
		// Purpose: the main-window indicator must preserve the same semantic status colors as the management title.
		// Inputs and expected output: one session in every state colors running as accent, success as success, failure as error, and aborted as warning.
		// Edge case: the Agents label and shortcut remain outside status foreground spans.
		// Dependencies: public Pi widget theme and shared status aggregation.
		const source = new StatusSourceFake(
			view([
				node(1, "active"),
				node(2, "terminal-success"),
				node(3, "terminal-failure"),
				node(4, "terminal-aborted"),
			]),
		);
		const fake = createUiFake();

		const dispose = installSubagentStatusIndicator(fake.pi, fake.ui, source);
		const factory = fake.updates.at(-1)?.content;
		if (typeof factory !== "function") {
			throw new Error("subagent status widget factory is missing");
		}
		const status = factory({} as TUI, markedTheme()).render(200)[1] ?? "";
		dispose();

		expect(status).toContain(
			"Agents: <accent>⧗</accent> 1 · <success>✓</success> 1 · <error>✗</error> 1 · <warning>■</warning> 1 · Ctrl+Shift+G",
		);
	});

	test("stays absent until the session owns a subagent", () => {
		// Purpose: sessions that never launched a subagent must not reserve main-window rows.
		// Inputs and expected output: an empty initial view clears the widget, then the first starting node installs it.
		// Edge case: starting counts as running before the child reaches active state.
		// Dependencies: source subscription and the public setWidget clearing contract.
		const source = new StatusSourceFake(view([]));
		const fake = createUiFake();

		const dispose = installSubagentStatusIndicator(fake.pi, fake.ui, source);
		const initialContent = fake.updates.at(-1)?.content;
		source.publish(view([node(1, "starting")]));
		const startedContent = fake.updates.at(-1)?.content;
		dispose();

		expect({
			initialContent,
			started: typeof startedContent === "function",
		}).toEqual({ initialContent: undefined, started: true });
	});
});
