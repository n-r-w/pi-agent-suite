import { describe, expect, test } from "bun:test";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { UsageScreen, type UsageScreenRuntime } from "./screen";
import type { UsageEvent } from "./store";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OPENED_AT = 100 * DAY_MS;
const SCROLL_INDICATOR_PATTERN = /[░█]/;

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: OPENED_AT,
		sessionId: "session",
		agentId: "agent-b",
		source: "agent-turn",
		provider: "provider",
		model: "model",
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cost: 5,
		saved: 6,
		...overrides,
	};
}

interface ScreenRuntime {
	readonly tui: {
		readonly terminal: { readonly rows: number };
		requestRender(): void;
	};
	readonly keybindings: {
		matches(data: string, action: string): boolean;
	};
}

function createScreen(
	events: readonly UsageEvent[],
	close: () => void,
	rows = 12,
): UsageScreen {
	const runtime: ScreenRuntime = {
		tui: { terminal: { rows }, requestRender: () => {} },
		keybindings: {
			matches: (data, action) => {
				const keys: Record<string, string> = {
					"tui.select.up": Key.up,
					"tui.select.down": Key.down,
					"tui.select.pageUp": Key.pageUp,
					"tui.select.pageDown": Key.pageDown,
					"tui.select.confirm": Key.enter,
				};
				const key = keys[action];
				return key !== undefined && matchesKey(data, key as never);
			},
		},
	};
	return new UsageScreen(
		events,
		OPENED_AT,
		close,
		runtime as UsageScreenRuntime,
	);
}

function manyEvents(): UsageEvent[] {
	return Array.from({ length: 18 }, (_, index) =>
		event({
			eventId: `event-${index}`,
			agentId: index % 2 === 0 ? "agent-a" : "agent-b",
			provider: `provider-${String(index).padStart(2, "0")}`,
			model: `model-with-a-long-name-${String(index).padStart(2, "0")}`,
		}),
	);
}

function observedEvents(events: readonly UsageEvent[]): {
	readonly events: readonly UsageEvent[];
	readonly reads: () => number;
} {
	let reads = 0;
	const observed = events.map(
		(item) =>
			new Proxy(item, {
				get(target, property, receiver) {
					reads += 1;
					return Reflect.get(target, property, receiver);
				},
			}),
	);
	return { events: observed, reads: () => reads };
}

