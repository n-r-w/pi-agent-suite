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
	 * Proves the workflows allowlist restricts catalog state but never dynamic state.
	 * Input and expected output: workflows: [] hides catalog state while preserving dynamic state and transition.
	 * Edge case: the same policy is evaluated against both explicit state sources.
	 * Dependencies: source assignment and catalog policy membership.
	 */
	test("keeps dynamic state independent from the catalog allowlist", () => {
		const delivery = workflow("delivery");
		const policy = { kind: "resolved", policy: [] } as const;
		const catalogState = resolveWorkflowAvailability({
			catalog: [delivery],
			catalogValid: true,
			policy,
			state: activateWorkflow(delivery),
		});
		const dynamicState = createWorkflow({ ...delivery, id: "dynamic" });
		const dynamicResult = resolveWorkflowAvailability({
			catalog: [delivery],
			catalogValid: true,
			policy,
			state: dynamicState,
		});

		expect(toolNames(catalogState)).toEqual([WORKFLOW_CREATE_TOOL]);
		expect(catalogState.projectedState).toBeUndefined();
		expect(toolNames(dynamicResult)).toEqual([
			WORKFLOW_CREATE_TOOL,
			WORKFLOW_TRANSITION_TOOL,
		]);
		expect(dynamicResult.projectedState).toBe(dynamicState);
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
