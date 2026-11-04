import { createHash } from "node:crypto";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { groupWorkflowActivationOptions } from "./activation-options";
import type { WorkflowKind } from "./kinds";
import {
	getAvailableTransitions,
	getTopWorkflow,
	type PendingWorkflowTransition,
	type WorkflowChain,
	type WorkflowDefinition,
	type WorkflowStage,
	type WorkflowState,
	type WorkflowTransition,
} from "./workflow";

export interface WorkflowJournalRecord {
	readonly customType: "workflow";
	readonly content: string;
	readonly display: false;
	readonly details: Readonly<Record<string, unknown>>;
}

export type WorkflowJournalDelivery = "steer" | "nextTurn";

type WorkflowJournalKind =
	| "activation"
	| "stage_activation"
	| "stage_update"
	| "exit"
	| "checkpoint"
	| "reminder"
	| "activation_options";

/** Publishes append-only hidden workflow records and tracks definitions known in the current context segment. */
export class WorkflowJournal {
	private readonly knownStages = new Set<string>();
	private currentChainRevision: string | undefined;
	private activationOptionsContent: string | undefined;

	public constructor(
		private readonly publish: (
			record: WorkflowJournalRecord,
			delivery: WorkflowJournalDelivery,
			triggerTurn?: boolean,
		) => void,
		private readonly kinds: readonly WorkflowKind[] = [],
	) {}

