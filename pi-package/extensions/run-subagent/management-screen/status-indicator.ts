import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { acquireSessionStatusRow } from "../../../shared/session-status-panel";
import type { ManagementProjectionView } from "../projection";
import {
	AGENT_STATUS_ICONS,
	type AgentStatusCounts,
	countAgentStatuses,
} from "./status-summary";

/** Identifies the Agents producer inside the shared session-status panel. */
const AGENTS_STATUS_ROW_KEY = "agents";

/** Keeps the Agents row above later session-specific status rows. */
const AGENTS_STATUS_ROW_ORDER = 10;

/** Supplies immutable hierarchy revisions to the main-window status indicator. */
export interface SubagentStatusSource {
	getView(): ManagementProjectionView;
	subscribe(listener: (view: ManagementProjectionView) => void): () => void;
}

/** Builds the themed Agents row from one immutable hierarchy count snapshot. */
function renderAgentsStatus(counts: AgentStatusCounts, theme: Theme): string {
	return `Agents: ${theme.fg("accent", AGENT_STATUS_ICONS.running)} ${counts.running} · ${theme.fg("success", AGENT_STATUS_ICONS.done)} ${counts.done} · ${theme.fg("error", AGENT_STATUS_ICONS.failed)} ${counts.failed} · ${theme.fg("warning", AGENT_STATUS_ICONS.aborted)} ${counts.aborted} · Ctrl+Shift+G`;
}

/** Installs the Agents row and returns its subscription and row cleanup. */
export function installSubagentStatusIndicator(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"],
	source: SubagentStatusSource,
): () => void {
	const row = acquireSessionStatusRow(pi, ui, {
		key: AGENTS_STATUS_ROW_KEY,
		order: AGENTS_STATUS_ROW_ORDER,
	});
	const publish = (view: ManagementProjectionView): void => {
		if (view.nodes.length === 0) {
			row.set(undefined);
			return;
		}
		const counts = countAgentStatuses(view.nodes);
		row.set((theme) => renderAgentsStatus(counts, theme));
	};

	publish(source.getView());
	const unsubscribe = source.subscribe(publish);
	return () => {
		unsubscribe();
		row.dispose();
	};
}
