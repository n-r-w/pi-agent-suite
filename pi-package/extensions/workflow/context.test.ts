import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectBranch } from "../../../test/support/session-projection";
import {
	hasVisibleWorkflowGraph,
	WorkflowJournal,
	type WorkflowJournalRecord,
} from "./context";
import {
	createWorkflow,
	editWorkflowStage,
	transitionWorkflow,
	validateWorkflowDefinition,
} from "./workflow";

function workflow(description = "Build & review") {
	return validateWorkflowDefinition(
		"delivery",
		{
			description,
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

/** Returns the item of a test array at an index that the test knows to exist. */
function requireItem<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) {
		throw new Error(`missing item ${index}`);
	}
	return item;
}

/** Creates a journal that appends each record to a real Pi session, so that tests can compact the session. */
function createSessionJournal() {
	const session = SessionManager.inMemory();
	const records: WorkflowJournalRecord[] = [];
	const ids: string[] = [];
	const journal = new WorkflowJournal((record) => {
		records.push(record);
		ids.push(
			session.appendCustomMessageEntry(
				record.customType,
				record.content,
				false,
				record.details,
			),
		);
	});
	const visible = () => session.buildSessionProjection().entries;
	return { session, journal, records, ids, visible };
}

describe("workflow journal", () => {
	test("after compactions reuses only stage rules that the kept entries show", () => {
		// Purpose: a compaction keeps recent entries, and the journal must not repeat stage rules that they show.
		// Input and expected output: the first compaction keeps the review rules only; the second keeps entries from before the first compaction entry on.
		// Edge case: a kept reuse record shows no rules, so it makes no stage known.
		// Dependencies: Pi session projection with compaction and journal restoration.
		const { session, journal, records, ids, visible } = createSessionJournal();
		let state = createWorkflow(workflow());
		journal.activate([state]);
		state = transitionWorkflow(state, "review");
		journal.enterStage([state]);
		session.appendCompaction("first", requireItem(ids, 1), 100);
		journal.restore(visible());
		state = transitionWorkflow(state, "implementation");
		journal.enterStage([state]);
		state = transitionWorkflow(state, "review");
		journal.enterStage([state]);
		session.appendCompaction("second", requireItem(ids, 1), 100);
		journal.restore(visible());
		state = transitionWorkflow(state, "implementation");
		journal.enterStage([state]);

		expect(records.map(({ details }) => details["guidelines"])).toEqual([
			"inline",
			"inline",
			"inline",
			"reuse",
			"reuse",
		]);
	});

	test("omits rules from a checkpoint while the kept entries show them", () => {
		// Purpose: a checkpoint after a compaction repeats only the rules that the kept entries lack.
		// Input and expected output: with the activation kept, the checkpoint has no shared rules, graph, or stage rules; with only this checkpoint kept, the next one has all of them.
		// Dependencies: Pi session projection, graph visibility, and journal restoration.
		const { session, journal, records, ids, visible } = createSessionJournal();
		const state = createWorkflow(workflow());
		journal.activate([state]);
		session.appendCompaction("first", requireItem(ids, 0), 100);
		journal.restore(visible());
		journal.checkpoint([state], visible());
		session.appendCompaction("second", requireItem(ids, 1), 100);
		journal.restore(visible());
		journal.checkpoint([state], visible());

		const [, reused, inlined] = records;
		expect(reused?.content).toContain('guidelines="reuse"');
		expect(reused?.content).not.toContain("Follow &lt;global&gt;");
		expect(reused?.content).not.toContain("<stages>");
		expect(reused?.content).not.toContain("<active_stage_guidelines>");
		expect(inlined?.content).toContain('guidelines="inline"');
		expect(inlined?.content).toContain("Follow &lt;global&gt;");
		expect(inlined?.content).toContain("<stages>");
		expect(inlined?.content).toContain("Implement &lt;carefully&gt;");
	});

	test("does not publish activation options again while the kept entries show them", () => {
		// Purpose: a compaction that keeps the options record must not make the journal publish the same options.
		// Input and expected output: options, a compaction that keeps them, the same options again: one record; a compaction that summarizes them: a second record.
		// Dependencies: Pi session projection and options deduplication.
		const { session, journal, records, ids, visible } = createSessionJournal();
		journal.activationOptions([workflow()]);
		session.appendCompaction("first", requireItem(ids, 0), 100);
		journal.restore(visible());
		journal.activationOptions([workflow()]);
		expect(
			journal.activationOptionsForRun([workflow()], visible()),
		).toBeUndefined();
		const marker = session.appendCustomMessageEntry("note", "later", false, {});
		session.appendCompaction("second", marker, 100);
		journal.restore(visible());
		journal.activationOptions([workflow()]);

		expect(records).toHaveLength(2);
	});

	/** Checks graph visibility against Pi's real compaction and context-edit projection. */
	test("recognizes only model-visible graph records of the same workflow", () => {
		const session = SessionManager.inMemory();
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		journal.activate([state]);
		const activation = records[0];
		if (activation === undefined) {
			throw new Error("missing activation");
		}
		const activationId = session.appendCustomMessageEntry(
			activation.customType,
			activation.content,
			false,
			activation.details,
		);
		const entries = () => session.buildSessionProjection().entries;
		expect(hasVisibleWorkflowGraph(state, entries())).toBe(true);
		expect(
			hasVisibleWorkflowGraph(
				{
					...state,
					workflow: { ...state.workflow, id: "other" },
				},
				entries(),
			),
		).toBe(false);
		session.appendCompaction("summary", activationId, 100);
		journal.checkpoint([state], entries());
		expect(records.at(-1)?.details["includesGraph"]).toBe(false);
		session.appendContextEdit(activationId, null);
		expect(hasVisibleWorkflowGraph(state, entries())).toBe(false);

		const edited = editWorkflowStage(
			state,
			{
				stageId: "review",
				description: "Edited review",
				prompt: "Edited guidance",
				model: { thinking: "medium" },
			},
			"fixture",
		);
		const finalState = transitionWorkflow(edited, "review");
		journal.checkpoint([finalState], entries());
		const checkpoint = records.at(-1);
		expect(checkpoint?.details).toMatchObject({
			status: "active",
			includesGraph: true,
		});
		if (checkpoint === undefined) {
			throw new Error("missing checkpoint");
		}
		const checkpointId = session.appendCustomMessageEntry(
			checkpoint.customType,
			checkpoint.content,
			false,
			checkpoint.details,
		);
		expect(hasVisibleWorkflowGraph(finalState, entries())).toBe(true);
		session.appendCompaction("next summary", checkpointId, 100);
		journal.checkpoint([finalState], entries());
		expect(records.at(-1)?.details["includesGraph"]).toBe(false);
	});

	test("retries an unpersisted run message and deduplicates only against branch evidence", () => {
		// Purpose: preparing an initial message must not make a cancelled run look persisted.
		// Input/output: two preparations on empty history return records; recorded history suppresses the third.
		// Edge cases: returning to an empty branch and crossing branch_summary require a new record.
		// Dependencies: production journal, isolated history records, and a fake publisher.
		const { journal, records } = createJournal();
		const candidate = journal.activationOptionsForRun([workflow()], []);
		expect(candidate?.details).toMatchObject({
			version: 1,
			kind: "activation_options",
		});
		expect(journal.activationOptionsForRun([workflow()], [])?.details).toEqual(
			candidate?.details,
		);
		expect(records).toHaveLength(0);
		const branch = [{ type: "custom_message", ...candidate }];
		expect(
			journal.activationOptionsForRun([workflow()], projectBranch(branch)),
		).toBeUndefined();
		expect(
			journal.activationOptionsForRun(
				[workflow()],
				projectBranch([...branch, { type: "branch_summary" }]),
			)?.details,
		).toEqual(candidate?.details);
		expect(journal.activationOptionsForRun([], [])).toBeUndefined();
	});

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

		journal.reminder([escapedState]);

		expect(records).toMatchObject([
			{
				customType: "workflow",
				content: expect.any(String),
				display: false,
				details: {
					version: 1,
					kind: "reminder",
					workflowId: 'delivery&"',
					status: "active",
					currentStageId: stageId,
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
		journal.activate([createWorkflow(workflow())]);

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
		journal.activate([state]);
		state = transitionWorkflow(state, "review");
		journal.enterStage([state]);
		state = transitionWorkflow(state, "implementation");
		journal.enterStage([state]);
		state = transitionWorkflow(state, "review");
		journal.enterStage([state]);

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

	test("reuses known stage definitions in a later run of the same workflow", () => {
		// Purpose: a workflow that runs again in the same context segment must not repeat stage prompts that the context holds.
		// Input and expected output: a run through both stages and its exit, then a second run; each stage of the second run reuses its definition.
		// Edge case: the second activation still carries the root guidance and the graph, and a journal restored from the records keeps the knowledge.
		// Dependencies: journal-local known-stage tracking and journal restoration.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate([state]);
		journal.enterStage([transitionWorkflow(state, "review")]);
		journal.exit();
		const restored = new WorkflowJournal((record) => records.push(record));
		restored.restore(
			projectBranch(
				records.map((message) => ({ type: "custom_message", ...message })),
			),
		);

		for (const current of [journal, restored]) {
			const start = records.length;
			state = createWorkflow(workflow());
			current.activate([state]);
			current.enterStage([transitionWorkflow(state, "review")]);
			const [activation, review] = records.slice(start);
			expect(activation?.content).toContain(
				"Follow &lt;global&gt; &amp; stay safe.",
			);
			expect(activation?.content).toContain(
				'stage_id="implementation" guidelines="reuse"',
			);
			expect(activation?.content).not.toContain("Implement &lt;carefully&gt;");
			expect(activation?.details["guidelines"]).toBe("reuse");
			expect(review?.content).toContain('stage_id="review" guidelines="reuse"');
		}
	});

	test("publishes edited stage definitions and explicit exit records", () => {
		// Edits publish the revised definition, and exit clears the journal's active-workflow evidence.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate([state]);
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
		journal.updateStage([state], "implementation");
		state = transitionWorkflow(state, "review");
		journal.enterStage([state]);
		journal.exit();

		expect(records[1]?.content).toContain(
			'<workflow_stage_updated workflow_id="delivery" stage_id="implementation" active="true">',
		);
		expect(records[1]?.content).toContain(
			'<stage_definition description="Implement corrected change" initial="true">',
		);
		expect(records[1]?.content).toContain(
			"Use corrected &lt;requirements&gt;.",
		);
		expect(records[3]?.details["kind"]).toBe("exit");
		expect(journal.isCurrent([state])).toBe(false);
	});

	test("restores the active stage after an inactive stage update", () => {
		// Purpose: an inactive-stage definition update must not replace the lifecycle active-stage marker.
		// Input and expected output: activation plus an inactive review edit restores as compatible with implementation still active.
		// Edge case: the edited stage ID differs from the route tail.
		// Dependencies: journal metadata restoration and dynamic stage editing.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate([state]);
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
		journal.updateStage([state], "review");
		const restored = new WorkflowJournal(() => {});
		restored.restore(
			projectBranch(
				records.map((message) => ({ type: "custom_message", ...message })),
			),
		);

		expect(restored.isCurrent([state])).toBe(true);
	});

	test("rejects restoration that omits the latest stage definition edit", () => {
		// Purpose: restoration repair must detect state that is newer than the latest model-facing workflow record.
		// Input and expected output: activation records followed by an unrecorded stage edit are incompatible with edited state.
		// Edge case: workflow ID, status, and route-tail stage remain unchanged across the edit.
		// Dependencies: whole-chain compatibility metadata and journal restoration.
		const { journal, records } = createJournal();
		let state = createWorkflow(workflow());
		journal.activate([state]);
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
			projectBranch(
				records.map((message) => ({ type: "custom_message", ...message })),
			),
		);

		expect(restored.isCurrent([state])).toBe(false);
	});

	test("publishes activation options only when the segment value changes", () => {
		// Purpose: activation options publish only a new segment value or a replacement for a prior value.
		// Input and expected output: initial empty, repeated empty, restored equal, and changed values produce the listed record counts.
		// Edge cases: empty replacement follows non-empty options, and restored non-empty options remain deduplicated.
		// Dependencies: journal restoration and activation-options metadata.
		const cases = [
			{
				name: "initial empty",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([]);
					return records;
				},
				expectedCount: 0,
			},
			{
				name: "initial non-empty",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([workflow()]);
					return records;
				},
				expectedCount: 1,
			},
			{
				name: "non-empty replacement",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([workflow()]);
					journal.activationOptions([]);
					return records;
				},
				expectedCount: 2,
			},
			{
				name: "non-empty after empty replacement",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([workflow()]);
					journal.activationOptions([]);
					journal.activationOptions([workflow()]);
					return records;
				},
				expectedCount: 3,
			},
			{
				name: "repeated empty replacement",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([workflow()]);
					journal.activationOptions([]);
					journal.activationOptions([]);
					return records;
				},
				expectedCount: 2,
			},
			{
				name: "restored non-empty",
				run: () => {
					const source = createJournal();
					source.journal.activationOptions([workflow()]);
					const restored = createJournal();
					restored.journal.restore(
						projectBranch(
							source.records.map((record) => ({
								type: "custom_message",
								...record,
							})),
						),
					);
					restored.journal.activationOptions([workflow()]);
					return restored.records;
				},
				expectedCount: 0,
			},
			{
				name: "changed non-empty",
				run: () => {
					const { journal, records } = createJournal();
					journal.activationOptions([workflow()]);
					journal.activationOptions([workflow("Review delivery")]);
					return records;
				},
				expectedCount: 2,
			},
		] as const;

		for (const testCase of cases) {
			const records = testCase.run();
			expect(records, testCase.name).toHaveLength(testCase.expectedCount);
			expect(
				records.every(
					(record) =>
						record.customType === "workflow" &&
						record.details["kind"] === "activation_options",
				),
				testCase.name,
			).toBe(true);
		}
	});

	test("preserves activation-option deduplication during repair checkpoints", () => {
		// Purpose: branch repair must not republish unchanged catalog availability in the same context segment.
		// Input and expected output: equal options before and after a checkpoint produce one options record.
		// Edge case: checkpoint still publishes the complete active workflow state.
		// Dependencies: checkpoint lifecycle rendering and activation-options deduplication.
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		journal.activationOptions([workflow()]);
		journal.checkpoint([state]);
		journal.activationOptions([workflow()]);

		expect(records).toHaveLength(2);
		expect(records[0]?.content).toContain("<workflow_activation_options>");
		expect(records[1]?.content).toContain("<workflow_checkpoint");
	});

	test("inlines unseen stage rules at checkpoints and deduplicates activation options", () => {
		// Purpose: a checkpoint must inline current instructions that the context lacks, and availability must change only when its rendered value changes.
		// Input and expected output: one active checkpoint is followed by one options record despite two equivalent publications.
		// Edge case: an empty options list emits the explicit self-closing replacement record.
		// Dependencies: checkpoint rendering, known-stage tracking, and ordered catalog options.
		const { journal, records } = createJournal();
		const state = createWorkflow(workflow());
		journal.checkpoint([state]);
		journal.activationOptions([workflow()]);
		journal.activationOptions([workflow()]);
		journal.activationOptions([]);

		expect(records[0]?.content).toContain(
			'<workflow_checkpoint id="delivery" status="active" active_stage_id="implementation" guidelines="inline">',
		);
		expect(records[0]?.content).toContain("<active_stage_guidelines>");
		expect(records[1]?.content).toContain(
			'<workflow id="delivery" description="Build &amp; review" />',
		);
		expect(records[2]?.content).toBe("<workflow_activation_options />");
		expect(records).toHaveLength(3);
	});
});
