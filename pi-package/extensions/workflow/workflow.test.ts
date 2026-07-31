import { describe, expect, test } from "bun:test";
import {
	activateWorkflow,
	getAvailableTransitions,
	getStageStatuses,
	replayWorkflowState,
	transitionWorkflow,
	validateWorkflowDefinition,
} from "./workflow";

const SOURCE = "/tmp/workflow.yaml";

/** Builds the branching workflow used to exercise graph and route rules. */
function validValue(): unknown {
	return {
		description: "Software delivery",
		stages: [
			{ id: "a", description: "A", initial: true },
			{ id: "b", description: "B" },
			{ id: "c", description: "C" },
			{ id: "d", description: "D" },
			{ id: "f", description: "F", final: true },
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
		expect(workflow.stages[1]).toEqual({
			id: "b",
			description: "B",
			initial: false,
			final: false,
		});
	});

	/** Proves every approved graph invariant rejects the whole definition with its source. */
	test.each([
		["unknown root field", changedValue({ extra: true })],
		[
			"one initial stage",
			changedValue({ stages: [{ id: "a", description: "A", final: true }] }),
		],
		[
			"at least one final stage",
			changedValue({ stages: [{ id: "a", description: "A", initial: true }] }),
		],
		[
			"unique stage ids",
			changedValue({
				stages: [
					...(validValue() as { stages: unknown[] }).stages,
					{ id: "a", description: "Again" },
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
					{ id: "a", description: "A", initial: true },
					{ id: "b", description: "B", final: true },
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
					{ id: "a", description: "A", initial: true },
					{ id: "b", description: "B" },
					{ id: "f", description: "F", final: true },
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
		changedValue({
			stages: [{ id: "a", description: "A", initial: "true", final: true }],
		}),
	])("rejects invalid scalar shapes", (value) => {
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
		expect(replayWorkflowState(entries)?.route).toEqual(["a", "c"]);
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
	});
});
