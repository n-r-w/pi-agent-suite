import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ManagementProjectionView } from "../projection";
import {
	AGENT_STATUS_ICONS,
	type AgentStatusCounts,
	countAgentStatuses,
} from "./status-summary";

const STATUS_WIDGET_KEY = "subagents-status";

/** Supplies immutable hierarchy revisions to the main-window status indicator. */
export interface SubagentStatusSource {
	getView(): ManagementProjectionView;
	subscribe(listener: (view: ManagementProjectionView) => void): () => void;
}

/** Renders the upper separator and one width-bounded status row above Pi's editor. */
class SubagentStatusComponent implements Component {
	public constructor(
		private readonly counts: AgentStatusCounts,
		private readonly theme: Theme,
	) {}

	/** Derives both rows from the current terminal width without retaining layout state. */
	public render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		const status = `Agents: ${this.theme.fg("accent", AGENT_STATUS_ICONS.running)} ${this.counts.running} · ${this.theme.fg("success", AGENT_STATUS_ICONS.done)} ${this.counts.done} · ${this.theme.fg("error", AGENT_STATUS_ICONS.failed)} ${this.counts.failed} · ${this.theme.fg("warning", AGENT_STATUS_ICONS.aborted)} ${this.counts.aborted} · Ctrl+Shift+G`;
		return ["─".repeat(width), truncateToWidth(status, width, "…")];
	}

	/** Invalidates no cache because every render uses the supplied width directly. */
	public invalidate(): void {}
}

/** Installs the main-window indicator and returns its lifecycle cleanup. */
export function installSubagentStatusIndicator(
	ui: ExtensionContext["ui"],
	source: SubagentStatusSource,
): () => void {
	let visible = false;
	const publish = (view: ManagementProjectionView): void => {
		if (view.nodes.length === 0) {
			if (visible) {
				ui.setWidget(STATUS_WIDGET_KEY, undefined);
				visible = false;
			}
			return;
		}
		const counts = countAgentStatuses(view.nodes);
		ui.setWidget(
			STATUS_WIDGET_KEY,
			(_tui, theme) => new SubagentStatusComponent(counts, theme),
		);
		visible = true;
	};

	publish(source.getView());
	const unsubscribe = source.subscribe(publish);
	return () => {
		unsubscribe();
		if (visible) {
			ui.setWidget(STATUS_WIDGET_KEY, undefined);
		}
	};
}
