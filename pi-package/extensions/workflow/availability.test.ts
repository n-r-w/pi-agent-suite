import { describe, expect, test } from "bun:test";
import { resolveWorkflowAvailability } from "./availability";
import {
	activateWorkflow,
	createWorkflow,
	validateWorkflowDefinition,
} from "./workflow";

/** Builds a single-stage final workflow for capability checks. */
function workflow(id: string) {
	return validateWorkflowDefinition(
		id,
		{
			description: id,
			stages: [
				{
					id: "only",
					description: "Only",
					prompt: "Work",
					initial: true,
					final: true,
				},
			],
			transitions: [],
		},
		"fixture",
	);
}

/** Sorts capability names independently of registration order. */
function names(result: ReturnType<typeof resolveWorkflowAvailability>) {
	return [...result.availableToolNames].sort();
}

describe("workflow availability", () => {
	test("offers creation alone before a workflow exists in an empty catalog", () => {
		const result = resolveWorkflowAvailability({
			catalog: [],
			catalogValid: true,
			policy: { kind: "resolved", policy: undefined },
			chain: [],
		});
		expect(names(result)).toEqual(["workflow_create"]);
		expect(result.projectedState).toBeUndefined();
	});

	test("offers dynamic stage tools on a final stage until exit", () => {
		const state = createWorkflow(workflow("dynamic"));
		const input = {
			catalog: [],
			catalogValid: true,
			policy: { kind: "resolved" as const, policy: undefined },
			chain: [state],
		};
		expect(names(resolveWorkflowAvailability(input))).toEqual([
			"workflow_create",
			"workflow_edit_stage",
			"workflow_exit",
			"workflow_get_stage",
			"workflow_transition",
		]);
		expect(names(resolveWorkflowAvailability({ ...input, chain: [] }))).toEqual(
			["workflow_create"],
		);
	});

	test("offers exit and transition before activation when an allowed catalog workflow exists", () => {
		const result = resolveWorkflowAvailability({
			catalog: [workflow("delivery")],
			catalogValid: true,
			policy: { kind: "resolved", policy: undefined },
			chain: [],
		});
		expect(names(result)).toEqual([
			"workflow_activate",
			"workflow_create",
			"workflow_exit",
			"workflow_transition",
		]);
		expect(result.activationOptions.map(({ id }) => id)).toEqual(["delivery"]);
	});

	test("keeps running workflows in activation options", () => {
		const delivery = workflow("delivery");
		const review = workflow("review");
		const catalog = [delivery, workflow("DELIVERY"), review];
		const chain = [activateWorkflow(delivery), activateWorkflow(review)];
		const result = resolveWorkflowAvailability({
			catalog,
			catalogValid: true,
			policy: { kind: "resolved", policy: undefined },
			chain,
		});
		expect(result.activationOptions.map(({ id }) => id)).toEqual([
			"delivery",
			"DELIVERY",
			"review",
		]);
		expect(result.projectedState).toBe(chain[1]);
	});

	test("keeps saved workflows independent from the catalog allowlist", () => {
		const state = activateWorkflow(workflow("saved"));
		const result = resolveWorkflowAvailability({
			catalog: [workflow("delivery")],
			catalogValid: true,
			policy: { kind: "resolved", policy: [] },
			chain: [state],
		});
		expect(result.projectedState).toBe(state);
		expect(result.activationOptions).toEqual([]);
		expect(names(result)).toEqual([
			"workflow_create",
			"workflow_exit",
			"workflow_transition",
		]);
	});

	test("separates catalog failure from malformed policy", () => {
		const state = createWorkflow(workflow("saved"));
		const input = { catalog: [], catalogValid: false, chain: [state] };
		expect(
			names(
				resolveWorkflowAvailability({
					...input,
					policy: { kind: "resolved", policy: undefined },
				}),
			),
		).toEqual([
			"workflow_edit_stage",
			"workflow_exit",
			"workflow_get_stage",
			"workflow_transition",
		]);
		const denied = resolveWorkflowAvailability({
			...input,
			policy: { kind: "error", issue: "invalid policy" },
		});
		expect(names(denied)).toEqual([]);
		expect(denied.projectedState).toBeUndefined();
	});
});