	public activate(chain: WorkflowChain): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		if (chain.length === 1) {
			this.knownStages.clear();
		}
		this.knownStages.add(getStageKey(state, stage));
		this.setCurrentState(chain);
		this.publishRecord(
			renderWorkflowActivation(state, stage),
			"activation",
			chain,
			{ stageId: stage.id, guidelines: "inline" },
		);
	}

	public enterStage(
		chain: WorkflowChain,
		refusedTransition?: PendingWorkflowTransition,
	): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		const key = getStageKey(state, stage);
		const guidelines = this.knownStages.has(key) ? "reuse" : "inline";
		this.knownStages.add(key);
		this.setCurrentState(chain);
		this.publishRecord(
			[
				renderStageActivation(state, stage, guidelines),
				...(refusedTransition === undefined
					? []
					: [
							`<workflow_transition_refused stage_id="${escapeXml(refusedTransition.stageId)}">The requested transition did not happen; continue this stage.</workflow_transition_refused>`,
						]),
			].join("\n"),
			"stage_activation",
			chain,
			{
				stageId: stage.id,
				guidelines,
				...(refusedTransition === undefined ? {} : { refusedTransition }),
			},
		);
	}

	public updateStage(chain: WorkflowChain, stageId: string): void {
		const state = requireTopWorkflow(chain);
		const stage = state.workflow.stages.find(({ id }) => id === stageId);
		if (stage === undefined) {
			throw new Error(`workflow stage does not exist: ${stageId}`);
		}
		this.knownStages.add(getStageKey(state, stage));
		this.setCurrentState(chain);
		this.publishRecord(renderStageUpdate(state, stage), "stage_update", chain, {
			stageId,
			active: state.route.at(-1) === stageId,
		});
	}

	/** Publishes only the current active identifiers without changing journal stage knowledge. */
	public reminder(
		chain: WorkflowChain,
		delivery: WorkflowJournalDelivery = "steer",
	): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		this.setCurrentState(chain);
		this.publishRecord(
			renderWorkflowReminder(state, stage.id),
			"reminder",
			chain,
			{
				stageId: stage.id,
				delivery,
			},
		);
	}

	/** Publishes the absence of a workflow after an explicit exit or restoration. */
	public exit(): void {
		this.knownStages.clear();
		this.currentChainRevision = undefined;
		this.publish(
			{
				customType: "workflow",
				content:
					'<workflow_exited />\n<workflow_state active="false" />\n<workflow_chain />',
				display: false,
				details: { version: 1, kind: "exit" },
			},
			"steer",
			false,
		);
	}

	public checkpoint(
		chain: WorkflowChain,
		projectedEntries: readonly ProjectedSessionEntry[] = [],
		triggerTurn?: boolean,
	): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		const missingGraphs = chain.filter(
			(item) => !hasVisibleWorkflowGraph(item, projectedEntries),
		);
		const includesGraph = missingGraphs.includes(state);
		this.knownStages.clear();
		this.knownStages.add(getStageKey(state, stage));
		this.setCurrentState(chain);
		this.publishRecord(
			[
				...missingGraphs
					.filter((item) => item !== state)
					.map(renderWaitingWorkflow),
				renderWorkflowCheckpoint(state, stage, includesGraph),
			].join("\n"),
			"checkpoint",
			chain,
			{
				stageId: stage.id,
				includesGraph,
				graphWorkflowIds: missingGraphs.map(({ workflow }) => workflow.id),
				...(triggerTurn === undefined ? {} : { triggerTurn }),
			},
		);
	}

	public activationOptions(
		workflows: readonly WorkflowDefinition[],
		triggerTurn?: boolean,
	): void {
		const record = this.prepareActivationOptions(workflows);
		if (record !== undefined) {
			this.publish(record, "steer", triggerTurn);
		}
	}

	/** Restores publication evidence before Pi appends the next run's initial message. */
	public activationOptionsForRun(
		workflows: readonly WorkflowDefinition[],
		branch: readonly unknown[],
	): WorkflowJournalRecord | undefined {
		this.activationOptionsContent = undefined;
		for (const entry of branch.slice(findCurrentContextSegmentStart(branch))) {
			const message = readWorkflowMessage(entry);
			if (
				message?.details["version"] === 1 &&
				message.details["kind"] === "activation_options"
			) {
				this.activationOptionsContent = message.content;
			}
		}
		return this.prepareActivationOptions(workflows);
	}

	/** Deduplicates one candidate against the current context segment. */
	private prepareActivationOptions(
		workflows: readonly WorkflowDefinition[],
	): WorkflowJournalRecord | undefined {
		const content = renderActivationOptions(workflows, this.kinds);
		if (content === this.activationOptionsContent) {
			return;
		}
		// An empty value is useful only when it replaces options published in this context segment.
		if (this.activationOptionsContent === undefined && workflows.length === 0) {
			return;
		}
		this.activationOptionsContent = content;
		return {
			customType: "workflow",
			content,
			display: false,
			details: { version: 1, kind: "activation_options" },
		};
	}

	/** Clears journal-local state when Pi starts a new provider-visible context segment. */
	public startContextSegment(): void {
		this.knownStages.clear();
		this.currentChainRevision = undefined;
		this.activationOptionsContent = undefined;
	}

	/** Rebuilds journal-local deduplication state from the current post-compaction branch segment. */
	public restore(branch: readonly unknown[]): void {
		this.startContextSegment();
		const start = findCurrentContextSegmentStart(branch);
		for (const entry of branch.slice(start)) {
			const message = readWorkflowMessage(entry);
			if (message === undefined) {
				continue;
			}
			this.restoreRecord(message.details, message.content);
		}
	}

	/** Returns whether the current context segment already contains a compatible lifecycle record. */
	public isCurrent(chain: WorkflowChain): boolean {
		return this.currentChainRevision === getChainRevision(chain);
	}

	private restoreRecord(
		details: Readonly<Record<string, unknown>>,
		content: string,
	): void {
		if (details["version"] !== 1) {
			return;
		}
		const kind = details["kind"];
		if (kind === "activation_options") {
			this.activationOptionsContent = content;
			return;
		}
		if (kind === "exit" || kind === "completion") {
			this.knownStages.clear();
			this.currentChainRevision = undefined;
			return;
		}
		const revision = details["chainRevision"];
		const keys = details["knownStageKeys"];
		if (
			typeof revision !== "string" ||
			!Array.isArray(keys) ||
			!keys.every((key) => typeof key === "string")
		) {
			return;
		}
		this.knownStages.clear();
		for (const key of keys) {
			this.knownStages.add(key);
		}
		this.currentChainRevision = revision;
	}

	private setCurrentState(chain: WorkflowChain): void {
		this.currentChainRevision = getChainRevision(chain);
	}

	private publishRecord(
		content: string,
		kind: Exclude<WorkflowJournalKind, "activation_options">,
		chain: WorkflowChain,
		publication: Readonly<Record<string, unknown>> & {
			readonly stageId: string;
			readonly delivery?: WorkflowJournalDelivery;
			readonly triggerTurn?: boolean;
		},
	): void {
		const { delivery = "steer", triggerTurn, ...metadata } = publication;
		const state = requireTopWorkflow(chain);
		const chainView = chain.map((item) => ({
			workflowId: item.workflow.id,
			stageId: item.route.at(-1) ?? "",
			...(item.pendingTransition === undefined
				? {}
				: { pendingTransition: item.pendingTransition }),
		}));
		const pendingTransitions = chain.flatMap((item, index) =>
			item.pendingTransition === undefined
				? []
				: [
						{
							workflowId: item.workflow.id,
							parentWorkflowId: chain[index - 1]?.workflow.id,
							...item.pendingTransition,
						},
					],
		);
		this.publish(
			{
				customType: "workflow",
				content: `${content}\n${renderWorkflowChain(chainView)}`,
				display: false,
				details: {
					version: 1,
					kind,
					workflowId: state.workflow.id,
					status: "active",
					currentStageId: state.route.at(-1),
					chainRevision: getChainRevision(chain),
					knownStageKeys: [...this.knownStages],
					...(pendingTransitions.length === 0 ? {} : { pendingTransitions }),
					...metadata,
				},
			},
			delivery,
			triggerTurn,
		);
	}
}

