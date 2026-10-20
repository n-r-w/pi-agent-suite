import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { WorkflowJournal, type WorkflowJournalRecord } from "./context";
import {
	activateWorkflow,
	completeWorkflow,
	createWorkflow,
	getAvailableTransitions,
	getStageStatuses,
	replayWorkflowState,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	validateWorkflowDefinition,
	WORKFLOW_STATE_JOURNAL_VERSION,
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
				triggers: [
					{ type: "local_knowledge_accumulation" },
					{ type: "global_knowledge_accumulation" },
					{ type: "local_knowledge_accumulation" },
				],
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

/** Builds a valid dynamic definition with required thinking settings on every stage. */
function validCreatedValue(
	thinking: "low" | "medium" | "high" = "medium",
): Record<string, unknown> {
	const value = validValue() as {
		stages: Record<string, unknown>[];
		transitions: Record<string, unknown>[];
	};
	return {
		...value,
		stages: value.stages.map((stage) => ({
			...stage,
			goal: `  Outcome ${String(stage["id"])} holds.  `,
			model: { thinking },
		})),
		transitions: value.transitions.map((edge) => ({
			...edge,
			grounds: [{ id: "ready", when: "  The condition holds.  " }],
		})),
	};
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
		expect(workflow.stages[0]?.triggers).toEqual([]);
		expect(workflow.stages[1]).toEqual({
			id: "b",
			description: "B",
			prompt: "First line\n  indented second line",
			triggers: [
				{ type: "local_knowledge_accumulation" },
				{ type: "global_knowledge_accumulation" },
				{ type: "local_knowledge_accumulation" },
			],
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
	 * Proves trigger entries remain closed discriminated objects at the workflow boundary.
	 * Inputs and expected outputs: unknown types, unknown fields, missing types, arrays, strings, and null are rejected.
	 * Edge cases: an explicitly empty trigger list remains valid and equivalent to omission.
	 * Dependencies: stage parsing and the supported workflow trigger type set.
	 */
	test("rejects invalid trigger objects", () => {
		const invalidTriggers: readonly unknown[] = [
			[{ type: "unknown" }],
			[{ type: "local_knowledge_accumulation", extra: true }],
			[{}],
			[[{ type: "local_knowledge_accumulation" }]],
			["local_knowledge_accumulation"],
			[null],
		];
		for (const triggers of invalidTriggers) {
			const value = validValue() as {
				stages: Record<string, unknown>[];
			};
			value.stages[0] = { ...value.stages[0], triggers };
			expect(() =>
				validateWorkflowDefinition("delivery", value, SOURCE),
			).toThrow("trigger");
		}

		const value = validValue() as {
			stages: Record<string, unknown>[];
		};
		value.stages[0] = { ...value.stages[0], triggers: [] };
		expect(
			validateWorkflowDefinition("delivery", value, SOURCE).stages[0]?.triggers,
		).toEqual([]);
	});

	/**
	 * Proves workflow_create accepts one closed object and delegates graph rules to the workflow validator.
	 * Input and expected output: a valid object including id becomes one normalized definition; unknown keys and invalid graphs fail.
	 * Edge cases: the dynamic root rejects unknown fields, root model settings, and a padded id.
	 * Dependencies: the shared workflow definition and graph validators.
	 */
	test("validates complete dynamic workflow definitions", () => {
		const created = validateCreatedWorkflowDefinition(
			{ id: "delivery", ...validCreatedValue() },
			"workflow_create",
		);
		expect(created.id).toBe("delivery");
		expect(created.version).toBe(2);
		expect(created.stages[0]?.goal).toBe("Outcome a holds.");
		expect(created.transitions[0]?.grounds).toEqual([
			{ id: "ready", when: "The condition holds." },
		]);
		expect(created).not.toHaveProperty("model");
		expect(created.stages).toHaveLength(5);
		expect(() =>
			validateCreatedWorkflowDefinition(
				{ id: "delivery", ...validCreatedValue(), extra: true },
				"workflow_create",
			),
		).toThrow("workflow_create");
		expect(() =>
			validateCreatedWorkflowDefinition(
				{ id: " delivery", ...validCreatedValue() },
				"workflow_create",
			),
		).toThrow("id must be");
		expect(() =>
			validateCreatedWorkflowDefinition(
				{ id: "delivery", ...validCreatedValue(), transitions: [] },
				"workflow_create",
			),
		).toThrow("workflow_create");
		expect(() =>
			validateCreatedWorkflowDefinition(
				{
					id: "delivery",
					...validCreatedValue(),
					model: { thinking: "medium" },
				},
				"workflow_create",
			),
		).toThrow("unsupported key");
	});

	/** Checks required goals and grounds in dynamically created workflows. */
	test("requires format-2 goals and choice grounds without accepting a version selector", () => {
		for (const goal of [undefined, "", "   ", 4]) {
			const value = validCreatedValue();
			const stages = value["stages"] as Record<string, unknown>[];
			stages[0] = { ...stages[0], goal };
			expect(() =>
				validateCreatedWorkflowDefinition({ id: "delivery", ...value }, SOURCE),
			).toThrow("stage a");
		}
		for (const edgeIndex of [0, 1, 5]) {
			for (const grounds of [undefined, []]) {
				const value = validCreatedValue();
				const edges = value["transitions"] as Record<string, unknown>[];
				edges[edgeIndex] = { ...edges[edgeIndex], grounds };
				expect(() =>
					validateCreatedWorkflowDefinition(
						{ id: "delivery", ...value },
						SOURCE,
					),
				).toThrow("requires grounds");
			}
		}
		const unconditional = validCreatedValue();
		const edges = unconditional["transitions"] as Record<string, unknown>[];
		delete edges[2]?.["grounds"];
		expect(
			validateCreatedWorkflowDefinition(
				{ id: "delivery", ...unconditional },
				SOURCE,
			).transitions[2]?.grounds,
		).toBeUndefined();
		for (const version of [1, 2, 3]) {
			expect(() =>
				validateCreatedWorkflowDefinition(
					{ id: "delivery", ...validCreatedValue(), version },
					SOURCE,
				),
			).toThrow("unsupported key");
		}
	});

	/**
	 * Proves dynamic workflow parsing requires thinking-only model settings on every stage.
	 * Inputs and expected outputs: low, medium, and high become normalized model settings on all stages.
	 * Edge cases: missing settings, unsupported levels, model IDs, unknown keys, and empty model objects are rejected.
	 * Dependencies: the workflow_create domain boundary and shared workflow graph validation.
	 */
	test("requires thinking-only dynamic model settings on every stage", () => {
		for (const thinking of ["low", "medium", "high"] as const) {
			const created = validateCreatedWorkflowDefinition(
				{ id: "delivery", ...validCreatedValue(thinking) },
				"workflow_create",
			);
			expect(
				created.stages.every((stage) => stage.model?.thinking === thinking),
			).toBe(true);
		}

		const missingValue = validCreatedValue() as {
			stages: Record<string, unknown>[];
		};
		delete missingValue.stages[0]?.["model"];
		expect(() =>
			validateCreatedWorkflowDefinition(
				{ id: "delivery", ...missingValue },
				"workflow_create",
			),
		).toThrow("stages[0].model.thinking");

		for (const model of [
			{ thinking: "off" },
			{ thinking: "minimal" },
			{ thinking: "xhigh" },
			{ thinking: "max" },
			{ thinking: "unknown" },
			{ id: "openai/gpt-test" },
			{ thinking: "high", id: "openai/gpt-test" },
			{ thinking: "high", extra: true },
			{},
		] as const) {
			const value = validCreatedValue() as {
				stages: Record<string, unknown>[];
			};
			value.stages[0] = { ...value.stages[0], model };
			expect(() =>
				validateCreatedWorkflowDefinition(
					{ id: "delivery", ...value },
					"workflow_create",
				),
			).toThrow("model");
		}
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

		const atFinal = ["b", "d", "f"].reduce(
			(state, stageId) => transitionWorkflow(state, stageId),
			activated,
		);
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
		expect(
			["b", "d"].reduce(
				(state, stageId) => transitionWorkflow(state, stageId),
				created,
			),
		).toHaveProperty("source", "dynamic");
	});

	/** Proves a graph ancestor absent from the actual route cannot be a rework target. */
	test("rejects unavailable transitions without mutating prior state", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const atFinal = ["c", "d", "f"].reduce(
			(state, stageId) => transitionWorkflow(state, stageId),
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
				data: {
					kind: "activated",
					workflow,
					route: ["a"],
					restoration: { modelId: "openai/current-model", thinking: "medium" },
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				},
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
		expect(replayed?.workflow.stages[1]?.triggers).toEqual([
			{ type: "local_knowledge_accumulation" },
			{ type: "global_knowledge_accumulation" },
			{ type: "local_knowledge_accumulation" },
		]);

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
					restoration: {
						modelId: "openai/current-model",
						thinking: "medium",
					},
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
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

		const finalRoute = ["a", "b", "d", "f"];
		const completedReplay = replayWorkflowState([
			entries[0],
			entries[1],
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["a", "b"] },
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["a", "b", "d"] },
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: finalRoute },
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "completed", route: finalRoute },
			},
		]);
		expect(completedReplay?.status).toBe("completed");
		expect(completedReplay?.restoration).toEqual({
			modelId: "openai/current-model",
			thinking: "medium",
		});
		expect(
			getStageStatuses(
				completedReplay as NonNullable<typeof completedReplay>,
			).get("f"),
		).toBe("completed");
		expect(
			getAvailableTransitions(
				completedReplay as NonNullable<typeof completedReplay>,
			).map(({ to }) => to),
		).toEqual(["b"]);
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
						journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
					},
				},
			]),
		).toThrow("workflow-state");
	});

	/**
	 * Proves a persisted stage edit changes the replayed session snapshot without replacing workflow identity or graph state.
	 * Input and expected output: one active snapshot followed by a stage_edited entry updates description, prompt, and thinking.
	 * Edge cases: editing a non-active stage preserves its id, flags, triggers, route, transitions, source, and restoration settings.
	 * Dependencies: saved workflow validation and ordered custom-entry replay.
	 */
	test("replays persisted stage edits into the workflow snapshot", () => {
		const workflow = validateWorkflowDefinition(
			"dynamic-delivery",
			validValue(),
			SOURCE,
		);
		const replayed = replayWorkflowState([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "created",
					workflow,
					route: ["a"],
					restoration: {
						modelId: "openai/current-model",
						thinking: "medium",
					},
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				},
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "stage_edited",
					stageId: "b",
					description: "Revised B",
					prompt: "Use the revised requirements.",
					model: { thinking: "xhigh" },
				},
			},
		]);

		expect(replayed).toMatchObject({
			source: "dynamic",
			route: ["a"],
			status: "active",
			restoration: {
				modelId: "openai/current-model",
				thinking: "medium",
			},
		});
		expect(replayed?.workflow.stages[1]).toEqual({
			id: "b",
			description: "Revised B",
			prompt: "Use the revised requirements.",
			triggers: [
				{ type: "local_knowledge_accumulation" },
				{ type: "global_knowledge_accumulation" },
				{ type: "local_knowledge_accumulation" },
			],
			initial: false,
			final: false,
			model: { thinking: "xhigh" },
		});
		expect(replayed?.workflow.transitions).toEqual(workflow.transitions);
	});

	/**
	 * Proves malformed persisted edits cannot silently corrupt a saved workflow snapshot.
	 * Input and expected output: an edit before activation and an unknown stage both reject replay.
	 * Edge cases: immutable flags and extra fields are rejected by the closed entry shape.
	 * Dependencies: stage edit replay validation only.
	 */
	test("rejects invalid persisted stage edits", () => {
		const catalogWorkflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const dynamicWorkflow = validateWorkflowDefinition(
			"dynamic-delivery",
			validValue(),
			SOURCE,
		);
		const edit = {
			type: "custom",
			customType: "workflow-state",
			data: {
				kind: "stage_edited",
				stageId: "missing",
				description: "Revised",
				prompt: "Use the revised requirements.",
				model: { thinking: "high" },
			},
		};
		const restoration = {
			modelId: "openai/current-model",
			thinking: "medium",
		};
		const activation = {
			type: "custom",
			customType: "workflow-state",
			data: {
				kind: "activated",
				workflow: catalogWorkflow,
				route: ["a"],
				restoration,
				journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
			},
		};
		const creation = {
			type: "custom",
			customType: "workflow-state",
			data: {
				kind: "created",
				workflow: dynamicWorkflow,
				route: ["a"],
				restoration,
				journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
			},
		};

		expect(() => replayWorkflowState([edit])).toThrow("active snapshot");
		expect(() =>
			replayWorkflowState([
				activation,
				{ ...edit, data: { ...edit.data, stageId: "b" } },
			]),
		).toThrow("workflow_create");
		expect(() => replayWorkflowState([creation, edit])).toThrow("missing");
		expect(() =>
			replayWorkflowState([
				creation,
				{
					...edit,
					data: { ...edit.data, stageId: "b", initial: true },
				},
			]),
		).toThrow("unsupported key");
	});

	/** Proves workflow chains without the journal contract are ignored instead of repaired. */
	test("ignores workflow state without a journal contract", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			validValue(),
			SOURCE,
		);
		const legacyEntries = [
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "activated",
					workflow,
					route: ["a"],
					restoration: {
						modelId: "openai/current-model",
						thinking: "medium",
					},
				},
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["a", "b"] },
			},
		];

		expect(replayWorkflowState(legacyEntries)).toBeUndefined();
	});
});

