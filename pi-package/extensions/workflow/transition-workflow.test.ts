import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { createTempDir } from "../../../test/support/temp-dir";
import { loadWorkflowCatalog } from "./config";
import { WorkflowJournal, type WorkflowJournalRecord } from "./context";
import {
	exitWorkflow,
	replayWorkflowChain,
	validateCreatedWorkflowDefinition,
	validateWorkflowDefinition,
} from "./workflow";

/** Builds a grounded graph for definition and journal boundary tests. */
function createDefinition(binding?: string) {
	return {
		version: 3,
		description: "Fixture",
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
			{
				from: "start",
				to: "done",
				type: "advance",
				...(binding ? { workflow: binding } : {}),
			},
			{
				from: "done",
				to: "start",
				type: "rework",
				grounds: [{ id: "retry", when: "Revision" }],
				...(binding ? { workflow: binding } : {}),
			},
		],
	};
}

/** Wraps a journal2 operation without real session state. */
function createEntry(data: Record<string, unknown>) {
	return {
		type: "custom",
		customType: "workflow-state",
		data: { journalVersion: 2, ...data },
	};
}

/** Creates saved parent and bound-child entries for replay tests. */
function createHistory() {
	const parent = validateWorkflowDefinition(
		"parent",
		createDefinition("check"),
		"fixture",
	);
	const check = validateWorkflowDefinition(
		"check",
		{ ...createDefinition(), nested: true },
		"fixture",
	);
	return [
		createEntry({
			kind: "activated",
			workflow: parent,
			route: ["start"],
			mode: "replace",
		}),
		createEntry({
			kind: "activated",
			workflow: check,
			route: ["start"],
			mode: "push",
			pendingTransition: { stageId: "done" },
		}),
	];
}

test("transition bindings are format3-only and created definitions preserve normalized catalog IDs", () => {
	const workflow = validateWorkflowDefinition(
		"parent",
		createDefinition("cafe\u0301"),
		"fixture",
	);
	expect(workflow.transitions.map((edge) => edge.workflow)).toEqual([
		"café",
		"café",
	]);
	const { version: _version, ...created } = createDefinition("check");
	expect(
		validateCreatedWorkflowDefinition({ ...created, id: "dynamic" }, "fixture")
			.transitions[0]?.workflow,
	).toBe("check");
	for (const version of [1, 2]) {
		const plain = createDefinition();
		const compatible =
			version === 1
				? {
						...plain,
						stages: plain.stages.map(({ goal: _goal, ...stage }) => stage),
						transitions: plain.transitions.map(({ from, to, type }) => ({
							from,
							to,
							type,
						})),
					}
				: plain;
		expect(
			validateWorkflowDefinition(
				"parent",
				{ ...compatible, version },
				"fixture",
			).transitions,
		).toHaveLength(2);
		expect(() =>
			validateWorkflowDefinition(
				"parent",
				{
					...compatible,
					version,
					transitions: compatible.transitions.map((edge) => ({
						...edge,
						workflow: "check",
					})),
				},
				"fixture",
			),
		).toThrow("unsupported key");
	}
	for (const workflow of [null, false, 1, "", "bad\nname", [], {}]) {
		const value = createDefinition();
		expect(() =>
			validateWorkflowDefinition(
				"parent",
				{
					...value,
					transitions: value.transitions.map((edge) => ({ ...edge, workflow })),
				},
				"fixture",
			),
		).toThrow();
	}
});

test("catalog rejects broken and transitively skipped bindings while retaining nested cycles and siblings", async () => {
	const temporary = createTempDir("pi-bound-catalog-");
	try {
		const files = {
			good: createDefinition(),
			missing: createDefinition("absent"),
			cascade: createDefinition("missing"),
			notnested: createDefinition("good"),
			cycleA: { ...createDefinition("cycleB"), nested: true },
			cycleB: { ...createDefinition("cycleA"), nested: true },
		};
		for (const [id, value] of Object.entries(files)) {
			writeFileSync(join(temporary.path, `${id}.yaml`), stringify(value));
		}
		const loaded = await loadWorkflowCatalog(temporary.path);
		expect(loaded.error).toBeUndefined();
		expect(loaded.workflows.map(({ id }) => id).sort()).toEqual([
			"cycleA",
			"cycleB",
			"good",
		]);
		expect(loaded.warnings).toHaveLength(3);
		for (const id of ["missing", "cascade", "notnested"]) {
			expect(
				loaded.warnings?.some(({ message }) => message.includes(`${id}.yaml`)),
			).toBe(true);
		}
	} finally {
		temporary.remove();
	}
});

