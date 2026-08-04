import { describe, expect, test } from "bun:test";
import {
	activateWorkflow,
	createWorkflow,
	getAvailableTransitions,
	getStageStatuses,
	replayWorkflowState,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	validateWorkflowDefinition,
} from "./workflow";

const SOURCE = "/tmp/workflow.yaml";

/** Builds the branching workflow used to exercise graph and route rules. */
function validValue(): unknown {
	return {
		description: "Software delivery",
		prompt: "\nFollow shared rules.\n  Preserve this indentation.\n",
		stages: [
			{ id: "a", description: "A", prompt: "Prompt A", initial: true },
			{
				id: "b",
				description: "B",
				prompt: "\nFirst line\n  indented second line\n",
			},
			{ id: "c", description: "C", prompt: "Prompt C" },
			{ id: "d", description: "D", prompt: "Prompt D" },
			{ id: "f", description: "F", prompt: "Prompt F", final: true },
		],
		transitions: [
			{ from: "a", to: "b", type: "advance" },
			{ from: "a", to: "c", type: "advance" },
			{ from: "b", to: "d", type: "advance" },
			{ from: "c", to: "d", type: "advance" },
			{ from: "d", to: "f", type: "advance" },
			{ from: "f", to: "b", type: "rework" },
		],
	};
}

/** Replaces fields in the valid raw definition without bypassing boundary validation. */
function changedValue(changes: Record<string, unknown>): unknown {
	return { ...(validValue() as Record<string, unknown>), ...changes };
}

