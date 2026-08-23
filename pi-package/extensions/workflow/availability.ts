import {
	isWorkflowAllowed,
	toWorkflowMatchKey,
	type WorkflowPolicyResolution,
} from "../../shared/workflow-policy.ts";
import type { WorkflowDefinition, WorkflowState } from "./workflow.ts";

export const WORKFLOW_CREATE_TOOL = "workflow_create";
export const WORKFLOW_ACTIVATE_TOOL = "workflow_activate";
export const WORKFLOW_GET_STAGE_TOOL = "workflow_get_stage";
export const WORKFLOW_EDIT_STAGE_TOOL = "workflow_edit_stage";
export const WORKFLOW_TRANSITION_TOOL = "workflow_transition";

export type WorkflowToolName =
	| typeof WORKFLOW_CREATE_TOOL
	| typeof WORKFLOW_ACTIVATE_TOOL
	| typeof WORKFLOW_GET_STAGE_TOOL
	| typeof WORKFLOW_EDIT_STAGE_TOOL
	| typeof WORKFLOW_TRANSITION_TOOL;

/** Inputs required to resolve workflow capabilities without using Pi runtime state. */
export interface WorkflowAvailabilityInput {
	readonly catalog: readonly WorkflowDefinition[];
	readonly catalogValid: boolean;
	readonly policy: WorkflowPolicyResolution;
	readonly state: WorkflowState | undefined;
}

/** One internally consistent view of workflow tools and provider-context data. */
export interface WorkflowAvailability {
	readonly activationOptions: readonly WorkflowDefinition[];
	readonly projectedState: WorkflowState | undefined;
	readonly availableToolNames: ReadonlySet<WorkflowToolName>;
}

/** Resolves workflow capabilities from catalog, policy, and session state. */
export function resolveWorkflowAvailability(
	input: WorkflowAvailabilityInput,
): WorkflowAvailability {
	// A malformed policy cannot safely authorize any catalog or session capability.
	if (input.policy.kind === "error") {
		return {
			activationOptions: [],
			projectedState: undefined,
			availableToolNames: new Set(),
		};
	}

	const policy = input.policy.policy;
	// Catalog errors block capabilities that require a complete ID namespace.
	const allowedCatalog = input.catalogValid
		? input.catalog.filter(({ id }) => isWorkflowAllowed(policy, id))
		: [];

	// A resolved workflow policy restricts new catalog activation, not the saved active state.
	const projectedState = input.state;

	// Only the exact NFC workflow identity is excluded from activation options.
	const activeWorkflowKey =
		projectedState === undefined
			? undefined
			: toWorkflowMatchKey(projectedState.workflow.id);
	const activationOptions = allowedCatalog.filter(
		({ id }) => toWorkflowMatchKey(id) !== activeWorkflowKey,
	);
	const availableToolNames = new Set<WorkflowToolName>();
	if (input.catalogValid) {
		availableToolNames.add(WORKFLOW_CREATE_TOOL);
	}
	if (activationOptions.length > 0) {
		availableToolNames.add(WORKFLOW_ACTIVATE_TOOL);
	}
	if (
		projectedState?.source === "dynamic" &&
		projectedState.status === "active"
	) {
		availableToolNames.add(WORKFLOW_GET_STAGE_TOOL);
		availableToolNames.add(WORKFLOW_EDIT_STAGE_TOOL);
	}
	if (projectedState !== undefined || allowedCatalog.length > 0) {
		availableToolNames.add(WORKFLOW_TRANSITION_TOOL);
	}

	return { activationOptions, projectedState, availableToolNames };
}
