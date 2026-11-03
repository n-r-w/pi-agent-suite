import type { WorkflowKind } from "./kinds";
import type { WorkflowDefinition } from "./workflow";

/** Supplies the renderer with one non-empty kind or unclassified option group. */
export interface WorkflowActivationGroup {
	readonly kind?: WorkflowKind;
	readonly workflows: readonly WorkflowDefinition[];
}

/** Groups already allowed, non-running workflows without changing their relative order. */
export function groupWorkflowActivationOptions(
	workflows: readonly WorkflowDefinition[],
	kinds: readonly WorkflowKind[],
): readonly WorkflowActivationGroup[] {
	const groups: WorkflowActivationGroup[] = [];
	for (const kind of kinds) {
		const members = workflows.filter((workflow) => workflow.kind === kind.id);
		if (members.length > 0) {
			groups.push({ kind, workflows: members });
		}
	}
	const unclassified = workflows.filter(({ kind }) => kind === undefined);
	if (unclassified.length > 0) {
		groups.push({ workflows: unclassified });
	}
	return groups;
}