describe("workflow definition validation", () => {
	/** Proves valid closed YAML-domain input becomes a normalized typed graph. */
	test("accepts a valid branching workflow", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		expect(workflow.id).toBe("delivery");
		expect(workflow.prompt).toBe(
			"Follow shared rules.\n  Preserve this indentation.",
		);
		expect(workflow.stages[1]).toEqual({
			id: "b",
			description: "B",
			prompt: "First line\n  indented second line",
			initial: false,
			final: false,
		});
	});

	/** Proves catalog YAML can define independent workflow and stage model settings. */
	test("accepts optional model settings at workflow and stage levels", () => {
		const value = validValue() as {
			stages: Record<string, unknown>[];
		};
		const firstStage = value.stages[0];
		if (firstStage === undefined) {
			throw new Error("valid workflow fixture must contain an initial stage");
		}
		firstStage["model"] = { thinking: "xhigh" };

		const workflow = validateWorkflowDefinition(
			"delivery",
			{
				...value,
				model: { id: "openai/gpt-test", thinking: "high" },
			},
			SOURCE,
		);

		expect(workflow.model).toEqual({
			id: "openai/gpt-test",
			thinking: "high",
		});
		expect(workflow.stages[0]?.model).toEqual({ thinking: "xhigh" });
	});

	/**
	 * Proves workflow_create accepts one closed object and delegates graph rules to the workflow validator.
	 * Input and expected output: a valid object including id becomes one normalized definition; unknown keys and invalid graphs fail.
	 * Edge cases: the dynamic root rejects both an unknown field and a padded id.
	 * Dependencies: the shared workflow definition and graph validators.
	 */
	test("validates complete dynamic workflow definitions", () => {
		const created = validateCreatedWorkflowDefinition(
			{ id: "delivery", ...(validValue() as Record<string, unknown>) },
			"workflow_create",
		);
		expect(created.id).toBe("delivery");
		expect(created.stages).toHaveLength(5);
		expect(() =>
			validateCreatedWorkflowDefinition(
				{
					id: "delivery",
					...(validValue() as Record<string, unknown>),
					extra: true,
				},
				"workflow_create",
			),
		).toThrow("workflow_create");
		expect(() =>
			validateCreatedWorkflowDefinition(
				{ id: " delivery", ...(validValue() as Record<string, unknown>) },
				"workflow_create",
			),
		).toThrow("id must be");
		expect(() =>
			validateCreatedWorkflowDefinition(
				{
					id: "delivery",
					...(changedValue({ transitions: [] }) as Record<string, unknown>),
				},
				"workflow_create",
			),
		).toThrow("workflow_create");
	});

	/**
	 * Proves optional workflow prompt normalization distinguishes absent guidance from invalid input.
	 * Input and expected output: omitted and whitespace-only prompts are omitted; a non-string prompt is rejected.
	 * Edge case: whitespace-only multiline text becomes absence after trimming.
	 * Dependencies: the workflow YAML-domain validator only.
	 */
	test("normalizes an optional workflow prompt", () => {
		expect(
			validateWorkflowDefinition(
				"delivery",
				changedValue({ prompt: " \n\t " }),
				SOURCE,
			),
		).not.toHaveProperty("prompt");
		expect(
			validateWorkflowDefinition(
				"delivery",
				changedValue({ prompt: undefined }),
				SOURCE,
			),
		).not.toHaveProperty("prompt");
		expect(() =>
			validateWorkflowDefinition(
				"delivery",
				changedValue({ prompt: 1 }),
				SOURCE,
			),
		).toThrow("prompt must be a string");
	});

	/**
	 * Proves every stage must provide prompt text before graph validation.
	 * Input and expected output: a valid single-stage graph without prompt is rejected with a prompt error.
	 * Edge case: the same stage is both initial and final, so no unrelated graph rule can cause rejection.
	 * Dependencies: the workflow YAML-domain validator only.
	 */
	test("requires a prompt for every stage", () => {
		expect(() =>
			validateWorkflowDefinition(
				"single",
				{
					description: "Single stage",
					stages: [
						{
							id: "only",
							description: "Only stage",
							initial: true,
							final: true,
						},
					],
					transitions: [],
				},
				SOURCE,
			),
		).toThrow("prompt");
	});

	/** Proves every approved graph invariant rejects the whole definition with its source. */
	test.each([
		["unknown root field", changedValue({ extra: true })],
		[
			"one initial stage",
			changedValue({
				stages: [
					{ id: "a", description: "A", prompt: "Prompt A", final: true },
				],
			}),
		],
		[
			"at least one final stage",
			changedValue({
				stages: [
					{ id: "a", description: "A", prompt: "Prompt A", initial: true },
				],
			}),
		],
		[
			"unique stage ids",
			changedValue({
				stages: [
					...(validValue() as { stages: unknown[] }).stages,
					{ id: "a", description: "Again", prompt: "Again prompt" },
				],
			}),
		],
		[
			"known transition endpoints",
			changedValue({
				transitions: [{ from: "a", to: "missing", type: "advance" }],
			}),
		],
		[
			"one transition per ordered pair",
			changedValue({
				transitions: [
					...(validValue() as { transitions: unknown[] }).transitions,
					{ from: "a", to: "b", type: "rework" },
				],
			}),
		],
		[
			"acyclic advance graph",
			changedValue({
				transitions: [
					...(validValue() as { transitions: unknown[] }).transitions,
					{ from: "d", to: "a", type: "advance" },
				],
			}),
		],
		[
			"reachable from initial",
			changedValue({
				stages: [
					{ id: "a", description: "A", prompt: "Prompt A", initial: true },
					{ id: "b", description: "B", prompt: "Prompt B", final: true },
				],
				transitions: [],
			}),
		],
		[
			"final stage has no advance",
			changedValue({
				transitions: [
					...(validValue() as { transitions: unknown[] }).transitions,
					{ from: "f", to: "a", type: "advance" },
				],
			}),
		],
		[
			"non-final stage has advance",
			changedValue({
				stages: [
					{ id: "a", description: "A", prompt: "Prompt A", initial: true },
					{ id: "b", description: "B", prompt: "Prompt B" },
					{ id: "f", description: "F", prompt: "Prompt F", final: true },
				],
				transitions: [{ from: "a", to: "f", type: "advance" }],
			}),
		],
		[
			"rework target is strict ancestor",
			changedValue({
				transitions: [
					...(validValue() as { transitions: unknown[] }).transitions,
					{ from: "d", to: "d", type: "rework" },
				],
			}),
		],
	])("rejects %s", (_rule, value) => {
		expect(() => validateWorkflowDefinition("delivery", value, SOURCE)).toThrow(
			SOURCE,
		);
	});

	/** Proves scalar boundary rules reject trimmed, multiline, and wrongly typed values. */
	test.each([
		changedValue({ description: " padded" }),
		changedValue({ description: "two\nlines" }),
		changedValue({ description: "two\u2028lines" }),
		changedValue({
			stages: [
				{
					id: "a",
					description: "A",
					prompt: "Prompt A",
					initial: "true",
					final: true,
				},
			],
		}),
		changedValue({
			stages: [
				{
					id: "a",
					description: "A",
					prompt: 1,
					initial: true,
					final: true,
				},
			],
			transitions: [],
		}),
		changedValue({
			stages: [
				{
					id: "a",
					description: "A",
					prompt: " \n ",
					initial: true,
					final: true,
				},
			],
			transitions: [],
		}),
	])("rejects invalid scalar shapes", (value) => {
		expect(() =>
			validateWorkflowDefinition("delivery", value, SOURCE),
		).toThrow();
	});

	/** Proves technical stage references reject every form of whitespace without restricting other characters. */
	test.each([
		"stage id",
		"stage\tid",
		"stage\u00a0id",
		"stage\u0085id",
	])("rejects whitespace-bearing stage ID %j", (stageId) => {
		// Purpose: stage identity must remain one non-whitespace token across declarations and transitions.
		// Input and expected output: one otherwise valid workflow uses the same whitespace-bearing ID in its stage and outgoing edges and is rejected.
		// Edge cases: ordinary space, tab, non-breaking space, and next-line cover horizontal and vertical Unicode whitespace.
		// Dependencies: the workflow definition boundary validates scalar contracts before graph semantics.
		const value = validValue() as {
			stages: Array<{ id: string }>;
			transitions: Array<{ from: string; to: string }>;
		};
		const firstStage = value.stages[0];
		if (firstStage === undefined) {
			throw new Error("valid workflow fixture must contain an initial stage");
		}
		firstStage.id = stageId;
		for (const transition of value.transitions) {
			if (transition.from === "a") {
				transition.from = stageId;
			}
			if (transition.to === "a") {
				transition.to = stageId;
			}
		}

		expect(() =>
			validateWorkflowDefinition("delivery", value, SOURCE),
		).toThrow();
	});
});

