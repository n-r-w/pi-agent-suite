import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acquireSessionStatusRow } from "../../shared/session-status-panel";
import { normalizeTerminalDisplayText } from "../../shared/terminal-display-text";
import type { WorkflowState } from "./workflow";

/** Identifies one optional sentence-ending period in the compact row. */
const TRAILING_PERIOD_PATTERN = /\.$/u;

/** Identifies the Workflow producer inside the shared session-status panel. */
const WORKFLOW_STATUS_ROW_KEY = "workflow";

/** Keeps the Workflow row below the Agents row. */
const WORKFLOW_STATUS_ROW_ORDER = 20;

/** Publishes the current workflow row without exposing shared-panel ownership. */
export interface WorkflowStatusIndicator {
	/** Replaces or hides the row for the effective workflow state. */
	publish(state: WorkflowState | undefined): void;
	/** Releases the Workflow row during session shutdown. */
	dispose(): void;
}

/** Builds one terminal-safe row from the active route stage. */
function renderWorkflowStatus(state: WorkflowState): string {
	const activeStageId = state.route.at(-1);
	const activeStage = state.workflow.stages.find(
		({ id }) => id === activeStageId,
	);
	if (activeStage === undefined) {
		throw new Error(
			`workflow ${state.workflow.id} route has no active stage definition`,
		);
	}
	return normalizeTerminalDisplayText(
		`Workflow: ${state.workflow.id} · ${activeStage.description}`,
	).replace(TRAILING_PERIOD_PATTERN, "");
}

/** Installs the Workflow producer in the shared session-status panel. */
export function installWorkflowStatusIndicator(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"],
): WorkflowStatusIndicator {
	const row = acquireSessionStatusRow(pi, ui, {
		key: WORKFLOW_STATUS_ROW_KEY,
		order: WORKFLOW_STATUS_ROW_ORDER,
	});
	return {
		publish: (state) => {
			if (state === undefined) {
				row.set(undefined);
				return;
			}
			const status = renderWorkflowStatus(state);
			row.set((theme) => theme.fg("dim", status));
		},
		dispose: () => row.dispose(),
	};
}
