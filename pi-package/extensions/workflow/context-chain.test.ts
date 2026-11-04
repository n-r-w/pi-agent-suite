import { expect, test } from "bun:test";
import { projectBranch } from "../../../test/support/session-projection";
import { WorkflowJournal, type WorkflowJournalRecord } from "./context";
import {
	createWorkflow,
	editWorkflowStage,
	type WorkflowState,
} from "./workflow";

/** Builds same-stage-ID workflows to detect cross-workflow instruction reuse. */
function state(id: string, nested = false): WorkflowState {
	return createWorkflow({
		id,
		version: 3,
		nested,
		description: id,
		stages: [
			{
				id: "start",
				description: "Start",
				goal: "Ready",
				prompt: "Work",
				model: { thinking: "medium" },
				triggers: [],
				initial: true,
				final: true,
			},
		],
		transitions: [],
	});
}

/** Captures records at the journal's append-only publication boundary. */
function capture() {
	const records: WorkflowJournalRecord[] = [];
	return {
		records,
		journal: new WorkflowJournal((record) => records.push(record)),
	};
}

test("journal scopes known stages to each workflow and preserves published records", () => {
	const { journal, records } = capture();
	const parent = state("parent");
	const child = state("child", true);
	journal.activate([parent]);
	const original = JSON.stringify(records);
	journal.activate([parent, child]);
	expect(records.at(-1)?.details).toMatchObject({
		workflowId: "child",
		currentStageId: "start",
		guidelines: "inline",
	});
	expect(journal.isCurrent([parent, child])).toBe(true);
	expect(JSON.stringify(records.slice(0, 1))).toBe(original);
	journal.enterStage([parent]);
	expect(records.at(-1)?.details).toMatchObject({
		workflowId: "parent",
		guidelines: "reuse",
	});
	journal.exit();
	expect(records.at(-1)?.details).toMatchObject({ kind: "exit" });
});

test("chain revision detects waiting parent edits and checkpoints retain all definitions", () => {
	const { journal, records } = capture();
	const parent = state("parent");
	const child = state("child", true);
	journal.activate([parent]);
	journal.activate([parent, child]);
	const history = records.map((record) => ({
		type: "custom_message",
		...record,
	}));
	const restored = capture();
	restored.journal.restore(projectBranch(history));
	expect(restored.journal.isCurrent([parent, child])).toBe(true);
	const changed = editWorkflowStage(
		parent,
		{
			stageId: "start",
			description: "Changed",
			goal: "Ready",
			prompt: "Edited",
			model: { thinking: "low" },
		},
		"fixture",
	);
	expect(restored.journal.isCurrent([changed, child])).toBe(false);
	restored.journal.restore([]);
	restored.journal.checkpoint([changed, child]);
	expect(restored.records.at(-1)?.details).toMatchObject({
		kind: "checkpoint",
		workflowId: "child",
		currentStageId: "start",
		graphWorkflowIds: ["parent", "child"],
	});
	restored.journal.enterStage([changed]);
	expect(restored.records.at(-1)?.details["guidelines"]).toBe("inline");
});

test("activation options deliver nested markers before first start and deduplicate unchanged options", () => {
	const { journal, records } = capture();
	journal.activationOptions([
		state("parent").workflow,
		state("child", true).workflow,
	]);
	expect(records[0]?.details).toMatchObject({ kind: "activation_options" });
	const attributes = [
		...(records[0]?.content ?? "").matchAll(/<workflow\s+([^>]+)\/>/g),
	].map((match) =>
		Object.fromEntries(
			[...(match[1] ?? "").matchAll(/([a-z_]+)="([^"]*)"/g)].map(
				(attribute) => [attribute[1], attribute[2]],
			),
		),
	);
	expect(
		attributes.map(({ id, nested }) => ({ id, nested: nested === "true" })),
	).toEqual([
		{ id: "parent", nested: false },
		{ id: "child", nested: true },
	]);
	journal.activationOptions([
		state("parent").workflow,
		state("child", true).workflow,
	]);
	expect(records).toHaveLength(1);
});

test("journal recognizes a restored chain whose items hold the same fields in another order", () => {
	const { journal } = capture();
	const restoration = { modelId: "openai/gpt-5", thinking: "medium" } as const;
	const pendingTransition = { stageId: "review" };
	const parent = { ...state("parent"), restoration };
	const child = state("child", true);
	// A bound start builds the item with its pending transition before the restoration snapshot.
	const live = { ...child, pendingTransition, restoration };
	// Replay of the saved start builds the same item with the restoration snapshot first.
	const replayed = { ...child, restoration, pendingTransition };
	journal.activate([parent, live]);
	expect(journal.isCurrent([parent, replayed])).toBe(true);
});