describe("workflow state", () => {
	/** Proves activation, advance, rework, statuses, and route-dependent availability. */
	test("derives and changes one route", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const activated = activateWorkflow(workflow);
		expect(activated).toHaveProperty("source", "catalog");
		expect(activated.route).toEqual(["a"]);
		expect(getAvailableTransitions(activated).map(({ to }) => to)).toEqual([
			"b",
			"c",
		]);

		const atFinal = ["b", "d", "f"].reduce(transitionWorkflow, activated);
		expect(atFinal.route).toEqual(["a", "b", "d", "f"]);
		expect(Object.fromEntries(getStageStatuses(atFinal))).toEqual({
			a: "completed",
			b: "completed",
			c: "not_started",
			d: "completed",
			f: "in_progress",
		});
		expect(getAvailableTransitions(atFinal).map(({ to }) => to)).toEqual(["b"]);
		expect(transitionWorkflow(atFinal, "b").route).toEqual(["a", "b"]);

		const created = createWorkflow(workflow);
		expect(created).toHaveProperty("source", "dynamic");
		expect(["b", "d"].reduce(transitionWorkflow, created)).toHaveProperty(
			"source",
			"dynamic",
		);
	});

	/** Proves a graph ancestor absent from the actual route cannot be a rework target. */
	test("rejects unavailable transitions without mutating prior state", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const atFinal = ["c", "d", "f"].reduce(
			transitionWorkflow,
			activateWorkflow(workflow),
		);
		expect(() => transitionWorkflow(atFinal, "b")).toThrow(
			"available transitions",
		);
		expect(atFinal.route).toEqual(["a", "c", "d", "f"]);
	});

	/** Proves active-branch custom entries replace snapshots and validate every matching payload. */
	test("replays activated and transitioned entries", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const entries = [
			{ type: "custom", customType: "other", data: null },
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "activated", workflow, route: ["a"] },
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["a", "c"] },
			},
		];
		const replayed = replayWorkflowState(entries);
		expect(replayed).toHaveProperty("source", "catalog");
		expect(replayed?.route).toEqual(["a", "c"]);
		expect(replayed?.workflow.prompt).toBe(
			"Follow shared rules.\n  Preserve this indentation.",
		);

		const dynamicWorkflow = { ...workflow, id: "dynamic-delivery" };
		const dynamicReplay = replayWorkflowState([
			...entries,
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "created",
					workflow: dynamicWorkflow,
					route: ["a"],
				},
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["a", "b"] },
			},
		]);
		expect(dynamicReplay).toHaveProperty("source", "dynamic");
		expect(dynamicReplay?.route).toEqual(["a", "b"]);
		expect(() =>
			replayWorkflowState([
				...entries,
				{
					type: "custom",
					customType: "workflow-state",
					data: { kind: "transitioned", route: ["missing"] },
				},
			]),
		).toThrow("workflow-state");
		expect(() =>
			replayWorkflowState([
				{
					type: "assistant",
					customType: "workflow-state",
					data: entries[1],
				},
			]),
		).toThrow("workflow-state");
		expect(() =>
			replayWorkflowState([
				{
					type: "custom",
					customType: "workflow-state",
					data: {
						kind: "created",
						workflow: dynamicWorkflow,
						route: ["a"],
						source: "dynamic",
					},
				},
			]),
		).toThrow("workflow-state");
	});
});
