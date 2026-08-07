import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractWorkflowStatus } from "./workflow-status";

/** Creates a workflow-state custom entry for testing. */
function workflowStateEntry(data: unknown, id: string = "entry"): SessionEntry {
	return {
		type: "custom",
		customType: "workflow-state",
		data,
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

/** Creates a message entry for testing mixed-entry scenarios. */
function messageEntry(id: string = "msg"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	} as unknown as SessionEntry;
}

/** Creates a non-workflow custom entry for testing customType filtering. */
function otherCustomEntry(id: string = "other"): SessionEntry {
	return {
		type: "custom",
		customType: "other-type",
		data: {},
		id,
		parentId: null,
		timestamp: "2024-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

const SAMPLE_WORKFLOW = {
	id: "InformationExtraction",
	description: "Extract information",
	stages: [
		{ id: "define_target", description: "Define requested extraction result" },
		{
			id: "identify_sources",
			description: "Identify relevant source locations",
		},
		{ id: "generate_output", description: "Generate output artifact" },
	],
};

const SAMPLE_WORKFLOW_B = {
	id: "Analysis",
	description: "Analysis workflow",
	stages: [
		{ id: "a_stage", description: "A Stage" },
		{ id: "b_stage", description: "B Stage" },
	],
};

describe("extractWorkflowStatus", () => {
	test("extracts workflow ID and initial stage from created entry", () => {
		const result = extractWorkflowStatus([
			workflowStateEntry({
				kind: "created",
				workflow: SAMPLE_WORKFLOW,
				route: ["define_target"],
			}),
		]);
		expect(result).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});

	test("extracts workflow ID and initial stage from activated entry", () => {
		const result = extractWorkflowStatus([
			workflowStateEntry({
				kind: "activated",
				workflow: SAMPLE_WORKFLOW,
				route: ["define_target"],
			}),
		]);
		expect(result).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});

	test("uses workflow definition from created with route from transitioned", () => {
		const result = extractWorkflowStatus([
			workflowStateEntry(
				{
					kind: "created",
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				},
				"entry-1",
			),
			workflowStateEntry(
				{
					kind: "transitioned",
					route: ["define_target", "identify_sources"],
				},
				"entry-2",
			),
		]);
		expect(result).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Identify relevant source locations",
		});
	});

	test("latest transition wins for active stage", () => {
		const result = extractWorkflowStatus([
			workflowStateEntry(
				{
					kind: "created",
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				},
				"entry-1",
			),
			workflowStateEntry(
				{
					kind: "transitioned",
					route: ["define_target", "identify_sources"],
				},
				"entry-2",
			),
			workflowStateEntry(
				{
					kind: "transitioned",
					route: ["define_target", "identify_sources", "generate_output"],
				},
				"entry-3",
			),
		]);
		expect(result).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Generate output artifact",
		});
	});

	test("returns undefined when no workflow-state entries exist", () => {
		expect(
			extractWorkflowStatus([messageEntry(), otherCustomEntry()]),
		).toBeUndefined();
	});

	test("returns undefined for empty entries", () => {
		expect(extractWorkflowStatus([])).toBeUndefined();
	});

	test("returns undefined when transitioned entry has no prior created or activated", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "transitioned",
					route: ["stage1", "stage2"],
				}),
			]),
		).toBeUndefined();
	});

	test("returns undefined when active stage ID not found in stages", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "created",
					workflow: SAMPLE_WORKFLOW,
					route: ["unknown_stage"],
				}),
			]),
		).toBeUndefined();
	});

	test("returns undefined when route is empty", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "created",
					workflow: SAMPLE_WORKFLOW,
					route: [],
				}),
			]),
		).toBeUndefined();
	});

	test("ignores corrupted workflow-state entries and uses valid ones", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry("not-an-object", "bad-1"),
				workflowStateEntry({ kind: "invalid" }, "bad-2"),
				workflowStateEntry(
					{
						kind: "created",
						workflow: SAMPLE_WORKFLOW,
						route: ["define_target"],
					},
					"good-1",
				),
			]),
		).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});

	test("ignores workflow with non-string id", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "created",
					workflow: { id: 123, stages: SAMPLE_WORKFLOW.stages },
					route: ["define_target"],
				}),
			]),
		).toBeUndefined();
	});

	test("ignores route that is not an array of strings", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "created",
					workflow: SAMPLE_WORKFLOW,
					route: "define_target",
				}),
			]),
		).toBeUndefined();
	});

	test("handles mixed message and workflow-state entries", () => {
		expect(
			extractWorkflowStatus([
				messageEntry("msg-1"),
				workflowStateEntry(
					{
						kind: "activated",
						workflow: SAMPLE_WORKFLOW,
						route: ["define_target"],
					},
					"wf-1",
				),
				messageEntry("msg-2"),
				otherCustomEntry("other-1"),
			]),
		).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});

	test("latest activation replaces previous workflow definition", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry(
					{
						kind: "activated",
						workflow: SAMPLE_WORKFLOW,
						route: ["define_target"],
					},
					"entry-1",
				),
				workflowStateEntry(
					{
						kind: "activated",
						workflow: SAMPLE_WORKFLOW_B,
						route: ["a_stage"],
					},
					"entry-2",
				),
			]),
		).toEqual({
			workflowId: "Analysis",
			stageDescription: "A Stage",
		});
	});

	test("ignores workflow-state entries with missing data field", () => {
		const entry = {
			type: "custom",
			customType: "workflow-state",
			id: "no-data",
			parentId: null,
			timestamp: "2024-01-01T00:00:00.000Z",
		} as unknown as SessionEntry;
		expect(extractWorkflowStatus([entry])).toBeUndefined();
	});

	test("ignores entries with non-object data", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry(42),
				workflowStateEntry(
					{
						kind: "created",
						workflow: SAMPLE_WORKFLOW,
						route: ["define_target"],
					},
					"good",
				),
			]),
		).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});
});
