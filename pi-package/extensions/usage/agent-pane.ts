import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	calculateScrollThumb,
	isScrollThumbRow,
	type ScrollMetrics,
} from "../../shared/tui/scroll-indicator";

export interface AgentPaneOptions {
	readonly width: number;
	readonly height: number;
	readonly focused: boolean;
	readonly theme: Theme;
}

export interface AgentPaneRender {
	readonly lines: readonly string[];
	readonly scroll: readonly string[];
	readonly offset: number;
}

/** Renders the selected agent and keeps it inside the available viewport. */
export function renderAgentPane(
	agentIds: readonly string[],
	selectedAgentId: string | undefined,
	options: AgentPaneOptions,
): AgentPaneRender {
	const { focused, height, theme, width } = options;
	const choices: ReadonlyArray<string | undefined> = [undefined, ...agentIds];
	const selectedIndex = Math.max(0, choices.indexOf(selectedAgentId));
	const viewport = Math.max(0, height - 1);
	const maximumOffset = Math.max(0, choices.length - viewport);
	const offset = Math.min(
		maximumOffset,
		Math.max(0, selectedIndex - viewport + 1),
	);
	const visibleChoices = choices.slice(offset, offset + viewport);
	const metrics: ScrollMetrics = { offset, total: choices.length, viewport };
	const thumb = calculateScrollThumb(metrics, viewport);
	const label = theme.bold("Agents");
	const title = theme.fg(focused ? "borderAccent" : "accent", label);
	return {
		lines: [
			padToWidth(title, width),
			...visibleChoices.map((agentId) => {
				const row = padPlainToWidth(` ${agentId ?? "All agents"}`, width);
				if (selectedAgentId !== agentId) {
					return row;
				}
				return theme.bg(focused ? "selectedBg" : "toolPendingBg", row);
			}),
		],
		scroll: Array.from({ length: height }, (_, row) => {
			if (row === 0 || thumb === undefined) {
				return " ";
			}
			if (!isScrollThumbRow(thumb, row - 1)) {
				return theme.fg("muted", "░");
			}
			return theme.fg(focused ? "border" : "borderMuted", "█");
		}),
		offset,
	};
}

/** Fits pane content to an exact terminal width. */
export function padToWidth(text: string, width: number): string {
	const boundedWidth = Math.max(0, width);
	const clipped = truncateToWidth(text, boundedWidth, "");
	return `${clipped}${" ".repeat(Math.max(0, boundedWidth - visibleWidth(clipped)))}`;
}

function padPlainToWidth(text: string, width: number): string {
	const boundedWidth = Math.max(0, width);
	const clipped = clipPlainSegment(text, boundedWidth);
	return `${clipped}${" ".repeat(Math.max(0, boundedWidth - visibleWidth(clipped)))}`;
}

// Plain text is clipped before background styling so no ANSI reset can end the row background early.
function clipPlainSegment(value: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(value) <= maxWidth) {
		return value;
	}
	const ellipsis = "…";
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const fragment = sliceByColumn(value, 0, maxWidth, true);
		return visibleWidth(fragment) > 0
			? fragment
			: sliceByColumn(ellipsis, 0, maxWidth, true);
	}
	return `${sliceByColumn(value, 0, maxWidth - ellipsisWidth, true)}${ellipsis}`;
}