test("journal2 pending exits resolve once and refusal permits a repeated bound start", () => {
	const starts = createHistory();
	const waiting = replayWorkflowChain(starts).chain;
	expect(waiting[0]?.route).toEqual(["start"]);
	expect(waiting[1]?.pendingTransition).toEqual({ stageId: "done" });
	expect(exitWorkflow(waiting, true)[0]?.route).toEqual(["start", "done"]);
	const refused = createEntry({ kind: "exited", allow: false });
	expect(replayWorkflowChain([...starts, refused]).chain).toEqual(
		waiting.slice(0, 1),
	);
	const repeated = [
		...starts,
		refused,
		starts[1],
		createEntry({ kind: "exited", allow: true }),
	];
	expect(replayWorkflowChain(repeated).chain[0]?.route).toEqual([
		"start",
		"done",
	]);
	const rework = [
		...repeated,
		createEntry({
			...starts[1]?.data,
			pendingTransition: { stageId: "start", ground: "retry" },
		}),
		createEntry({ kind: "exited", allow: true }),
	];
	expect(replayWorkflowChain(rework).chain[0]?.route).toEqual(["start"]);
});

test("pending replay boundaries reject missing or malformed permission and closed-key corruption", () => {
	const starts = createHistory();
	for (const allow of [undefined, null, 0, "true", {}]) {
		expect(() =>
			replayWorkflowChain([
				...starts,
				createEntry({
					kind: "exited",
					...(allow === undefined ? {} : { allow }),
				}),
			]),
		).toThrow();
	}
	for (const pendingTransition of [
		{},
		{ stageId: "absent" },
		{ stageId: "done", ground: "bad" },
		{ stageId: "done", extra: true },
	]) {
		expect(() =>
			replayWorkflowChain([
				starts[0],
				createEntry({ ...starts[1]?.data, pendingTransition }),
			]),
		).toThrow();
	}
	for (const patch of [
		{ mode: "replace" },
		{ journalVersion: 1 },
		{ kind: "created" },
	]) {
		expect(() =>
			replayWorkflowChain([
				starts[0],
				createEntry({ ...starts[1]?.data, ...patch }),
			]),
		).toThrow();
	}
	expect(() => replayWorkflowChain([starts[1]])).toThrow();
	expect(() =>
		replayWorkflowChain([
			...starts,
			createEntry({ kind: "exited", allow: true, extra: true }),
		]),
	).toThrow();
	expect(
		replayWorkflowChain([
			starts[0],
			createEntry({ kind: "exited", allow: false }),
		]).chain,
	).toEqual([]);
});

test("nested bound chains preserve pending ownership through ordinary returns and replacement", () => {
	const starts = createHistory();
	const deeper = validateWorkflowDefinition(
		"deeper",
		{ ...createDefinition(), nested: true },
		"fixture",
	);
	const boundCheck = validateWorkflowDefinition(
		"check",
		{ ...createDefinition("deeper"), nested: true },
		"fixture",
	);
	const chainEntries = [
		starts[0],
		createEntry({ ...starts[1]?.data, workflow: boundCheck }),
		createEntry({
			kind: "activated",
			workflow: deeper,
			route: ["start"],
			mode: "push",
			pendingTransition: { stageId: "done" },
		}),
	];
	const resolved = [
		...chainEntries,
		createEntry({ kind: "exited", allow: true }),
	];
	expect(replayWorkflowChain(resolved).chain.map(({ route }) => route)).toEqual(
		[["start"], ["start", "done"]],
	);
	expect(
		replayWorkflowChain([
			...resolved,
			createEntry({ kind: "exited", allow: true }),
		]).chain[0]?.route,
	).toEqual(["start", "done"]);
	const ordinary = createEntry({
		kind: "activated",
		workflow: deeper,
		route: ["start"],
		mode: "push",
	});
	expect(
		replayWorkflowChain([
			...starts,
			ordinary,
			createEntry({ kind: "exited", allow: true }),
		]).chain,
	).toEqual(replayWorkflowChain(starts).chain);
	expect(
		replayWorkflowChain([
			...chainEntries,
			createEntry({
				...starts[0]?.data,
				workflow: validateWorkflowDefinition(
					"replacement",
					createDefinition(),
					"fixture",
				),
			}),
		]).chain,
	).toHaveLength(1);
});

test("context appends pending metadata at start and checkpoint and refusal metadata on return", () => {
	const chain = replayWorkflowChain(createHistory()).chain;
	const records: WorkflowJournalRecord[] = [];
	const journal = new WorkflowJournal((record) => records.push(record));
	journal.activate(chain);
	const previous = structuredClone(records.map(({ details }) => details));
	journal.startContextSegment();
	journal.checkpoint(chain);
	journal.enterStage(chain.slice(0, 1), { stageId: "done" });
	expect(records[0]?.details).toEqual(previous[0]);
	for (const record of records.slice(0, 2)) {
		expect(record.details["pendingTransitions"]).toEqual([
			{ workflowId: "check", parentWorkflowId: "parent", stageId: "done" },
		]);
	}
	expect(records[2]?.details["refusedTransition"]).toEqual({ stageId: "done" });
	expect(records[2]?.details["currentStageId"]).toBe("start");
	const restored = new WorkflowJournal(() => {});
	restored.restore(
		records.map((record) => ({ type: "custom_message", ...record })),
	);
	expect(restored.isCurrent(chain.slice(0, 1))).toBe(true);
});
