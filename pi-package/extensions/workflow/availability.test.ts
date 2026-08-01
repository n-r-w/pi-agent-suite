import { describe, expect, test } from "bun:test";
import {
	resolveWorkflowAvailability,
	WORKFLOW_ACTIVATE_TOOL,
	WORKFLOW_CREATE_TOOL,
	WORKFLOW_TRANSITION_TOOL,
} from "./availability";
import {
	activateWorkflow,
	createWorkflow,
	validateWorkflowDefinition,
	type WorkflowDefinition,
} from "./workflow";

/** Builds one valid workflow for availability inputs without bypassing graph validation. */
function workflow(id: string): WorkflowDefinition {
	return validateWorkflowDefinition(
		id,
		{
			description: `${id} workflow`,
			stages: [
				{
					id: "only",
					description: "Only stage",
					prompt: "Complete the workflow.",
					initial: true,
					final: true,
				},
			],
			transitions: [],
		},
		`${id}.yaml`,
	);
}

/** Converts the finite tool-name set into a stable assertion shape. */
function toolNames(
	result: ReturnType<typeof resolveWorkflowAvailability>,
): string[] {
	return [...result.availableToolNames].sort();
}

describe("workflow availability", () => {
	/**
	 * Proves a valid empty catalog enables creation without exposing unusable activation or transition tools.
	 * Input and expected output: empty catalog, resolved unrestricted policy, and no state produce create only.
	 * Edge case: no activation options and no projected state are returned.
	 * Dependencies: the pure availability resolver only.
	 */
	test("keeps creation available for an empty catalog", () => {
		const result = resolveWorkflowAvailability({
			catalog: [],
			catalogValid: true,
			policy: { kind: "resolved", policy: undefined },
			state: undefined,
		});

		expect(toolNames(result)).toEqual([WORKFLOW_CREATE_TOOL]);
		expect(result.activationOptions).toEqual([]);
		expect(result.projectedState).toBeUndefined();
	});

	/**
	 * Proves ready-made workflows provide activation and transition sources before activation.
	 * Input and expected output: two allowed catalog definitions produce all three tools and both options.
	 * Edge case: transition is available without state because an allowed ready-made workflow can be activated.
	 * Dependencies: catalog policy membership and the pure availability resolver.
	 */
	test("exposes all tools for allowed catalog workflows", () => {
		const catalog = [workflow("delivery"), workflow("review")];
		const result = resolveWorkflowAvailability({
			catalog,
			catalogValid: true,
			policy: { kind: "resolved", policy: undefined },
			state: undefined,
		});

		expect(toolNames(result)).toEqual([
			WORKFLOW_ACTIVATE_TOOL,
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
		expect(result.activationOptions.map(({ id }) => id)).toEqual([
			"delivery",
			"review",
		]);
	});

	/**
	 * Proves the active catalog workflow is removed from options and disables activation when no alternative remains.
	 * Input and expected output: one allowed workflow already active produces create and transition only.
	 * Edge case: the active state remains projectable even though activation options are empty.
	 * Dependencies: catalog activation and the pure availability resolver.
	 */
	test("disables activation without an alternative catalog workflow", () => {
		const delivery = workflow("delivery");
		const state = activateWorkflow(delivery);
		const result = resolveWorkflowAvailability({
			catalog: [delivery],
			catalogValid: true,
			policy: { kind: "resolved", policy: ["delivery"] },
			state,
		});

		expect(toolNames(result)).toEqual([
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
		expect(result.activationOptions).toEqual([]);
		expect(result.projectedState).toBe(state);
	});

	/**
	 * Proves case variants remain separate activation identities without hiding active state.
	 * Input and expected output: policy delivery preserves active DELIVERY and exposes catalog delivery for activation.
	 * Edge case: the active case variant does not exclude the allowed catalog identity.
	 * Dependencies: exact NFC workflow identity and the pure availability resolver.
	 */
	test("keeps case variants as separate workflow identities", () => {
		const state = activateWorkflow(workflow("DELIVERY"));
		const delivery = workflow("delivery");
		const result = resolveWorkflowAvailability({
			catalog: [delivery],
			catalogValid: true,
			policy: { kind: "resolved", policy: ["delivery"] },
			state,
		});

		expect(result.projectedState).toBe(state);
		expect(result.activationOptions).toEqual([delivery]);
		expect(toolNames(result)).toEqual([
			WORKFLOW_ACTIVATE_TOOL,
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
	});

	/**
	 * Proves the workflows allowlist restricts new activation but never active state.
	 * Input and expected output: policy review preserves active delivery and exposes only review for activation.
	 * Edge case: dynamic state remains projectable when the policy allows no catalog workflow.
	 * Dependencies: state-source assignment, catalog membership, and activation filtering.
	 */
	test("keeps active state independent from the catalog allowlist", () => {
		const delivery = workflow("delivery");
		const review = workflow("review");
		const catalogState = activateWorkflow(delivery);
		const catalogResult = resolveWorkflowAvailability({
			catalog: [delivery, review],
			catalogValid: true,
			policy: { kind: "resolved", policy: ["review"] },
			state: catalogState,
		});
		const dynamicState = createWorkflow({ ...delivery, id: "dynamic" });
		const dynamicResult = resolveWorkflowAvailability({
			catalog: [delivery],
			catalogValid: true,
			policy: { kind: "resolved", policy: [] },
			state: dynamicState,
		});

		expect(catalogResult.projectedState).toBe(catalogState);
		expect(catalogResult.activationOptions).toEqual([review]);
		expect(toolNames(catalogResult)).toEqual([
			WORKFLOW_ACTIVATE_TOOL,
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
		expect(dynamicResult.projectedState).toBe(dynamicState);
		expect(toolNames(dynamicResult)).toEqual([
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
	});

	/**
	 * Proves catalog and policy errors disable only capabilities that cannot be evaluated safely.
	 * Input and expected output: an invalid catalog with dynamic state keeps transition; a policy error exposes nothing.
	 * Edge case: dynamic state survives catalog failure but cannot authorize creation.
	 * Dependencies: source-specific projection and the pure availability resolver.
	 */
	test("separates catalog failure from policy failure", () => {
		const dynamicState = createWorkflow(workflow("dynamic"));
		const catalogFailure = resolveWorkflowAvailability({
			catalog: [],
			catalogValid: false,
			policy: { kind: "resolved", policy: undefined },
			state: dynamicState,
		});
		const policyFailure = resolveWorkflowAvailability({
			catalog: [],
			catalogValid: true,
			policy: { kind: "error", issue: "invalid workflow policy" },
			state: dynamicState,
		});

		expect(toolNames(catalogFailure)).toEqual([WORKFLOW_TRANSITION_TOOL]);
		expect(catalogFailure.projectedState).toBe(dynamicState);
		expect(toolNames(policyFailure)).toEqual([]);
		expect(policyFailure.projectedState).toBeUndefined();
	});
});
