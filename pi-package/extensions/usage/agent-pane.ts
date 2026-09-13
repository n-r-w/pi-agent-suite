import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	calculateScrollThumb,
	isScrollThumbRow,
	type ScrollMetrics,
} from "../../shared/tui/scroll-indicator";

export interface AgentPaneOptions {
	readonly width: number;
	readonly height: number;
	readonly focused: boolean;
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
	const { focused, height, width } = options;
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
	return {
		lines: [
			padToWidth(`${focused ? "›" : " "} Agents`, width),
			...visibleChoices.map((agentId) =>
				padToWidth(
					`${selectedAgentId === agentId ? "●" : " "} ${agentId ?? "All agents"}`,
					width,
				),
			),
		],
		scroll: Array.from({ length: height }, (_, row) => {
			if (row === 0 || thumb === undefined) {
				return " ";
			}
			return isScrollThumbRow(thumb, row - 1) ? "█" : "░";
		}),
		offset,
	};
}

/** Fits plain pane content to an exact terminal width. */
export function padToWidth(text: string, width: number): string {
	const boundedWidth = Math.max(0, width);
	const clipped = truncateToWidth(text, boundedWidth, "");
	return `${clipped}${" ".repeat(Math.max(0, boundedWidth - visibleWidth(clipped)))}`;
}