function renderWorkflowActivation(
	state: WorkflowState,
	stage: WorkflowStage,
): string {
	const workflow = state.workflow;
	return [
		`<workflow_activated id="${escapeXml(workflow.id)}" source="${state.source}">`,
		...renderOptionalGuidelines(workflow.prompt, "guidelines", "  "),
		...renderWorkflowGraph(workflow),
		"</workflow_activated>",
		"",
		renderStageActivation(state, stage, "inline"),
	].join("\n");
}

/** Renders the stage descriptions and transition graph shared by activation and restoration. */
function renderWorkflowGraph(workflow: WorkflowDefinition): readonly string[] {
	const stages = workflow.stages.map((item) => {
		const flags = `${item.initial ? ' initial="true"' : ""}${item.final ? ' final="true"' : ""}`;
		return `    <stage id="${escapeXml(item.id)}" description="${escapeXml(item.description)}"${flags} />`;
	});
	const transitions = workflow.transitions.map(
		(edge) =>
			`    <transition from="${escapeXml(edge.from)}" to="${escapeXml(edge.to)}" type="${edge.type}" />`,
	);
	return [
		"  <stages>",
		...stages,
		"  </stages>",
		"  <transitions>",
		...transitions,
		"  </transitions>",
	];
}

function renderStageActivation(
	state: WorkflowState,
	stage: WorkflowStage,
	guidelines: "inline" | "reuse",
): string {
	return [
		`<workflow_stage_activated workflow_id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(stage.id)}" guidelines="${guidelines}">`,
		...renderOptionalGuidelines(stage.goal, "stage_goal", "  "),
		...(guidelines === "inline"
			? [
					"  <stage_guidelines>",
					escapeXml(stage.prompt),
					"  </stage_guidelines>",
				]
			: []),
		...renderAvailableTransitions(getAvailableTransitions(state), "  "),
		...renderFinalStageGuidance(stage),
		"</workflow_stage_activated>",
	].join("\n");
}

function renderStageUpdate(state: WorkflowState, stage: WorkflowStage): string {
	const active = state.route.at(-1) === stage.id;
	const flags = `${stage.initial ? ' initial="true"' : ""}${stage.final ? ' final="true"' : ""}`;
	return [
		`<workflow_stage_updated workflow_id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(stage.id)}" active="${active}">`,
		`  <stage_definition description="${escapeXml(stage.description)}"${flags}>`,
		...renderOptionalGuidelines(stage.goal, "stage_goal", "    "),
		"    <stage_guidelines>",
		escapeXml(stage.prompt),
		"    </stage_guidelines>",
		"  </stage_definition>",
		"</workflow_stage_updated>",
	].join("\n");
}

