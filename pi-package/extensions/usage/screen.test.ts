import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { UsageScreen, type UsageScreenRuntime } from "./screen";
import type { UsageEvent } from "./store";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OPENED_AT = 100 * DAY_MS;
const SCROLL_INDICATOR_PATTERN = /[░█]/;
const ALL_SCOPE_TOTAL_PATTERN = /Total\s+100\.0\s+180/;

function plainText(value: string): string {
	return value
		.replaceAll("\u001b[31m", "")
		.replaceAll("\u001b[36m", "")
		.replaceAll("\u001b[39m", "");
}

function event(overrides: Partial<UsageEvent>): UsageEvent {
	return {
		eventId: "event",
		timestampMs: OPENED_AT,
		sessionId: "session",
		rootSessionId: "root-session",
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
		getKeys(action: string): string[];
		matches(data: string, action: string): boolean;
	};
	readonly theme: Theme;
}

function createFocusTheme(): Theme {
	return {
		fg: (color: string, text: string) => {
			const codes: Record<string, number> = {
				accent: 31,
				borderAccent: 36,
				border: 32,
				borderMuted: 33,
				muted: 90,
			};
			return `\u001b[${codes[color]}m${text}\u001b[39m`;
		},
		bg: (color: string, text: string) =>
			color === "selectedBg"
				? `\u001b[44m${text}\u001b[49m`
				: `\u001b[45m${text}\u001b[49m`,
		bold: (text: string) => text,
	} as Theme;
}

