import { describe, expect, test } from "bun:test";
import { WorkflowJournal, type WorkflowJournalRecord } from "./context";
import {
	completeWorkflow,
	createWorkflow,
	editWorkflowStage,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
} from "./workflow";

function workflow() {
	return validateCreatedWorkflowDefinition(
		{
			id: "delivery",
			description: "Build & review",
			prompt: "Follow <global> & stay safe.",
			stages: [
				{
					id: "implementation",
					description: 'Implement "now"',
					prompt: "Implement <carefully>",
					model: { thinking: "medium" },
					initial: true,
				},
				{
					id: "review",
					description: "Review result",
					prompt: "Review & finish",
					model: { thinking: "medium" },
					final: true,
				},
			],
			transitions: [
				{ from: "implementation", to: "review", type: "advance" },
				{ from: "review", to: "implementation", type: "rework" },
			],
		},
		"fixture",
	);
}

function createJournal(): {
	readonly journal: WorkflowJournal;
	readonly records: WorkflowJournalRecord[];
} {
	const records: WorkflowJournalRecord[] = [];
	return {
		journal: new WorkflowJournal((record) => records.push(record)),
		records,
	};
}

describe("workflow journal", () => {
	/**
	 * Proves a reminder publishes only escaped current identifiers and reminder metadata.
	 * Input and expected output: active state with XML-sensitive IDs emits one self-closing marker.
	 * Edge case: ampersands and quotes are escaped in both identifier attributes.
	 * Dependencies: active workflow state and the journal publisher callback.
	 */
	test("publishes a compact active workflow reminder", () => {
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		const stageId = 'implementation&"';
		const escapedState = {
			...state,
			workflow: {
				...state.workflow,
				id: 'delivery&"',
				stages: state.workflow.stages.map((stage, index) =>
					index === 0 ? { ...stage, id: stageId } : stage,
				),
			},
			route: [stageId],
		};

		journal.reminder(escapedState);

		expect(records).toEqual([
			{
				customType: "workflow",
				content:
					'<workflow_reminder id="delivery&amp;&quot;" active_stage_id="implementation&amp;&quot;" />',
				display: false,
				details: {
					version: 1,
					kind: "reminder",
					workflowId: 'delivery&"',
					status: "active",
					currentStageId: stageId,
					workflowRevision: expect.any(String),
					stageId,
				},
			},
		]);
	});

	test("publishes activation and the initial stage definition in one hidden record", () => {
		// Purpose: workflow activation must establish the complete graph and current-stage instructions once.
		// Input and expected output: a dynamic workflow emits workflow_activated followed by an inline initial-stage activation.
		// Edge case: XML-sensitive configured text is escaped and the inactive-stage prompt is not exposed.
		// Dependencies: validated workflow state and the journal publisher callback.
		const { journal, records } = createJournal();
		journal.activate(createWorkflow(workflow()));

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			customType: "workflow",
			display: false,
			details: {
				version: 1,
				kind: "activation",
				workflowId: "delivery",
				stageId: "implementation",
			},
		});
		const content = records[0]?.content ?? "";
		expect(content.indexOf("<workflow_activated")).toBeLessThan(
			content.indexOf("<workflow_stage_activated"),
		);
		expect(content).toContain('id="delivery" source="dynamic"');
		expect(content).toContain("Follow &lt;global&gt; &amp; stay safe.");
		expect(content).toContain(
			'id="implementation" description="Implement &quot;now&quot;" initial="true"',
		);
		expect(content).toContain('guidelines="inline"');
		expect(content).toContain("Implement &lt;carefully&gt;");
		expect(content).not.toContain("Review &amp; finish");
	});

	test("reuses known stage definitions while repeating route-dependent transitions", () => {
		// Purpose: repeated stage entry must preserve activation history without repeating stage prompts.
		// Input and expected output: first review entry is inline, then rework and advance entries reuse known definitions.
		// Edge case: every activation still carries its current outgoing transition.
		// Dependencies: immutable workflow transitions and journal-local known-stage tracking.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate(state);
		state = transitionWorkflow(state, "review");
		journal.enterStage(state);
		state = transitionWorkflow(state, "implementation");
		journal.enterStage(state);
		state = transitionWorkflow(state, "review");
		journal.enterStage(state);

		expect(records[1]?.content).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="review" guidelines="inline">',
		);
		expect(records[1]?.content).toContain("Review &amp; finish");
		expect(records[2]?.content).toContain('guidelines="reuse"');
		expect(records[2]?.content).toContain(
			'<transition to="review" type="advance" />',
		);
		expect(records[3]?.content).toContain('guidelines="reuse"');
		expect(records[3]?.content).toContain(
			'<transition to="implementation" type="rework" />',
		);
	});

	test("publishes complete edited stage definitions and completion records", () => {
		// Purpose: edits and completion must replace model-visible stage data without snapshot repetition.
		// Input and expected output: one active-stage edit emits a complete update, then final completion emits rework options.
		// Edge case: completion carries no completed-stage prompt.
		// Dependencies: dynamic stage editing, transition validation, and workflow completion.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate(state);
		state = editWorkflowStage(
			state,
			{
				stageId: "implementation",
				description: "Implement corrected change",
				prompt: "Use corrected <requirements>.",
				model: { thinking: "high" },
			},
			"test",
		);
		journal.updateStage(state, "implementation");
		state = transitionWorkflow(state, "review");
		journal.enterStage(state);
		const completed = completeWorkflow(state);
		journal.complete(completed);

		expect(records[1]?.content).toContain(
			'<workflow_stage_updated workflow_id="delivery" stage_id="implementation" active="true">',
		);
		expect(records[1]?.content).toContain(
			'<stage_definition description="Implement corrected change" initial="true">',
		);
		expect(records[1]?.content).toContain(
			"Use corrected &lt;requirements&gt;.",
		);
		expect(records[3]?.content).toContain(
			'<workflow_completed id="delivery" completed_stage_id="review">',
		);
		expect(records[3]?.content).toContain(
			'<transition to="implementation" type="rework" />',
		);
		expect(records[3]?.content).not.toContain("Review &amp; finish");
	});

	test("restores the active stage after an inactive stage update", () => {
		// Purpose: an inactive-stage definition update must not replace the lifecycle active-stage marker.
		// Input and expected output: activation plus an inactive review edit restores as compatible with implementation still active.
		// Edge case: the edited stage ID differs from the route tail.
		// Dependencies: journal metadata restoration and dynamic stage editing.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate(state);
		state = editWorkflowStage(
			state,
			{
				stageId: "review",
				description: "Revised review",
				prompt: "Use revised review.",
				model: { thinking: "high" },
			},
			"test",
		);
		journal.updateStage(state, "review");
		const restored = new WorkflowJournal(() => {});
		restored.restore(
			records.map((message) => ({
				type: "custom_message",
				...message,
			})),
		);

		expect(restored.isCurrent(state)).toBe(true);
	});

	test("rejects restoration that omits the latest stage definition edit", () => {
		// Purpose: restoration repair must detect state that is newer than the latest model-facing workflow record.
		// Input and expected output: activation records followed by an unrecorded stage edit are incompatible with edited state.
		// Edge case: workflow ID, status, and route-tail stage remain unchanged across the edit.
		// Dependencies: workflow-definition revision metadata and journal restoration.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate(state);
		state = editWorkflowStage(
			state,
			{
				stageId: "implementation",
				description: "Unrecorded correction",
				prompt: "Use the corrected definition.",
				model: { thinking: "high" },
			},
			"test",
		);
		const restored = new WorkflowJournal(() => {});
		restored.restore(
			records.map((message) => ({
				type: "custom_message",
				...message,
			})),
		);

		expect(restored.isCurrent(state)).toBe(false);
	});

	test("preserves activation-option deduplication during repair checkpoints", () => {
		// Purpose: branch repair must not republish unchanged catalog availability in the same context segment.
		// Input and expected output: equal options before and after a checkpoint produce one options record.
		// Edge case: checkpoint still publishes the complete active workflow state.
		// Dependencies: checkpoint lifecycle rendering and activation-options deduplication.
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		journal.activationOptions([workflow()]);
		journal.checkpoint(state);
		journal.activationOptions([workflow()]);

		expect(records).toHaveLength(2);
		expect(records[0]?.content).toContain("<workflow_activation_options>");
		expect(records[1]?.content).toContain("<workflow_checkpoint");
	});

	test("resets known stages at checkpoints and deduplicates activation options", () => {
		// Purpose: compaction repair must inline current instructions and availability must change only when its rendered value changes.
		// Input and expected output: one active checkpoint is followed by one options record despite two equivalent publications.
		// Edge case: an empty options list emits the explicit self-closing replacement record.
		// Dependencies: checkpoint rendering, known-stage reset, and ordered catalog options.
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		journal.checkpoint(state);
		journal.activationOptions([workflow()]);
		journal.activationOptions([workflow()]);
		journal.activationOptions([]);

		expect(records[0]?.content).toContain(
			'<workflow_checkpoint id="delivery" status="active" active_stage_id="implementation">',
		);
		expect(records[0]?.content).toContain("<active_stage_guidelines>");
		expect(records[1]?.content).toContain(
			'<workflow id="delivery" description="Build &amp; review" />',
		);
		expect(records[2]?.content).toBe("<workflow_activation_options />");
		expect(records).toHaveLength(3);
	});
});