function renderWorkflowReminder(state: WorkflowState, stageId: string): string {
	return `<workflow_reminder id="${escapeXml(state.workflow.id)}" active_stage_id="${escapeXml(stageId)}" />`;
}

function renderWorkflowCheckpoint(
	state: WorkflowState,
	stage: WorkflowStage,
	includesGraph: boolean,
): string {
	return [
		`<workflow_checkpoint id="${escapeXml(state.workflow.id)}" status="active" active_stage_id="${escapeXml(stage.id)}">`,
		...renderOptionalGuidelines(state.workflow.prompt, "guidelines", "  "),
		...(includesGraph ? renderWorkflowGraph(state.workflow) : []),
		...renderOptionalGuidelines(stage.goal, "stage_goal", "  "),
		"  <active_stage_guidelines>",
		escapeXml(stage.prompt),
		"  </active_stage_guidelines>",
		...renderAvailableTransitions(getAvailableTransitions(state), "  "),
		...renderFinalStageGuidance(stage),
		"</workflow_checkpoint>",
	].join("\n");
}

/** Adds leave guidance wherever the journal publishes a final active stage. */
function renderFinalStageGuidance(stage: WorkflowStage): readonly string[] {
	return stage.final
		? [
				"  <leave_guidance>After completing this stage, call workflow_exit with the facts that justify leaving.</leave_guidance>",
			]
		: [];
}

function renderActivationOptions(
	workflows: readonly WorkflowDefinition[],
	kinds: readonly WorkflowKind[],
): string {
	if (workflows.length === 0) {
		return "<workflow_activation_options />";
	}
	return [
		"<workflow_activation_options>",
		...groupWorkflowActivationOptions(workflows, kinds).flatMap((group) => {
			const wrapped = kinds.length > 0;
			const tag = group.kind === undefined ? "unclassified" : "kind";
			const attributes =
				group.kind === undefined
					? ""
					: ` id="${escapeXml(group.kind.id)}" description="${escapeXml(group.kind.description)}"`;
			const indent = wrapped ? "    " : "  ";
			return [
				...(wrapped ? [`  <${tag}${attributes}>`] : []),
				...group.workflows.map(
					(workflow) =>
						`${indent}<workflow id="${escapeXml(workflow.id)}" description="${escapeXml(workflow.description)}"${workflow.nested === true ? ' nested="true"' : ""} />`,
				),
				...(wrapped ? [`  </${tag}>`] : []),
			];
		}),
		"</workflow_activation_options>",
	].join("\n");
}

function renderOptionalGuidelines(
	prompt: string | undefined,
	tag: string,
	indent: string,
): readonly string[] {
	return prompt === undefined
		? []
		: [`${indent}<${tag}>`, escapeXml(prompt), `${indent}</${tag}>`];
}

function renderAvailableTransitions(
	transitions: readonly WorkflowTransition[],
	indent: string,
): readonly string[] {
	if (transitions.length === 0) {
		return [`${indent}<available_transitions />`];
	}
	return [
		`${indent}<available_transitions>`,
		...transitions.flatMap((edge) => {
			const binding =
				edge.workflow === undefined
					? ""
					: ` workflow="${escapeXml(edge.workflow)}"`;
			const opening = `${indent}  <transition to="${escapeXml(edge.to)}" type="${edge.type}"${binding}`;
			return edge.grounds?.length
				? [
						`${opening}>`,
						...edge.grounds.map(
							(ground) =>
								`${indent}    <ground id="${escapeXml(ground.id)}">${escapeXml(ground.when)}</ground>`,
						),
						`${indent}  </transition>`,
					]
				: [`${opening} />`];
		}),
		`${indent}</available_transitions>`,
	];
}

function requireCurrentStage(state: WorkflowState): WorkflowStage {
	const stageId = state.route.at(-1);
	const stage = state.workflow.stages.find(({ id }) => id === stageId);
	if (stage === undefined) {
		throw new Error("active workflow stage must exist");
	}
	return stage;
}

