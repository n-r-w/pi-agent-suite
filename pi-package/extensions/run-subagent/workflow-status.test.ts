import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractWorkflowStatus } from "./workflow-status";

/** Creates a workflow-state custom entry for testing. */
function workflowStateEntry(data: unknown, id: string = "entry"): SessionEntry {
	return {
		type: "custom",
		customType: "workflow-state",
		data:
			typeof data === "object" &&
			data !== null &&
			(Reflect.get(data, "kind") === "created" ||
				Reflect.get(data, "kind") === "activated")
				? { journalVersion: 1, ...data }
				: data,
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
	test("projects nested top edits, returns to waiting parents, and replaces the whole chain", () => {
		const parent = workflowStateEntry({
			kind: "activated",
			workflow: SAMPLE_WORKFLOW,
			route: ["define_target", "identify_sources"],
		});
		const child = workflowStateEntry({
			kind: "created",
			journalVersion: 2,
			mode: "push",
			workflow: { ...SAMPLE_WORKFLOW, id: "child", version: 3, nested: true },
			route: ["define_target"],
		});
		const edited = workflowStateEntry({
			kind: "stage_edited",
			journalVersion: 2,
			stageId: "define_target",
			description: "Edited child",
		});
		const exited = workflowStateEntry({ kind: "exited", journalVersion: 2 });
		expect(extractWorkflowStatus([parent, child, edited])).toEqual({
			workflowId: "child",
			stageDescription: "Edited child",
		});
		expect(extractWorkflowStatus([parent, child, edited, exited])).toEqual({
			workflowId: SAMPLE_WORKFLOW.id,
			stageDescription: "Identify relevant source locations",
		});
		expect(
			extractWorkflowStatus([parent, child, edited, exited, exited]),
		).toBeUndefined();
		const replacement = workflowStateEntry({
			kind: "activated",
			journalVersion: 2,
			mode: "replace",
			workflow: SAMPLE_WORKFLOW_B,
			route: ["a_stage"],
		});
		expect(
			extractWorkflowStatus([parent, child, replacement, exited]),
		).toBeUndefined();
	});
	test.each([
		"exited",
		"completed",
	])("clears workflow after %s and ignores stale routes", (kind) => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "activated",
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				}),
				workflowStateEntry({
					kind,
					...(kind === "exited"
						? { journalVersion: 2 }
						: { route: ["define_target", "generate_output"] }),
				}),
				workflowStateEntry({
					kind: "transitioned",
					journalVersion: 2,
					route: ["define_target"],
				}),
			]),
		).toBeUndefined();
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
	)("retains prior status at unsupported exit boundary %j", ({
		rootVersion,
		kind,
		operationVersion,
	}) => {
		const entries = [
			workflowStateEntry({
				kind: "activated",
				journalVersion: rootVersion,
				workflow: SAMPLE_WORKFLOW,
				route: ["define_target"],
			}),
			workflowStateEntry({
				kind: "transitioned",
				journalVersion: 2,
				route: ["define_target", "generate_output"],
			}),
		];
		expect(
			extractWorkflowStatus([
				...entries,
				workflowStateEntry({
					kind,
					...(operationVersion === undefined
						? {}
						: { journalVersion: operationVersion }),
					...(kind === "completed"
						? { route: ["define_target", "generate_output"] }
						: {}),
				}),
			]),
		).toEqual({
			workflowId: SAMPLE_WORKFLOW.id,
			stageDescription: "Generate output artifact",
		});
	});

	test("restores the active stage after historical version1 completed rework", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "activated",
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				}),
				workflowStateEntry({
					kind: "completed",
					route: ["define_target", "generate_output"],
				}),
				workflowStateEntry({ kind: "transitioned", route: ["define_target"] }),
			]),
		).toEqual({
			workflowId: "InformationExtraction",
			stageDescription: "Define requested extraction result",
		});
	});

	test("ignores missing-version roots and resumes a mixed session", () => {
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "activated",
					journalVersion: undefined,
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				}),
			]),
		).toBeUndefined();
		expect(
			extractWorkflowStatus([
				workflowStateEntry({
					kind: "activated",
					workflow: SAMPLE_WORKFLOW,
					route: ["define_target"],
				}),
				workflowStateEntry({
					kind: "completed",
					route: ["define_target", "generate_output"],
				}),
				workflowStateEntry({
					kind: "activated",
					journalVersion: 2,
					workflow: SAMPLE_WORKFLOW_B,
					route: ["a_stage"],
				}),
				workflowStateEntry({
					kind: "transitioned",
					journalVersion: 2,
					route: ["a_stage", "b_stage"],
				}),
			]),
		).toEqual({ workflowId: "Analysis", stageDescription: "B Stage" });
	});
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
