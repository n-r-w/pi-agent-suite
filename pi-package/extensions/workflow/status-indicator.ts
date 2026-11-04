import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	acquireSessionStatusRow,
	type SessionStatusRowRenderer,
} from "../../shared/session-status-panel";
import { renderWorkflowStatusText } from "../../shared/workflow-status-text";
import { getTopWorkflow, type WorkflowChain } from "./workflow";

/** Identifies the Workflow producer inside the shared session-status panel. */
const WORKFLOW_STATUS_ROW_KEY = "workflow";

/** Keeps the Workflow row below the Agents row. */
const WORKFLOW_STATUS_ROW_ORDER = 20;

/** Publishes the current workflow row without exposing shared-panel ownership. */
export interface WorkflowStatusIndicator {
	/** Replaces or hides the row for the effective workflow state. */
	publish(chain: WorkflowChain): void;
	/** Releases the Workflow row during session shutdown. */
	dispose(): void;
}

/** Creates a width-aware row for the chain and its active route stage. */
function createWorkflowStatusRenderer(
	chain: WorkflowChain,
): SessionStatusRowRenderer | undefined {
	const state = getTopWorkflow(chain);
	if (state === undefined) {
		return undefined;
	}
	const activeStageId = state.route.at(-1);
	const activeStage = state.workflow.stages.find(
		({ id }) => id === activeStageId,
	);
	if (activeStage === undefined) {
		throw new Error(
			`workflow ${state.workflow.id} route has no active stage definition`,
		);
	}
	const workflowPath = chain.map(({ workflow }) => workflow.id).join("➡");
	return (theme, width) =>
		theme.fg(
			"dim",
			renderWorkflowStatusText(workflowPath, activeStage.description, width),
		);
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
		publish: (chain) => row.set(createWorkflowStatusRenderer(chain)),
		dispose: () => row.dispose(),
	};
}
