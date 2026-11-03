import { expect, test } from "bun:test";
import {
	activateWorkflow,
	replayWorkflowChain,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	validateWorkflowDefinition,
} from "./workflow";

/** Supplies the same grounded graph to each format boundary. */
function definition() {
	return {
		description: "Check",
		stages: [
			{
				id: "start",
				description: "Start",
				goal: "Ready",
				prompt: "Work",
				initial: true,
				model: { thinking: "low" },
			},
			{
				id: "done",
				description: "Done",
				goal: "Delivered",
				prompt: "Report",
				final: true,
				model: { thinking: "medium" },
			},
		],
		transitions: [
			{ from: "start", to: "done", type: "advance" },
			{
				from: "done",
				to: "start",
				type: "rework",
				grounds: [{ id: "retry", when: "Revision needed" }],
			},
		],
	};
}

test("format3 accepts optional nested while earlier formats keep their closed schema", () => {
	for (const nested of [undefined, false, true]) {
		const workflow = validateWorkflowDefinition(
			"check",
			{
				...definition(),
				version: 3,
				...(nested === undefined ? {} : { nested }),
			},
			"fixture",
		);
		expect(workflow.version).toBe(3);
		expect(workflow.nested ?? false).toBe(nested ?? false);
	}
	for (const version of [1, 2]) {
		expect(() =>
			validateWorkflowDefinition(
				"check",
				{ ...definition(), version, nested: false },
				"fixture",
			),
		).toThrow();
	}
	for (const nested of [null, 1, "true", [], {}]) {
		expect(() =>
			validateWorkflowDefinition(
				"check",
				{ ...definition(), version: 3, nested },
				"fixture",
			),
		).toThrow();
	}
	expect(() =>
		validateWorkflowDefinition(
			"check",
			{ ...definition(), version: 3, unsupported: "check" },
			"fixture",
		),
	).toThrow();
});

test("dynamic creation always selects format3 and accepts nested", () => {
	for (const nested of [undefined, false, true]) {
		const workflow = validateCreatedWorkflowDefinition(
			{
				...definition(),
				id: "dynamic-check",
				...(nested === undefined ? {} : { nested }),
			},
			"fixture",
		);
		expect(workflow.version).toBe(3);
		expect(workflow.nested ?? false).toBe(nested ?? false);
	}
	expect(() =>
		validateCreatedWorkflowDefinition(
			{ ...definition(), id: "check", version: 2 },
			"fixture",
		),
	).toThrow();
});

test("format3 kind survives both saved sources and changes no execution rule", () => {
	const plain = validateWorkflowDefinition(
		"check",
		{ ...definition(), version: 3, nested: true },
		"fixture",
	);
	const classified = validateWorkflowDefinition(
		"check",
		{ ...definition(), version: 3, nested: true, kind: "review" },
		"fixture",
	);
	expect(classified.kind).toBe("review");
	const { kind: _kind, ...rest } = classified;
	expect(rest).toEqual(plain);
	expect(
		transitionWorkflow(activateWorkflow(classified), "done").route,
	).toEqual(transitionWorkflow(activateWorkflow(plain), "done").route);
	for (const source of ["activated", "created"]) {
		const workflow =
			source === "created"
				? validateCreatedWorkflowDefinition(
						{ ...definition(), id: "check", nested: true, kind: "review" },
						"fixture",
					)
				: classified;
		const replay = replayWorkflowChain([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: source,
					journalVersion: 2,
					mode: "push",
					workflow,
					route: ["start"],
				},
			},
		]);
		expect(replay.chain[0]?.workflow.kind).toBe("review");
	}
	for (const version of [undefined, 1, 2]) {
		expect(() =>
			validateWorkflowDefinition(
				"check",
				{ ...definition(), version, kind: "review" },
				"fixture",
			),
		).toThrow();
	}
	for (const kind of [null, 3, "", " review", "a\nb"]) {
		expect(() =>
			validateWorkflowDefinition(
				"check",
				{ ...definition(), version: 3, kind },
				"fixture",
			),
		).toThrow();
	}
});
