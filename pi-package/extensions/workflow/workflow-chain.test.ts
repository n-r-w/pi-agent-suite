import { expect, test } from "bun:test";
import {
	addWorkflow,
	getTopWorkflow,
	replayWorkflowChain,
	WORKFLOW_LEGACY_STATE_WARNING,
} from "./workflow";

/** Builds a valid version-1 root snapshot without using runtime constructors. */
function root(journalVersion: number | undefined) {
	return {
		type: "custom",
		customType: "workflow-state",
		data: {
			kind: "activated",
			...(journalVersion === undefined ? {} : { journalVersion }),
			workflow: {
				id: "delivery",
				description: "Delivery",
				stages: [
					{ id: "start", description: "Start", prompt: "Work", initial: true },
					{ id: "done", description: "Done", prompt: "Report", final: true },
				],
				transitions: [
					{ from: "start", to: "done", type: "advance" },
					{ from: "done", to: "start", type: "rework" },
				],
			},
			route: ["start"],
			restoration: { modelId: "fake/original", thinking: "low" as const },
		},
	};
}

/** Wraps one journal operation as a session entry. */
function operation(data: Record<string, unknown>) {
	return { type: "custom", customType: "workflow-state", data };
}

test("replays version1 roots with unversioned operations and legacy completion as exit", () => {
	const start = root(1);
	const transition = operation({
		kind: "transitioned",
		route: ["start", "done"],
	});
	const active = replayWorkflowChain([start, transition]);
	expect(getTopWorkflow(active.chain)?.route).toEqual(["start", "done"]);
	const ended = replayWorkflowChain([
		start,
		transition,
		operation({ kind: "completed", route: ["start", "done"] }),
	]);
	expect(getTopWorkflow(ended.chain)).toBeUndefined();
	expect(ended.restoration).toEqual(start.data.restoration);
});

test("restores historical version1 rework after completion without reviving a new exit", () => {
	const entries = [
		root(1),
		operation({ kind: "transitioned", route: ["start", "done"] }),
		operation({ kind: "completed", route: ["start", "done"] }),
	];
	expect(replayWorkflowChain(entries).chain).toEqual([]);
	const restored = replayWorkflowChain([
		...entries,
		operation({ kind: "transitioned", route: ["start"] }),
	]);
	expect(getTopWorkflow(restored.chain)?.route).toEqual(["start"]);
	expect(restored.restoration).toBeUndefined();
	expect(() =>
		replayWorkflowChain([
			root(2),
			operation({ kind: "exited", journalVersion: 2 }),
			operation({ kind: "transitioned", journalVersion: 2, route: ["start"] }),
		]),
	).toThrow("active snapshot");
});

test.each(
	[1, 2].flatMap((rootVersion) =>
		["completed", "exited"].flatMap((kind) =>
			[undefined, 1, 2, 3]
				.filter((operationVersion) =>
					kind === "completed"
						? rootVersion !== 1 || operationVersion !== undefined
						: operationVersion !== 2,
				)
				.map((operationVersion) => ({ rootVersion, kind, operationVersion })),
		),
	),
)("rejects unsupported exit boundary %j", ({
	rootVersion,
	kind,
	operationVersion,
}) => {
	const entry = operation({
		kind,
		...(operationVersion === undefined
			? {}
			: { journalVersion: operationVersion }),
		...(kind === "completed" ? { route: ["start", "done"] } : {}),
	});
	expect(() =>
		replayWorkflowChain([
			root(rootVersion),
			operation({
				kind: "transitioned",
				journalVersion: 2,
				route: ["start", "done"],
			}),
			entry,
		]),
	).toThrow("journalVersion");
});

test("replays mixed versions and keeps missing-version warnings", () => {
	const exit = operation({ kind: "exited", journalVersion: 2 });
	const replay = replayWorkflowChain([
		root(1),
		exit,
		root(2),
		operation({
			kind: "transitioned",
			route: ["start", "done"],
			journalVersion: 2,
		}),
		exit,
	]);
	expect(replay.chain).toEqual([]);
	expect(replay.restoration).toEqual(root(1).data.restoration);
	const legacy = replayWorkflowChain([
		root(undefined),
		operation({ kind: "completed", route: ["start", "done"] }),
	]);
	expect(legacy.chain).toEqual([]);
	expect(legacy.warnings).toEqual([WORKFLOW_LEGACY_STATE_WARNING]);
});