function createScreen(
	events: readonly UsageEvent[],
	close: () => void,
	rows = 12,
): UsageScreen {
	initTheme(undefined, false);
	const runtime: ScreenRuntime = {
		tui: { terminal: { rows }, requestRender: () => {} },
		keybindings: {
			getKeys: (action) => {
				const keys: Record<string, string> = {
					"tui.select.up": Key.up,
					"tui.select.down": Key.down,
					"tui.select.pageUp": Key.pageUp,
					"tui.select.pageDown": Key.pageDown,
					"tui.select.confirm": Key.enter,
				};
				const key = keys[action];
				return key === undefined ? [] : [key];
			},
			matches: (data, action) => {
				const key = runtime.keybindings.getKeys(action)[0];
				return key !== undefined && matchesKey(data, key as never);
			},
		},
		theme: createFocusTheme(),
	};
	return new UsageScreen(
		events,
		{ openedAt: OPENED_AT, currentRootSessionId: "root-session" },
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
		screen.handleInput("\u001b[Z");
		screen.handleInput("\t");
		screen.handleInput("\t");
		screen.handleInput("\u001b[B");
		screen.handleInput("\t");
		screen.handleInput("\u001b[6~");
		for (let index = 0; index < 8; index += 1) {
			screen.handleInput("\u001b[C");
		}
		const lines = screen.render(100);
		const rendered = lines.join("\n");

		expect(lines).toHaveLength(12);
		expect(lines[0]?.startsWith("┌─ USAGE ")).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
		expect(plainText(rendered)).toContain("Range: 1h 24h [7d] 30d 90d");
		expect(rendered).toContain("\u001b[45m agent-a");
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("Saved");
		expect(rendered).toMatch(SCROLL_INDICATOR_PATTERN);
	});

	test("replaces every active zone title accent while Tab cycles focus", () => {
		// Purpose: focus ownership must use the approved accent and border-accent color contract.
		// Inputs and expected output: Tab cycles agents, table, range, and agents while only the active zone uses borderAccent.
		// Edge case: all seven table headers change together and data values keep their normal color.
		// Dependencies: wide focus ordering, the Pi theme, and width-safe pane headings.
		const screen = createScreen(manyEvents(), () => {});
		const agents = screen.render(200);
		screen.handleInput("\t");
		const table = screen.render(200);
		screen.handleInput("\t");
		const range = screen.render(200);
		screen.handleInput("\t");
		const sessions = screen.render(200);
		screen.handleInput("\t");
		const agentsAgain = screen.render(200);
		const inactive = (label: string) => `\u001b[31m${label}\u001b[39m`;
		const active = (label: string) => `\u001b[36m${label}\u001b[39m`;
		const headers = [
			"Model",
			"Cost%",
			"Tokens",
			"CacheR",
			"CacheW",
			"Hit%",
			"Cost",
			"Saved",
		];

		expect(agents[1]).toContain(inactive("Range"));
		expect(agents[3]).toContain(active("Agents"));
		expect(table[1]).toContain(inactive("Range"));
		expect(table[3]).toContain(inactive("Agents"));
		expect(range[1]).toContain(active("Range"));
		expect(range[3]).toContain(inactive("Agents"));
		expect(sessions[1]).toContain(active("Sessions"));
		expect(agentsAgain[3]).toContain(active("Agents"));
		expect(agents[5]).toContain("\u001b[44m All agents");
		expect(table[5]).toContain("\u001b[45m All agents");
		expect(range[5]).toContain("\u001b[45m All agents");
		expect(agentsAgain[5]).toContain("\u001b[44m All agents");
		for (const header of headers) {
			expect(agents[3]).toContain(inactive(header));
			expect(table[3]).toContain(active(header));
			expect(range[3]).toContain(inactive(header));
		}
	});

	test("defaults to Current and operates the Sessions scope with inactive pane thumbs", () => {
		// Purpose: the session selector must expose one immutable current-family view and the complete opening snapshot.
		// Inputs and expected output: Current hides another root, Sessions focus uses borderAccent, and Right reveals All.
		// Edge case: both overflowing pane thumbs remain inactive while Sessions owns focus.
		// Dependencies: root-family snapshot preparation, four-zone keyboard navigation, and pane scroll colors.
		const events = Array.from({ length: 18 }, (_, index) =>
			event({
				eventId: `scope-${index}`,
				rootSessionId: index < 9 ? "root-session" : "other-root",
				sessionId: `session-${index}`,
				agentId: `agent-${String(index).padStart(2, "0")}`,
				provider: `provider-${String(index).padStart(2, "0")}`,
				model: `model-${String(index).padStart(2, "0")}`,
			}),
		);
		const screen = createScreen(events, () => {}, 12);
		const current = screen.render(160).join("\n");
		screen.handleInput("\u001b[Z");
		const focused = screen.render(160).join("\n");
		screen.handleInput("\u001b[C");
		const all = screen.render(160).join("\n");

		expect(plainText(current)).toContain("Sessions: [Current] All");
		expect(current).toContain("agent-00");
		expect(current).not.toContain("agent-09");
		expect(focused).toContain("\u001b[36mSessions\u001b[39m");
		expect(focused).toContain("\u001b[33m█\u001b[39m");
		expect(focused).not.toContain("\u001b[32m█\u001b[39m");
		expect(plainText(all)).toContain("Sessions: Current [All]");
		expect(plainText(all)).toMatch(ALL_SCOPE_TOTAL_PATTERN);
	});

	test("renders active-zone keyboard hints as the final in-frame content row", () => {
		// Purpose: users must see the available keyboard actions for the currently focused usage zone.
		// Inputs and expected output: wide and narrow screens show zone-specific configured and raw-key hints immediately above the bottom border.
		// Edge case: narrow agents show open and close, while the narrow table shows horizontal movement and back.
		// Dependencies: Pi keybindings, raw key hints, responsive focus state, and the terminal row budget.
		const wide = createScreen(manyEvents(), () => {});
		const wideAgents = wide.render(100).at(-2) ?? "";
		wide.handleInput("\u001b[Z");
		wide.handleInput("\u001b[Z");
		const wideRange = wide.render(100).at(-2) ?? "";
		wide.handleInput("\t");
		wide.handleInput("\t");
		wide.handleInput("\t");
		const wideTable = wide.render(100).at(-2) ?? "";

		const narrow = createScreen(manyEvents(), () => {});
		const narrowAgents = narrow.render(79).at(-2) ?? "";
		narrow.handleInput("\r");
		const narrowTable = narrow.render(79).at(-2) ?? "";

		for (const [line, actions] of [
			[wideAgents, ["select", "focus", "close"]],
			[wideRange, ["range", "focus", "close"]],
			[wideTable, ["scroll", "page", "left/right", "move", "focus", "close"]],
			[narrowAgents, ["select", "open", "focus", "close"]],
			[narrowTable, ["scroll", "page", "left/right", "move", "focus", "back"]],
		] as const) {
			expect(line.startsWith("│")).toBe(true);
			for (const action of actions) {
				expect(line).toContain(action);
			}
		}
		expect(wideTable).not.toContain("←/→");
		expect(narrowTable).not.toContain("←/→");
	});

	test("separates pane headings, footer content, and the bottom border", () => {
		// Purpose: pane headings and the footer must each have the frame boundaries shown by the reference screen.
		// Inputs and expected output: wide and narrow layouts render exact heading and footer separators plus uninterrupted bottom borders.
		// Edge case: wide junctions change from a cross below headings to a bottom junction above the full-width footer.
		// Dependencies: responsive layout dimensions and the fixed terminal row budget.
		const wide = createScreen(manyEvents(), () => {}).render(100);
		const narrow = createScreen(manyEvents(), () => {}).render(36);

		expect(wide).toHaveLength(12);
		expect(wide[4]).toBe(`├${"─".repeat(32)}┼${"─".repeat(65)}┤`);
		expect(wide.at(-3)).toBe(`├${"─".repeat(32)}┴${"─".repeat(65)}┤`);
		expect(wide.at(-2)?.startsWith("│")).toBe(true);
		expect(wide.at(-1)).toBe(`└${"─".repeat(98)}┘`);
		expect(narrow).toHaveLength(12);
		expect(narrow[5]).toBe(`├${"─".repeat(34)}┤`);
		expect(narrow.at(-3)).toBe(`├${"─".repeat(34)}┤`);
		expect(narrow.at(-2)?.startsWith("│")).toBe(true);
		expect(narrow.at(-1)).toBe(`└${"─".repeat(34)}┘`);
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
		for (let index = 0; index < 12; index += 1) {
			screen.handleInput("\u001b[C");
		}
		const tableLines = screen.render(36);
		const table = tableLines.join("\n");
		screen.handleInput("\u001b");
		const returned = screen.render(36).join("\n");
		screen.handleInput("\u001b");

		expect(plainText(agents)).toContain("Sessions: [Current] All");
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
		// Inputs and expected output: a 20-day-old event leaves the opening 7d range selected and shows the approved empty text.
		// Edge case: broader-range data exists in the same immutable snapshot.
		// Dependencies: immutable range filtering and responsive screen rendering only.
		const screen = createScreen(
			[event({ timestampMs: OPENED_AT - 20 * DAY_MS })],
			() => {},
		);

		screen.render(100);
		screen.handleInput("\t");
		const lines = screen.render(100);
		const rendered = lines.join("\n");

		expect(plainText(rendered)).toContain("Range: 1h 24h [7d] 30d 90d");
		expect(lines[3]).toContain(
			"│\u001b[36mNo usage in selected range\u001b[39m",
		);
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
