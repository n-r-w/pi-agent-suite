import { rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type Keybinding,
	type KeybindingsManager,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { padToWidth, renderAgentPane } from "./agent-pane";
import {
	type PreparedUsageSnapshot,
	prepareUsageSnapshot,
	USAGE_RANGES,
} from "./snapshot";
import type { UsageEvent } from "./store";
import { renderTablePane } from "./table-pane";

const WIDE_MINIMUM_WIDTH = 80;
const AGENT_MINIMUM_WIDTH = 24;
const FRAME_ROWS = 7;
const HORIZONTAL_SCROLL_STEP = 8;
const WIDE_FRAME_AND_SEPARATOR_WIDTH = 3;
const AGENT_WIDTH_DIVISOR = 3;

type UsageFocusZone = "range" | "sessions" | "agents" | "table";
type UsageSessionScope = "current" | "all";
const USAGE_SESSION_SCOPES: readonly UsageSessionScope[] = ["current", "all"];
type UsageNarrowPane = "agents" | "table";

export interface UsageScreenRuntime {
	readonly tui: TUI;
	readonly keybindings: KeybindingsManager;
	readonly theme: Theme;
}

/** Renders and navigates one immutable full-terminal usage snapshot. */
export class UsageScreen implements Component {
	private rangeIndex = 2;
	private sessionScopeIndex = 0;
	private selectedAgentId: string | undefined;
	private focus: UsageFocusZone = "agents";
	private narrowPane: UsageNarrowPane = "agents";
	private tableVerticalOffset = 0;
	private tableHorizontalOffset = 0;
	private tableViewport = 1;
	private lastWidth = WIDE_MINIMUM_WIDTH;
	private disposed = false;
	private readonly snapshot: PreparedUsageSnapshot;

	public constructor(
		events: readonly UsageEvent[],
		opening: {
			readonly openedAt: number;
			readonly currentRootSessionId: string;
		},
		private readonly close: () => void,
		private readonly runtime: UsageScreenRuntime,
	) {
		this.snapshot = prepareUsageSnapshot(
			events,
			opening.openedAt,
			opening.currentRootSessionId,
		);
	}

	public render(width: number): string[] {
		this.lastWidth = width;
		this.normalizeFocus();
		const rowBudget = Math.max(1, this.runtime?.tui?.terminal?.rows ?? 24);
		const layout = this.layoutForWidth(width);
		const selectorLines =
			layout === "wide"
				? [this.renderSelectors(Math.max(0, width - 2))]
				: [
						this.renderRange(Math.max(0, width - 2)),
						this.renderSessions(Math.max(0, width - 2)),
					];
		const frameRows = FRAME_ROWS + selectorLines.length - 1;
		if (width <= 2 || rowBudget <= frameRows) {
			return Array.from({ length: rowBudget }, () =>
				"".padEnd(Math.max(0, width)),
			);
		}
		const contentHeight = rowBudget - frameRows;
		return layout === "wide"
			? this.renderWide(width, contentHeight, selectorLines[0] ?? "")
			: this.renderNarrow(width, contentHeight, selectorLines);
	}

	public handleInput(data: string): void {
		if (this.disposed) {
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.cycleFocus(1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleFocus(-1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (
				this.layoutForWidth(this.lastWidth) === "narrow" &&
				this.narrowPane === "table"
			) {
				this.narrowPane = "agents";
				this.focus = "agents";
				this.requestRender();
				return;
			}
			this.close();
			return;
		}
		if (
			this.layoutForWidth(this.lastWidth) === "narrow" &&
			this.narrowPane === "agents" &&
			this.focus === "agents" &&
			this.matchesAction(data, "tui.select.confirm", Key.enter)
		) {
			this.narrowPane = "table";
			this.focus = "table";
			this.requestRender();
			return;
		}
		if (this.handleFocusedInput(data)) {
			this.requestRender();
		}
	}

	public invalidate(): void {}

	/** Makes repeated overlay disposal safe and prevents late input handling. */
	public dispose(): void {
		this.disposed = true;
	}

	private renderWide(
		width: number,
		height: number,
		rangeLine: string,
	): string[] {
		const available = width - WIDE_FRAME_AND_SEPARATOR_WIDTH;
		const agentWidth = Math.max(
			AGENT_MINIMUM_WIDTH,
			Math.floor(available / AGENT_WIDTH_DIVISOR),
		);
		const tableWidth = available - agentWidth;
		const view = this.currentView();
		const agents = renderAgentPane(view.agentIds, this.selectedAgentId, {
			width: Math.max(0, agentWidth - 1),
			height,
			focused: this.focus === "agents",
			theme: this.runtime.theme,
		});
		const table = renderTablePane(view.rows, {
			width: Math.max(0, tableWidth - 1),
			height,
			verticalOffset: this.tableVerticalOffset,
			horizontalOffset: this.tableHorizontalOffset,
			focused: this.focus === "table",
			theme: this.runtime.theme,
		});
		this.syncTableViewport(table);
		return [
			border("┌", "┐", width, "─ USAGE "),
			`│${rangeLine}│`,
			`├${"─".repeat(agentWidth)}┬${"─".repeat(tableWidth)}┤`,
			...(height > 0
				? [
						`│${agents.lines[0] ?? padToWidth("", agentWidth - 1)}${agents.scroll[0] ?? " "}│${table.lines[0] ?? padToWidth("", tableWidth - 1)}${table.scroll[0] ?? " "}│`,
					]
				: []),
			`├${"─".repeat(agentWidth)}┼${"─".repeat(tableWidth)}┤`,
			...Array.from({ length: Math.max(0, height - 1) }, (_, index) => {
				const row = index + 1;
				return `│${agents.lines[row] ?? padToWidth("", agentWidth - 1)}${agents.scroll[row] ?? " "}│${table.lines[row] ?? padToWidth("", tableWidth - 1)}${table.scroll[row] ?? " "}│`;
			}),
			`├${"─".repeat(agentWidth)}┴${"─".repeat(tableWidth)}┤`,
			`│${padToWidth(this.renderHints(width - 2), width - 2)}│`,
			border("└", "┘", width),
		];
	}

	private renderNarrow(
		width: number,
		height: number,
		selectorLines: readonly string[],
	): string[] {
		const paneWidth = width - 2;
		const contentWidth = Math.max(0, paneWidth - 1);
		const view = this.currentView();
		const pane =
			this.narrowPane === "agents"
				? renderAgentPane(view.agentIds, this.selectedAgentId, {
						width: contentWidth,
						height,
						focused: this.focus === "agents",
						theme: this.runtime.theme,
					})
				: renderTablePane(view.rows, {
						width: contentWidth,
						height,
						verticalOffset: this.tableVerticalOffset,
						horizontalOffset: this.tableHorizontalOffset,
						focused: this.focus === "table",
						theme: this.runtime.theme,
					});
		if (this.narrowPane === "table") {
			this.syncTableViewport(pane as ReturnType<typeof renderTablePane>);
		}
		return [
			border("┌", "┐", width, "─ USAGE "),
			...selectorLines.map((line) => `│${line}│`),
			border("├", "┤", width),
			...(height > 0
				? [
						`│${pane.lines[0] ?? padToWidth("", contentWidth)}${pane.scroll[0] ?? " "}│`,
					]
				: []),
			border("├", "┤", width),
			...Array.from({ length: Math.max(0, height - 1) }, (_, index) => {
				const row = index + 1;
				return `│${pane.lines[row] ?? padToWidth("", contentWidth)}${pane.scroll[row] ?? " "}│`;
			}),
			border("├", "┤", width),
			`│${padToWidth(this.renderHints(width - 2), width - 2)}│`,
			border("└", "┘", width),
		];
	}

	private renderSelectors(width: number): string {
		return padToWidth(
			`${this.rangeSelector()}   ${this.sessionsSelector()}`,
			width,
		);
	}

	private renderRange(width: number): string {
		return padToWidth(this.rangeSelector(), width);
	}

	private renderSessions(width: number): string {
		return padToWidth(this.sessionsSelector(), width);
	}

	private rangeSelector(): string {
		const values = USAGE_RANGES.map((label, index) =>
			index === this.rangeIndex ? `[${label}]` : label,
		).join(" ");
		const title = this.runtime.theme.fg(
			this.focus === "range" ? "borderAccent" : "accent",
			this.runtime.theme.bold("Range"),
		);
		return `${title}: ${values}`;
	}

	private sessionsSelector(): string {
		const values = USAGE_SESSION_SCOPES.map((scope, index) => {
			const label = scope === "current" ? "Current" : "All";
			return index === this.sessionScopeIndex ? `[${label}]` : label;
		}).join(" ");
		const title = this.runtime.theme.fg(
			this.focus === "sessions" ? "borderAccent" : "accent",
			this.runtime.theme.bold("Sessions"),
		);
		return `${title}: ${values}`;
	}

	private renderHints(width: number): string {
		const hints: string[] = [];
		const narrow = this.layoutForWidth(this.lastWidth) === "narrow";
		if (this.focus === "range") {
			hints.push(rawKeyHint("left/right", "range"));
		} else if (this.focus === "sessions") {
			hints.push(rawKeyHint("left/right", "sessions"));
		} else if (this.focus === "agents") {
			hints.push(
				bindingPairHint(
					this.runtime.keybindings,
					"tui.select.up",
					"tui.select.down",
					"select",
				),
			);
			if (narrow) {
				hints.push(
					bindingHint(this.runtime.keybindings, "tui.select.confirm", "open"),
				);
			}
		} else {
			hints.push(
				bindingPairHint(
					this.runtime.keybindings,
					"tui.select.up",
					"tui.select.down",
					"scroll",
				),
				bindingPairHint(
					this.runtime.keybindings,
					"tui.select.pageUp",
					"tui.select.pageDown",
					"",
				),
				rawKeyHint("left/right", "move"),
			);
		}
		if (this.availableFocusZones().length > 1) {
			hints.push(rawKeyHint("Tab", "focus"));
		}
		hints.push(
			narrow && this.narrowPane === "table"
				? rawKeyHint("Esc", "back")
				: rawKeyHint("Esc", "close"),
		);
		return truncateToWidth(hints.filter(Boolean).join(" · "), width, "…");
	}

	private handleFocusedInput(data: string): boolean {
		switch (this.focus) {
			case "range":
				return this.handleRangeInput(data);
			case "sessions":
				return this.handleSessionInput(data);
			case "agents":
				return this.handleAgentInput(data);
			case "table":
				return this.handleTableInput(data);
		}
	}

	private handleRangeInput(data: string): boolean {
		if (matchesKey(data, Key.left)) {
			return this.selectRange(this.rangeIndex - 1);
		}
		if (matchesKey(data, Key.right)) {
			return this.selectRange(this.rangeIndex + 1);
		}
		return false;
	}

	private handleSessionInput(data: string): boolean {
		if (matchesKey(data, Key.left)) {
			return this.selectSessionScope(this.sessionScopeIndex - 1);
		}
		if (matchesKey(data, Key.right)) {
			return this.selectSessionScope(this.sessionScopeIndex + 1);
		}
		return false;
	}

	private handleAgentInput(data: string): boolean {
		if (this.matchesAction(data, "tui.select.up", Key.up)) {
			return this.selectAgent(-1);
		}
		if (this.matchesAction(data, "tui.select.down", Key.down)) {
			return this.selectAgent(1);
		}
		return false;
	}

	private handleTableInput(data: string): boolean {
		if (matchesKey(data, Key.left)) {
			this.tableHorizontalOffset = Math.max(
				0,
				this.tableHorizontalOffset - HORIZONTAL_SCROLL_STEP,
			);
			return true;
		}
		if (matchesKey(data, Key.right)) {
			this.tableHorizontalOffset += HORIZONTAL_SCROLL_STEP;
			return true;
		}
		if (this.matchesAction(data, "tui.select.up", Key.up)) {
			this.tableVerticalOffset = Math.max(0, this.tableVerticalOffset - 1);
			return true;
		}
		if (this.matchesAction(data, "tui.select.down", Key.down)) {
			this.tableVerticalOffset += 1;
			return true;
		}
		if (this.matchesAction(data, "tui.select.pageUp", Key.pageUp)) {
			this.tableVerticalOffset = Math.max(
				0,
				this.tableVerticalOffset - this.tableViewport,
			);
			return true;
		}
		if (this.matchesAction(data, "tui.select.pageDown", Key.pageDown)) {
			this.tableVerticalOffset += this.tableViewport;
			return true;
		}
		return false;
	}

	private selectRange(index: number): boolean {
		const next = Math.max(0, Math.min(USAGE_RANGES.length - 1, index));
		if (next === this.rangeIndex) {
			return false;
		}
		this.rangeIndex = next;
		if (this.selectedAgentId !== undefined) {
			const allAgents = this.currentScope()[this.currentRange()].agentIds;
			if (!allAgents.includes(this.selectedAgentId)) {
				this.selectedAgentId = undefined;
			}
		}
		this.resetTableScroll();
		return true;
	}

	private selectSessionScope(index: number): boolean {
		const next = Math.max(0, Math.min(USAGE_SESSION_SCOPES.length - 1, index));
		if (next === this.sessionScopeIndex) {
			return false;
		}
		this.sessionScopeIndex = next;
		if (this.selectedAgentId !== undefined) {
			const allAgents = this.currentScope()[this.currentRange()].agentIds;
			if (!allAgents.includes(this.selectedAgentId)) {
				this.selectedAgentId = undefined;
			}
		}
		this.resetTableScroll();
		return true;
	}

	private selectAgent(offset: number): boolean {
		const range = this.currentScope()[this.currentRange()];
		const choices: Array<string | undefined> = [undefined, ...range.agentIds];
		const current = Math.max(0, choices.indexOf(this.selectedAgentId));
		const next = Math.max(0, Math.min(choices.length - 1, current + offset));
		if (next === current) {
			return false;
		}
		this.selectedAgentId = choices[next];
		this.resetTableScroll();
		return true;
	}

	private currentRange(): (typeof USAGE_RANGES)[number] {
		return USAGE_RANGES[this.rangeIndex] ?? "7d";
	}

	private currentScope() {
		return this.sessionScopeIndex === 0
			? this.snapshot.current
			: this.snapshot.all;
	}

	private currentView() {
		const range = this.currentScope()[this.currentRange()];
		return {
			agentIds: range.agentIds,
			rows:
				this.selectedAgentId === undefined
					? range.rows
					: (range.agentRows.get(this.selectedAgentId) ?? []),
		};
	}

	private layoutForWidth(width: number): "wide" | "narrow" {
		return width >= WIDE_MINIMUM_WIDTH ? "wide" : "narrow";
	}

	private availableFocusZones(): readonly UsageFocusZone[] {
		if (this.layoutForWidth(this.lastWidth) === "wide") {
			return ["range", "sessions", "agents", "table"];
		}
		return this.narrowPane === "agents"
			? ["range", "sessions", "agents"]
			: ["range", "sessions", "table"];
	}

	private cycleFocus(delta: -1 | 1): void {
		const zones = this.availableFocusZones();
		const current = Math.max(0, zones.indexOf(this.focus));
		this.focus =
			zones[(current + delta + zones.length) % zones.length] ?? "range";
	}

	private normalizeFocus(): void {
		const zones = this.availableFocusZones();
		if (!zones.includes(this.focus)) {
			this.focus = zones[0] ?? "range";
		}
	}

	private syncTableViewport(table: ReturnType<typeof renderTablePane>): void {
		this.tableVerticalOffset = table.verticalOffset;
		this.tableHorizontalOffset = table.horizontalOffset;
		this.tableViewport = Math.max(1, table.verticalViewport);
	}

	private resetTableScroll(): void {
		this.tableVerticalOffset = 0;
		this.tableHorizontalOffset = 0;
	}

	private matchesAction(
		data: string,
		action: string,
		fallback: string,
	): boolean {
		return (
			this.runtime?.keybindings.matches(data, action as never) ??
			matchesKey(data, fallback as never)
		);
	}

	private requestRender(): void {
		this.runtime?.tui.requestRender();
	}
}

function bindingHint(
	keybindings: KeybindingsManager,
	keybinding: Keybinding,
	description: string,
): string {
	const key = keybindings.getKeys(keybinding)[0];
	return key === undefined ? "" : rawKeyHint(key, description);
}

function bindingPairHint(
	keybindings: KeybindingsManager,
	first: Keybinding,
	second: Keybinding,
	description: string,
): string {
	const keys = [
		keybindings.getKeys(first)[0],
		keybindings.getKeys(second)[0],
	].filter((key) => key !== undefined);
	return keys.length === 0 ? "" : rawKeyHint(keys.join("/"), description);
}

function border(
	left: string,
	right: string,
	width: number,
	label = "",
): string {
	const inside = Math.max(0, width - 2);
	const clippedLabel = truncateToWidth(label, inside, "");
	const fill = "─".repeat(Math.max(0, inside - visibleWidth(clippedLabel)));
	return `${left}${clippedLabel}${fill}${right}`;
}