test("adds nested workflows at arbitrary depth and rejects every running identity before replacement", () => {
	const first = replayWorkflowChain([root(1)]).chain[0];
	if (!first) {
		throw new Error("missing root");
	}
	let chain = [first];
	for (let depth = 0; depth < 20; depth++) {
		const child = {
			...first,
			workflow: {
				...first.workflow,
				version: 3 as const,
				nested: true,
				id: `child-${depth}`,
			},
		};
		const next = addWorkflow(chain, child);
		expect(next.slice(0, -1)).toEqual(chain);
		expect(next.at(-1)).toBe(child);
		chain = [...next];
	}
	expect(() => addWorkflow(chain, first)).toThrow("already");
	const accented = { ...first, workflow: { ...first.workflow, id: "café" } };
	expect(() =>
		addWorkflow([accented], {
			...accented,
			workflow: { ...accented.workflow, id: "cafe\u0301" },
		}),
	).toThrow("already");
	expect(
		addWorkflow([first], {
			...first,
			workflow: { ...first.workflow, id: "DELIVERY" },
		}),
	).toHaveLength(1);
	const replacement = {
		...first,
		workflow: { ...first.workflow, id: "replacement" },
	};
	expect(addWorkflow(chain, replacement)).toEqual([replacement]);
	const child = chain[1];
	if (!child) {
		throw new Error("missing nested workflow");
	}
	expect(addWorkflow([], child)).toEqual([child]);
});

test("replays mixed nested starts with top-only edits and preserves waiting snapshots through return", () => {
	const parent = root(1);
	const child = root(2);
	const childDefinition = {
		...child.data.workflow,
		id: "child",
		version: 3,
		nested: true,
		stages: child.data.workflow.stages.map((stage) => ({
			...stage,
			goal: "Ready",
			model: { thinking: "medium" },
		})),
		transitions: child.data.workflow.transitions.map((edge) => ({
			...edge,
			grounds: [{ id: "retry", when: "Revision" }],
		})),
	};
	const nested = operation({
		...child.data,
		workflow: childDefinition,
		kind: "created",
		mode: "push",
		restoration: { modelId: "fake/parent", thinking: "high" },
	});
	const entries = [
		parent,
		operation({ kind: "transitioned", route: ["start", "done"] }),
		nested,
		operation({
			kind: "stage_edited",
			journalVersion: 2,
			stageId: "start",
			description: "Edited child",
			goal: "Ready",
			prompt: "Updated",
			model: { thinking: "low" },
		}),
		operation({
			kind: "transitioned",
			journalVersion: 2,
			route: ["start", "done"],
		}),
	];
	const active = replayWorkflowChain(entries);
	expect(active.chain.map(({ workflow }) => workflow.id)).toEqual([
		"delivery",
		"child",
	]);
	expect(active.chain[0]).toEqual(
		replayWorkflowChain(entries.slice(0, 2)).chain[0],
	);
	expect(active.chain[1]?.workflow.stages[0]?.description).toBe("Edited child");
	expect(active.chain[1]?.restoration).toEqual({
		modelId: "fake/parent",
		thinking: "high",
	});
	const returned = replayWorkflowChain([
		...entries,
		operation({ kind: "exited", journalVersion: 2 }),
	]);
	expect(returned.chain).toEqual(active.chain.slice(0, 1));
	expect(returned.restoration).toBeUndefined();
	const ended = replayWorkflowChain([
		...entries,
		operation({ kind: "exited", journalVersion: 2 }),
		operation({ kind: "exited", journalVersion: 2 }),
	]);
	expect(ended.chain).toEqual([]);
	expect(ended.restoration).toEqual(parent.data.restoration);
	expect(() => replayWorkflowChain([...entries, nested])).toThrow("already");
	const replacement = root(2);
	replacement.data.workflow.id = "replacement";
	const replaced = replayWorkflowChain([...entries, replacement]);
	expect(replaced.chain).toHaveLength(1);
});

test("requires journal2 operation versions after a journal2 root", () => {
	expect(() =>
		replayWorkflowChain([
			root(2),
			operation({ kind: "transitioned", route: ["start", "done"] }),
		]),
	).toThrow("journalVersion");
});