function findCurrentContextSegmentStart(branch: readonly unknown[]): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			isRecord(entry) &&
			(entry["type"] === "compaction" || entry["type"] === "branch_summary")
		) {
			return index + 1;
		}
	}
	return 0;
}

function readWorkflowMessage(entry: unknown):
	| {
			readonly content: string;
			readonly details: Readonly<Record<string, unknown>>;
	  }
	| undefined {
	if (
		!isRecord(entry) ||
		entry["type"] !== "custom_message" ||
		entry["customType"] !== "workflow" ||
		typeof entry["content"] !== "string" ||
		!isRecord(entry["details"])
	) {
		return undefined;
	}
	return { content: entry["content"], details: entry["details"] };
}

/** Reports whether Pi will send a graph record for the saved workflow to the model. */
export function hasVisibleWorkflowGraph(
	state: WorkflowState,
	entries: readonly ProjectedSessionEntry[],
): boolean {
	return entries.some(({ sourceEntry, messages }) => {
		const message = readWorkflowMessage(sourceEntry);
		return (
			messages.length > 0 &&
			message?.details["version"] === 1 &&
			((message.details["workflowId"] === state.workflow.id &&
				(message.details["kind"] === "activation" ||
					(message.details["kind"] === "checkpoint" &&
						message.details["includesGraph"] === true))) ||
				(message.details["kind"] === "checkpoint" &&
					Array.isArray(message.details["graphWorkflowIds"]) &&
					message.details["graphWorkflowIds"].includes(state.workflow.id)))
		);
	});
}

/** Renders waiting definitions without making their stages active. */
function renderWaitingWorkflow(state: WorkflowState): string {
	return [
		`<workflow_waiting id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(state.route.at(-1) ?? "")}">`,
		...renderOptionalGuidelines(state.workflow.prompt, "guidelines", "  "),
		...renderWorkflowGraph(state.workflow),
		"</workflow_waiting>",
	].join("\n");
}

/** Describes active and waiting workflow identities after each appended record. */
function renderWorkflowChain(
	chain: readonly {
		readonly workflowId: string;
		readonly stageId: string;
		readonly pendingTransition?: PendingWorkflowTransition;
	}[],
): string {
	return [
		"<workflow_chain>",
		...chain.flatMap((state, index) => [
			`  <workflow id="${escapeXml(state.workflowId)}" stage_id="${escapeXml(state.stageId)}" state="${index === chain.length - 1 ? "active" : "waiting"}" />`,
			...(state.pendingTransition === undefined
				? []
				: [
						`  <pending_transition workflow_id="${escapeXml(state.workflowId)}" parent_workflow_id="${escapeXml(chain[index - 1]?.workflowId ?? "")}" stage_id="${escapeXml(state.pendingTransition.stageId)}"${state.pendingTransition.ground === undefined ? "" : ` ground="${escapeXml(state.pendingTransition.ground)}"`} />`,
					]),
		]),
		"</workflow_chain>",
	].join("\n");
}

/** Requires one active workflow at lifecycle publication boundaries. */
function requireTopWorkflow(chain: WorkflowChain): WorkflowState {
	const state = getTopWorkflow(chain);
	if (state === undefined) {
		throw new Error("no workflow is active");
	}
	return state;
}

/** Identifies all saved workflow definitions, routes, and restoration settings, whatever order of fields built them. */
function getChainRevision(chain: WorkflowChain): string {
	return createHash("sha256")
		.update(JSON.stringify(chain, sortObjectKeys))
		.digest("hex");
}

/** Gives `JSON.stringify` each plain object with its keys in code-point order, so that equal objects serialize equally. */
function sortObjectKeys(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	return Object.fromEntries(
		// Keys of one object are distinct, so no comparison returns equality.
		Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)),
	);
}

/** Keys stage knowledge by workflow identity and the exact stage definition. */
function getStageKey(state: WorkflowState, stage: WorkflowStage): string {
	return createHash("sha256")
		.update(JSON.stringify([state.workflow.id, stage]))
		.digest("hex");
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
