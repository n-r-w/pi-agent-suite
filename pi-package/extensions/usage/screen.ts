import {
	type Component,
	Key,
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
const FRAME_ROWS = 4;
const HORIZONTAL_SCROLL_STEP = 8;
const WIDE_FRAME_AND_SEPARATOR_WIDTH = 3;
const AGENT_WIDTH_DIVISOR = 3;

type UsageFocusZone = "range" | "agents" | "table";
type UsageNarrowPane = "agents" | "table";

export interface UsageScreenRuntime {
	readonly tui: TUI;
	readonly keybindings: KeybindingsManager;
}

/** Renders and navigates one immutable full-terminal usage snapshot. */
export class UsageScreen implements Component {
	private rangeIndex = 0;
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
		openedAt: number,
		private readonly close: () => void,
		private readonly runtime?: UsageScreenRuntime,
	) {
		this.snapshot = prepareUsageSnapshot(events, openedAt);
	}

	public render(width: number): string[] {
		this.lastWidth = width;
		this.normalizeFocus();
		const rowBudget = Math.max(1, this.runtime?.tui?.terminal?.rows ?? 24);
		if (width <= 2 || rowBudget <= FRAME_ROWS) {
			return Array.from({ length: rowBudget }, () =>
				"".padEnd(Math.max(0, width)),
			);
		}
		const contentHeight = rowBudget - FRAME_ROWS;
		const rangeLine = this.renderRange(Math.max(0, width - 2));
		return this.layoutForWidth(width) === "wide"
			? this.renderWide(width, contentHeight, rangeLine)
			: this.renderNarrow(width, contentHeight, rangeLine);
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
		});
		const table = renderTablePane(view.rows, {
			width: Math.max(0, tableWidth - 1),
			height,
			verticalOffset: this.tableVerticalOffset,
			horizontalOffset: this.tableHorizontalOffset,
			focused: this.focus === "table",
		});
		this.syncTableViewport(table);
		return [
			border("┌", "┐", width, "─ USAGE "),
			`│${rangeLine}│`,
			`├${"─".repeat(agentWidth)}┬${"─".repeat(tableWidth)}┤`,
			...Array.from(
				{ length: height },
				(_, row) =>
					`│${agents.lines[row] ?? padToWidth("", agentWidth - 1)}${agents.scroll[row] ?? " "}│${table.lines[row] ?? padToWidth("", tableWidth - 1)}${table.scroll[row] ?? " "}│`,
			),
			`└${"─".repeat(agentWidth)}┴${"─".repeat(tableWidth)}┘`,
		];
	}

	private renderNarrow(
		width: number,
		height: number,
		rangeLine: string,
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
					})
				: renderTablePane(view.rows, {
						width: contentWidth,
						height,
						verticalOffset: this.tableVerticalOffset,
						horizontalOffset: this.tableHorizontalOffset,
						focused: this.focus === "table",
					});
		if (this.narrowPane === "table") {
			this.syncTableViewport(pane as ReturnType<typeof renderTablePane>);
		}
		return [
			border("┌", "┐", width, "─ USAGE "),
			`│${rangeLine}│`,
			border("├", "┤", width),
			...Array.from(
				{ length: height },
				(_, row) =>
					`│${pane.lines[row] ?? padToWidth("", contentWidth)}${pane.scroll[row] ?? " "}│`,
			),
			border("└", "┘", width),
		];
	}

	private renderRange(width: number): string {
		const values = USAGE_RANGES.map((label, index) =>
			index === this.rangeIndex ? `[${label}]` : label,
		).join(" ");
		return padToWidth(
			`${this.focus === "range" ? "›" : " "} Range: ${values}`,
			width,
		);
	}

	private handleFocusedInput(data: string): boolean {
		switch (this.focus) {
			case "range":
				return this.handleRangeInput(data);
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
			const allAgents = this.snapshot[this.currentRange()].agentIds;
			if (!allAgents.includes(this.selectedAgentId)) {
				this.selectedAgentId = undefined;
			}
		}
		this.resetTableScroll();
		return true;
	}

	private selectAgent(offset: number): boolean {
		const range = this.snapshot[this.currentRange()];
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
		return USAGE_RANGES[this.rangeIndex] ?? "24h";
	}

	private currentView() {
		const range = this.snapshot[this.currentRange()];
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
			return ["range", "agents", "table"];
		}
		return this.narrowPane === "agents"
			? ["range", "agents"]
			: ["range", "table"];
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
