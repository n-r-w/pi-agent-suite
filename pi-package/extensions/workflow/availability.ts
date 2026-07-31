import {
	isWorkflowAllowed,
	type WorkflowPolicyResolution,
} from "../../shared/workflow-policy.ts";
import type { WorkflowDefinition, WorkflowState } from "./workflow.ts";

export const WORKFLOW_CREATE_TOOL = "workflow_create";
export const WORKFLOW_ACTIVATE_TOOL = "workflow_activate";
export const WORKFLOW_TRANSITION_TOOL = "workflow_transition";

export type WorkflowToolName =
	| typeof WORKFLOW_CREATE_TOOL
	| typeof WORKFLOW_ACTIVATE_TOOL
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

	// The workflows allowlist applies only to catalog state; dynamic state remains projectable.
	const projectedState =
		input.state !== undefined &&
		(input.state.source === "dynamic" ||
			isWorkflowAllowed(policy, input.state.workflow.id))
			? input.state
			: undefined;

	// The active catalog workflow is not a replacement candidate for itself.
	const activationOptions = allowedCatalog.filter(
		({ id }) => id !== projectedState?.workflow.id,
	);
	const availableToolNames = new Set<WorkflowToolName>();
	if (input.catalogValid) {
		availableToolNames.add(WORKFLOW_CREATE_TOOL);
	}
	if (activationOptions.length > 0) {
		availableToolNames.add(WORKFLOW_ACTIVATE_TOOL);
	}
	if (projectedState !== undefined || allowedCatalog.length > 0) {
		availableToolNames.add(WORKFLOW_TRANSITION_TOOL);
	}

	return { activationOptions, projectedState, availableToolNames };
}
