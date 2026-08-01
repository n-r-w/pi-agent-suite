import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type * as SessionStatusPanelModule from "./session-status-panel";
import { acquireSessionStatusRow } from "./session-status-panel";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

/** Captures the shared event carrier and public widget updates. */
function createPanelFake(events: object = {}): {
	readonly pi: ExtensionAPI;
	readonly ui: ExtensionContext["ui"];
	readonly updates: Array<{ key: string; content: WidgetContent }>;
} {
	const updates: Array<{ key: string; content: WidgetContent }> = [];
	const pi = { events } as unknown as ExtensionAPI;
	const ui = {
		setWidget(key: string, content: WidgetContent): void {
			updates.push({ key, content });
		},
	} as unknown as ExtensionContext["ui"];
	return { pi, ui, updates };
}

/** Provides the minimum theme used by producer renderers. */
function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

/** Renders the latest installed widget factory or fails with its missing state. */
function renderLatest(
	updates: readonly { key: string; content: WidgetContent }[],
	width: number,
): string[] {
	const factory = updates.at(-1)?.content;
	if (typeof factory !== "function") {
		throw new Error("session status widget factory is missing");
	}
	return factory({} as TUI, theme()).render(width);
}

/** Imports an isolated module instance against the same process event carrier. */
async function importIsolatedPanelModule(
	isolateId: string,
): Promise<typeof SessionStatusPanelModule> {
	const moduleUrl = pathToFileURL(
		`${process.cwd()}/pi-package/shared/session-status-panel.ts`,
	).href;
	return (await import(
		`${moduleUrl}?session-status-panel-test=${isolateId}-${Date.now()}`
	)) as typeof SessionStatusPanelModule;
}

describe("shared session status panel", () => {
	test("composes independently published rows in stable order", () => {
		// Purpose: independent extensions must share one widget without relying on publication order.
		// Inputs and expected output: Workflow publishes before Agents, while explicit order renders Agents first under one separator.
		// Edge case: the later Agents publication must retain the existing Workflow row.
		// Dependencies: the shared event carrier and Pi widget factory contract.
		const fake = createPanelFake();
		const workflow = acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "workflow",
			order: 20,
		});
		const agents = acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "agents",
			order: 10,
		});

		workflow.set(
			() => "Workflow: TuiBrainstorming · Generate and discuss TUI concepts",
		);
		agents.set(() => "Agents: ⧗ 0 · ✓ 1 · ✗ 0 · ■ 0 · Ctrl+Shift+G");
		const rows = renderLatest(fake.updates, 100);
		workflow.dispose();
		agents.dispose();

		expect(rows).toEqual([
			"─".repeat(100),
			"Agents: ⧗ 0 · ✓ 1 · ✗ 0 · ■ 0 · Ctrl+Shift+G",
			"Workflow: TuiBrainstorming · Generate and discuss TUI concepts",
		]);
	});

	test("bounds every row and clears only absent producers", () => {
		// Purpose: the panel must respect the actual viewport width and preserve independent producer ownership.
		// Inputs and expected output: two long rows render with an ellipsis; hiding Workflow retains Agents; disposing Agents clears the widget.
		// Edge case: zero width renders no rows instead of emitting an invalid separator.
		// Dependencies: Pi Unicode-aware width helpers and setWidget clearing semantics.
		const fake = createPanelFake();
		const agents = acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "agents",
			order: 10,
		});
		const workflow = acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "workflow",
			order: 20,
		});
		agents.set(() => "Agents: one very long status row");
		workflow.set(() => "Workflow: one very long status row");

		const bounded = renderLatest(fake.updates, 18);
		const plainBounded = bounded.map((row) => stripVTControlCharacters(row));
		const zeroWidth = renderLatest(fake.updates, 0);
		workflow.set(undefined);
		const agentsOnly = renderLatest(fake.updates, 80);
		agents.dispose();
		const cleared = fake.updates.at(-1)?.content;
		workflow.dispose();

		expect({
			bounded: plainBounded,
			widths: bounded.map((row) => visibleWidth(row)),
			zeroWidth,
			agentsOnly,
			cleared,
		}).toEqual({
			bounded: ["─".repeat(18), "Agents: one very …", "Workflow: one ver…"],
			widths: [18, 18, 18],
			zeroWidth: [],
			agentsOnly: ["─".repeat(80), "Agents: one very long status row"],
			cleared: undefined,
		});
	});

	test("shares one controller across isolated module instances", async () => {
		// Purpose: separately loaded extensions must coordinate through pi.events instead of module identity.
		// Inputs and expected output: isolated module instances publish Agents and Workflow into one widget.
		// Edge case: disposing an older same-key handle must not clear its replacement.
		// Dependencies: Bun isolated imports and the persistent Pi event carrier.
		const events = {};
		const fake = createPanelFake(events);
		const moduleA = await importIsolatedPanelModule("a");
		const moduleB = await importIsolatedPanelModule("b");
		const oldAgents = moduleA.acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "agents",
			order: 10,
		});
		const workflow = moduleB.acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "workflow",
			order: 20,
		});
		const agents = moduleB.acquireSessionStatusRow(fake.pi, fake.ui, {
			key: "agents",
			order: 10,
		});

		oldAgents.set(() => "Agents: stale");
		workflow.set(() => "Workflow: current");
		agents.set(() => "Agents: current");
		oldAgents.dispose();
		const rows = renderLatest(fake.updates, 80);
		agents.dispose();
		workflow.dispose();

		expect(rows).toEqual([
			"─".repeat(80),
			"Agents: current",
			"Workflow: current",
		]);
	});
});