/** Returns a fixture item or fails the test if it is missing. */
function requireFixtureItem<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) {
		throw new Error(`missing fixture item ${index}`);
	}
	return item;
}

/** Identifies errors for fields that require format version 2. */
const FORMAT_TWO_REQUIRED = /format.*2/i;
/** Identifies goal errors for the left stage. */
const LEFT_GOAL_ERROR = /left.*goal/;

/** Builds a branching workflow fixture with transition grounds. */
function createVersionedDefinition(version: unknown = 2) {
	return {
		version,
		description: "Delivery",
		stages: [
			{
				id: "start",
				description: "Start",
				goal: "Ready <&> approved",
				prompt: "Perform work",
				initial: true,
			},
			{
				id: "left",
				description: "Left",
				goal: "Left ready",
				prompt: "Work",
				final: true,
			},
			{
				id: "right",
				description: "Right",
				goal: "Right ready",
				prompt: "Work",
				final: true,
			},
		],
		transitions: [
			{
				from: "start",
				to: "left",
				type: "advance",
				grounds: [{ id: "ready", when: "Left <&> ready" }],
			},
			{
				from: "start",
				to: "right",
				type: "advance",
				grounds: [{ id: "ready", when: "Right ready" }],
			},
			{
				from: "left",
				to: "start",
				type: "rework",
				grounds: [{ id: "retry", when: "Revision needed" }],
			},
		],
	};
}