describe("usage snapshot screen", () => {
	test("renders a full-height wide screen with focused range, agents, and scrollable table zones", () => {
		// Purpose: wide terminals must expose all three focus zones and keep large model data reachable in one screen.
		// Inputs and expected output: focus moves from agents to range and table; the approved spaced top label remains above 7d and agent-a.
		// Edge case: both vertical and horizontal overflow use shared scroll indicators and every framed row stays width-safe.
		// Dependencies: Pi key sequences, immutable snapshot views, terminal row budget, and public visible-width measurement.
		const screen = createScreen(manyEvents(), () => {}, 12);

		screen.handleInput("\u001b[Z");
		screen.handleInput("\u001b[C");
		screen.handleInput("\t");
		screen.handleInput("\u001b[B");
		screen.handleInput("\t");
		screen.handleInput("\u001b[6~");
		screen.handleInput("\u001b[C");
		screen.handleInput("\u001b[C");
		screen.handleInput("\u001b[C");
		const lines = screen.render(100);
		const rendered = lines.join("\n");

		expect(lines).toHaveLength(12);
		expect(lines[0]?.startsWith("┌─ USAGE ")).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
		expect(rendered).toContain("Range: 24h [7d] 30d 90d");
		expect(rendered).toContain("● agent-a");
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("Saved");
		expect(rendered).toMatch(SCROLL_INDICATOR_PATTERN);
	});

	test("shows the current focus owner while Tab cycles every wide zone", () => {
		// Purpose: users must see which zone will receive arrow and paging input.
		// Inputs and expected output: the initial agents marker moves to range, agents, and table through Shift+Tab and Tab.
		// Edge case: focus presentation changes without changing the selected range or agent.
		// Dependencies: wide focus ordering and width-safe pane headings.
		const screen = createScreen(manyEvents(), () => {});
		const agents = screen.render(100).join("\n");
		screen.handleInput("\u001b[Z");
		const range = screen.render(100).join("\n");
		screen.handleInput("\t");
		screen.handleInput("\t");
		const table = screen.render(100).join("\n");

		expect(agents).toContain("› Agents");
		expect(range).toContain("› Range:");
		expect(table).toContain("› Model");
	});

	test("uses one-pane narrow navigation and two-step Escape behavior", () => {
		// Purpose: narrow terminals must keep agents and the model table readable as separate panes.
		// Inputs and expected output: agents render first, Enter opens the table, Escape returns to agents, and the next Escape closes.
		// Edge case: a long model identifier remains reachable by horizontal scrolling without exceeding terminal width.
		// Dependencies: responsive layout state, Pi confirm and escape keys, and width-safe table slicing.
		let closeCalls = 0;
		const screen = createScreen(manyEvents(), () => {
			closeCalls += 1;
		});

		const agents = screen.render(36).join("\n");
		screen.handleInput("\r");
		const initialTable = screen.render(36).join("\n");
		for (let index = 0; index < 8; index += 1) {
			screen.handleInput("\u001b[C");
		}
		const tableLines = screen.render(36);
		const table = tableLines.join("\n");
		screen.handleInput("\u001b");
		const returned = screen.render(36).join("\n");
		screen.handleInput("\u001b");

		expect(agents).toContain("Agents");
		expect(agents).not.toContain("Model");
		expect(initialTable).toContain("Model");
		expect(table).toContain("Saved");
		expect(table).toMatch(SCROLL_INDICATOR_PATTERN);
		expect(tableLines.every((line) => visibleWidth(line) <= 36)).toBe(true);
		expect(returned).toContain("Agents");
		expect(closeCalls).toBe(1);
	});

	test("shows the approved empty state without changing the selected range", () => {
		// Purpose: the screen must explain an empty range without silently changing the selected range.
		// Inputs and expected output: a 20-day-old event leaves the opening 24h range selected and shows the approved empty text.
		// Edge case: broader-range data exists in the same immutable snapshot.
		// Dependencies: immutable range filtering and responsive screen rendering only.
		const screen = createScreen(
			[event({ timestampMs: OPENED_AT - 20 * DAY_MS })],
			() => {},
		);

		const rendered = screen.render(100).join("\n");

		expect(rendered).toContain("Range: [24h] 7d 30d 90d");
		expect(rendered).toContain("No usage in selected range");
	});

	test("prepares immutable range and agent views before interaction", () => {
		// Purpose: redraws and selection changes must read prepared views instead of scanning or aggregating source events again.
		// Inputs and expected output: construction performs all event reads; repeated wide renders, agent selection, and range selection add no event reads.
		// Edge case: selection crosses both agent and range boundaries.
		// Dependencies: the public screen constructor, production rendering, and production input handling.
		const observed = observedEvents([
			event({ eventId: "agent-a", agentId: "agent-a" }),
			event({ eventId: "agent-b", agentId: "agent-b" }),
		]);
		const screen = createScreen(observed.events, () => {});
		const readsAfterCreation = observed.reads();

		screen.render(100);
		screen.render(100);
		screen.handleInput(Key.down);
		screen.render(100);
		screen.handleInput(Key.shift("tab"));
		screen.handleInput(Key.right);
		screen.render(100);

		expect(readsAfterCreation).toBeGreaterThan(0);
		expect(observed.reads()).toBe(readsAfterCreation);
	});

	test("keeps every production screen line within widths zero through eighty", () => {
		// Purpose: the production screen must honor its visible-width contract throughout terminal resizing.
		// Inputs and expected output: empty and populated snapshots render widths 0 through 80 with no over-width lines.
		// Edge case: widths below the framed pane minimum include the two-column overflow boundary.
		// Dependencies: the public screen component and Pi visible-width measurement.
		const overflows: Array<{ width: number; lineWidth: number }> = [];
		for (const events of [[], manyEvents()]) {
			const screen = createScreen(events, () => {});
			for (let width = 0; width <= 80; width += 1) {
				for (const line of screen.render(width)) {
					const lineWidth = visibleWidth(line);
					if (lineWidth > width) {
						overflows.push({ width, lineWidth });
					}
				}
			}
		}

		expect(overflows).toEqual([]);
	});

	test("disposes once and ignores later input", () => {
		// Purpose: closing the full-screen component must release its interaction lifecycle.
		// Inputs and expected output: two dispose calls followed by Escape do not invoke the close callback.
		// Edge case: disposal is idempotent.
		// Dependencies: the component disposal contract only.
		let closeCalls = 0;
		const screen = createScreen([], () => {
			closeCalls += 1;
		});
		screen.dispose();
		screen.dispose();
		screen.handleInput("\u001b");
		expect(closeCalls).toBe(0);
	});
});