/** Builds an unversioned format-1 workflow fixture. */
function createLegacyDefinition() {
	const { version: _version, ...value } = createVersionedDefinition();
	return {
		...value,
		stages: value.stages.map(({ goal: _goal, ...stage }) => stage),
		transitions: value.transitions.map(
			({ grounds: _grounds, ...edge }) => edge,
		),
	};
}

describe("workflow format boundaries", () => {
	test("normalizes explicit version 1 without changing JSON, revision, or records", () => {
		const raw = createLegacyDefinition();
		const legacy = validateWorkflowDefinition("delivery", raw, "catalog");
		const explicit = validateWorkflowDefinition(
			"delivery",
			{ ...raw, version: 1 },
			"catalog",
		);
		expect(JSON.stringify(explicit)).toBe(JSON.stringify(legacy));
		const records: WorkflowJournalRecord[] = [];
		const journal = new WorkflowJournal((record) => records.push(record));
		journal.activate(activateWorkflow(legacy));
		journal.activate(activateWorkflow(explicit));
		expect(records[1]).toEqual(records[0]);
		expect(records[0]?.details["workflowRevision"]).toBe(
			createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
		);
	});

	test.each(
		[3, "future", null, false, [2], { requested: 3 }].map((version) => ({
			version,
		})),
	)("rejects unknown version %j by value", ({ version }) => {
		expect(() =>
			validateWorkflowDefinition(
				"delivery",
				createVersionedDefinition(version),
				"catalog",
			),
		).toThrow(JSON.stringify(version));
	});

	test.each([
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NaN,
	])("names the rejected non-finite version %s", (version) => {
		expect(() =>
			validateWorkflowDefinition(
				"delivery",
				createVersionedDefinition(version),
				"catalog",
			),
		).toThrow(String(version));
	});

	test.each([
		"goal",
		"grounds",
	])("explains format-1 rejection of %s", (field) => {
		const value = createLegacyDefinition();
		if (field === "goal") {
			Object.assign(requireFixtureItem(value.stages, 0), { goal: "Ready" });
		} else {
			Object.assign(requireFixtureItem(value.transitions, 0), {
				grounds: [{ id: "ready", when: "Ready" }],
			});
		}
		expect(() =>
			validateWorkflowDefinition("delivery", value, "catalog"),
		).toThrow(FORMAT_TWO_REQUIRED);
	});

	test.each([
		undefined,
		"",
		"  ",
		42,
	])("names the stage with invalid goal %j", (goal) => {
		const value = createVersionedDefinition();
		Object.assign(requireFixtureItem(value.stages, 1), { goal });
		expect(() =>
			validateWorkflowDefinition("delivery", value, "catalog"),
		).toThrow(LEFT_GOAL_ERROR);
	});

	test.each([
		0, 1, 2,
	])("names the transition with missing required grounds at %i", (index) => {
		const value = createVersionedDefinition();
		const edge = requireFixtureItem(value.transitions, index);
		for (const grounds of [undefined, []]) {
			Object.assign(edge, { grounds });
			expect(() =>
				validateWorkflowDefinition("delivery", value, "catalog"),
			).toThrow(`${edge.from} -> ${edge.to}`);
		}
	});

	test.each(
		[
			[
				{ id: "same", when: "One" },
				{ id: "same", when: "Two" },
			],
			[{ id: "bad id", when: "Ready" }],
			[{ id: "ready", when: " " }],
			[{ id: "ready", when: "Ready", extra: true }],
		].map((grounds) => [grounds]),
	)("rejects invalid grounds %j", (grounds) => {
		const value = createVersionedDefinition();
		Object.assign(requireFixtureItem(value.transitions, 0), { grounds });
		expect(() =>
			validateWorkflowDefinition("delivery", value, "catalog"),
		).toThrow("start -> left");
	});

	test("accepts an unconditional single advance and preserves normalized format-2 values", () => {
		const value = createVersionedDefinition();
		value.stages.splice(2, 1);
		value.transitions.splice(1, 1);
		Object.assign(requireFixtureItem(value.transitions, 0), {
			grounds: undefined,
		});
		requireFixtureItem(value.stages, 0).goal = "  Ready\n  approved  ";
		const workflow = validateWorkflowDefinition("delivery", value, "catalog");
		expect(workflow).toMatchObject({
			version: 2,
			stages: [{ goal: "Ready\n  approved" }, { goal: "Left ready" }],
		});
	});

	/** Applies the same ground rule to catalog activation and dynamic state. */
	test.each([
		activateWorkflow,
		createWorkflow,
	])("selects only grounds of the available transition with %p", (startWorkflow) => {
		const value = createVersionedDefinition();
		requireFixtureItem(value.transitions, 0).grounds.push({
			id: "approved",
			when: "Review approved",
		});
		const state = startWorkflow(
			validateWorkflowDefinition("delivery", value, "catalog"),
		);
		const before = structuredClone(state);
		for (const ground of [undefined, "missing", "retry"]) {
			for (const allowed of ["ready", "approved"]) {
				expect(() => transitionWorkflow(state, "left", ground)).toThrow(
					allowed,
				);
			}
			expect(state).toEqual(before);
		}
		for (const ground of ["ready", "approved"]) {
			const advanced = transitionWorkflow(state, "left", ground);
			expect(advanced.route).toEqual(["start", "left"]);
			expect(state).toEqual(before);
			const completed = completeWorkflow(advanced);
			expect(() => transitionWorkflow(completed, "start")).toThrow("retry");
			const reworked = transitionWorkflow(completed, "start", "retry");
			expect(reworked).toEqual(state);
			expect(completed.status).toBe("completed");
			expect(completed.route).toEqual(["start", "left"]);
		}
	});

	/** Keeps both forms of unconditional format-2 transitions compatible with format 1. */
	test.each([
		"legacy",
		"absent",
		"empty",
	])("rejects a ground on an unconditional %s transition", (mode) => {
		const raw =
			mode === "legacy"
				? createLegacyDefinition()
				: createVersionedDefinition();
		if (mode !== "legacy") {
			raw.stages.splice(2, 1);
			raw.transitions.splice(1, 1);
			Object.assign(requireFixtureItem(raw.transitions, 0), {
				grounds: mode === "empty" ? [] : undefined,
			});
		}
		const state = activateWorkflow(
			validateWorkflowDefinition("delivery", raw, "catalog"),
		);
		expect(() => transitionWorkflow(state, "left", "ready")).toThrow("ground");
		expect(state.route).toEqual(["start"]);
		expect(transitionWorkflow(state, "left").route).toEqual(["start", "left"]);
	});

	test("keeps goals and grounds in shared lifecycle record structures", () => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			createVersionedDefinition(),
			"catalog",
		);
		const records: WorkflowJournalRecord[] = [];
		const journal = new WorkflowJournal((record) => records.push(record));
		let state = activateWorkflow(workflow);
		journal.activate(state);
		state = transitionWorkflow(state, "left", "ready");
		journal.enterStage(state);
		state = transitionWorkflow(state, "start", "retry");
		journal.enterStage(state);
		journal.checkpoint(state);
		journal.updateStage(state, "start");
		state = transitionWorkflow(state, "left", "ready");
		journal.complete(completeWorkflow(state));

		for (const index of [0, 1, 2, 3, 4]) {
			const content = requireFixtureItem(records, index).content;
			expect(content).toContain("<stage_goal>");
			const instructions = content.indexOf(
				index === 3 ? "<active_stage_guidelines>" : "<stage_guidelines>",
			);
			if (index === 2) {
				expect(instructions).toBe(-1);
				expect(content).toContain('guidelines="reuse"');
			} else {
				expect(content.indexOf("<stage_goal>")).toBeLessThan(instructions);
			}
		}
		for (const index of [0, 2, 3]) {
			const content = requireFixtureItem(records, index).content;
			expect(content).toContain(
				'<ground id="ready">Left &lt;&amp;&gt; ready</ground>',
			);
			expect(content).toContain('<ground id="ready">Right ready</ground>');
		}
		for (const index of [1, 5]) {
			expect(requireFixtureItem(records, index).content).toContain(
				'<ground id="retry">Revision needed</ground>',
			);
		}
	});

	test.each([
		"activated",
		"created",
	])("replays %s format-2 snapshots and subsequent saved route", (kind) => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			createVersionedDefinition(),
			"catalog",
		);
		const state = replayWorkflowState([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind,
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
					workflow,
					route: ["start"],
				},
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["start", "left"] },
			},
		]);
		expect(state?.workflow).toEqual(workflow);
		expect(state?.route).toEqual(["start", "left"]);
		expect(state?.source).toBe(kind === "created" ? "dynamic" : "catalog");
	});

	test.each([
		"activated",
		"created",
	])("keeps unversioned %s snapshots compatible with journal revisions", (kind) => {
		const workflow = validateWorkflowDefinition(
			"delivery",
			createLegacyDefinition(),
			"catalog",
		);
		const state = replayWorkflowState([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind,
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
					workflow,
					route: ["start", "left"],
				},
			},
		]);
		expect(state?.workflow).toEqual(workflow);
		expect(state?.route).toEqual(["start", "left"]);
	});
});
