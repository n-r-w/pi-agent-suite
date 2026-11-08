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

/** Publishes append-only hidden workflow records and tracks which lifecycle and options records the model context holds. */
export class WorkflowJournal {
	private currentChainRevision: string | undefined;
	private activationOptionsContent: string | undefined;
	// Whether the latest model-visible lifecycle record says that no workflow is active.
	private exitShown = false;

	public constructor(
		private readonly publish: (
			record: WorkflowJournalRecord,
			delivery: WorkflowJournalDelivery,
			triggerTurn?: boolean,
		) => void,
		private readonly kinds: readonly WorkflowKind[] = [],
	) {}

	public activate(
		chain: WorkflowChain,
		entries: readonly ProjectedSessionEntry[],
	): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		const key = getStageKey(state, stage);
		const guidelines = chooseStageGuidelines(key, readKnownStageKeys(entries));
		// Only catalog workflows reuse, because stage edits of created workflows change the graph through records that show no complete graph.
		const reusesDefinition =
			state.source === "catalog" && hasVisibleWorkflowGraph(state, entries);
		this.setCurrentState(chain);
		this.publishRecord(
			renderWorkflowActivation(state, stage, guidelines, reusesDefinition),
			"activation",
			chain,
			{
				stageId: stage.id,
				...describeStageRules(key, guidelines),
				...(reusesDefinition
					? { workflowGuidelines: "reuse" }
					: { definitionKeys: [getDefinitionKey(state.workflow)] }),
			},
		);
	}

	public enterStage(
		chain: WorkflowChain,
		entries: readonly ProjectedSessionEntry[],
		refusedTransition?: PendingWorkflowTransition,
	): void {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		const key = getStageKey(state, stage);
		const guidelines = chooseStageGuidelines(key, readKnownStageKeys(entries));
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
				...describeStageRules(key, guidelines),
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
		const key = getStageKey(state, stage);
		this.setCurrentState(chain);
		this.publishRecord(renderStageUpdate(state, stage), "stage_update", chain, {
			stageId,
			active: state.route.at(-1) === stageId,
			stageKey: key,
		});
	}

	/** Publishes only the current active identifiers, without stage prompts. */
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
		this.publish(this.exitForRun(), "steer", false);
	}

	/** Returns the record of the absence of a workflow and marks the exit as shown, without publishing the record. */
	public exitForRun(): WorkflowJournalRecord {
		this.currentChainRevision = undefined;
		this.exitShown = true;
		return {
			customType: "workflow",
			content:
				'<workflow_exited />\n<workflow_state active="false" />\n<workflow_chain />',
			display: false,
			details: { version: 1, kind: "exit" },
		};
	}

	public checkpoint(
		chain: WorkflowChain,
		projectedEntries: readonly ProjectedSessionEntry[],
		triggerTurn?: boolean,
	): void {
		this.publish(
			this.checkpointForRun(chain, projectedEntries),
			"steer",
			triggerTurn,
		);
	}

	/** Returns a checkpoint with the parts that the projected entries lack and marks its state as current, without publishing the checkpoint. */
	public checkpointForRun(
		chain: WorkflowChain,
		projectedEntries: readonly ProjectedSessionEntry[],
	): WorkflowJournalRecord {
		const state = requireTopWorkflow(chain);
		const stage = requireCurrentStage(state);
		const knownStageKeys = readKnownStageKeys(projectedEntries);
		const missingGraphs = chain.filter(
			(item) => !hasVisibleWorkflowGraph(item, projectedEntries),
		);
		const includesGraph = missingGraphs.includes(state);
		const waiting = chain.slice(0, -1).flatMap((item) => {
			const waitingStage = requireCurrentStage(item);
			const stageKey = getStageKey(item, waitingStage);
			const includesStage = !knownStageKeys.has(stageKey);
			const includesWaitingGraph = missingGraphs.includes(item);
			return includesStage || includesWaitingGraph
				? [
						{
							content: renderWaitingWorkflow(
								item,
								waitingStage,
								includesWaitingGraph,
								includesStage,
							),
							stageKey: includesStage ? stageKey : undefined,
						},
					]
				: [];
		});
		const waitingStageKeys = waiting.flatMap(({ stageKey }) =>
			stageKey === undefined ? [] : [stageKey],
		);
		const key = getStageKey(state, stage);
		const guidelines = chooseStageGuidelines(key, knownStageKeys);
		this.setCurrentState(chain);
		return this.buildRecord(
			[
				...waiting.map(({ content }) => content),
				renderWorkflowCheckpoint(state, stage, includesGraph, guidelines),
			].join("\n"),
			"checkpoint",
			chain,
			{
				stageId: stage.id,
				...describeStageRules(key, guidelines),
				includesGraph,
				graphWorkflowIds: missingGraphs.map(({ workflow }) => workflow.id),
				definitionKeys: missingGraphs.map(({ workflow }) =>
					getDefinitionKey(workflow),
				),
				...(waitingStageKeys.length === 0 ? {} : { waitingStageKeys }),
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

	/** Restores publication evidence from the counted records before Pi appends the next run's initial message. */
	public activationOptionsForRun(
		workflows: readonly WorkflowDefinition[],
		entries: readonly ProjectedSessionEntry[],
	): WorkflowJournalRecord | undefined {
		this.activationOptionsContent = undefined;
		for (const message of readCountedWorkflowRecords(entries)) {
			if (message.details["kind"] === "activation_options") {
				this.activationOptionsContent = message.content;
			}
		}
		return this.prepareActivationOptions(workflows);
	}

	/** Deduplicates one candidate against the options that the model context holds. */
	private prepareActivationOptions(
		workflows: readonly WorkflowDefinition[],
	): WorkflowJournalRecord | undefined {
		const content = renderActivationOptions(workflows, this.kinds);
		if (content === this.activationOptionsContent) {
			return;
		}
		// An empty value is useful only when it replaces options that the model context holds.
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

	/** Rebuilds journal-local deduplication state from the records that Pi saved and sends to the model unchanged, including those that a compaction kept. */
	public restore(entries: readonly ProjectedSessionEntry[]): void {
		this.currentChainRevision = undefined;
		this.activationOptionsContent = undefined;
		this.exitShown = false;
		for (const message of readCountedWorkflowRecords(entries)) {
			this.restoreRecord(message.details, message.content);
		}
	}

	/** Returns whether the latest model-visible lifecycle record already says that no workflow is active. */
	public showsExit(): boolean {
		return this.exitShown;
	}

	/** Returns whether the model context already contains a compatible lifecycle record. */
	public isCurrent(chain: WorkflowChain): boolean {
		return this.currentChainRevision === getChainRevision(chain);
	}

	private restoreRecord(
		details: Readonly<Record<string, unknown>>,
		content: string,
	): void {
		const kind = details["kind"];
		if (kind === "activation_options") {
			this.activationOptionsContent = content;
			return;
		}
		if (kind === "exit" || kind === "completion") {
			this.currentChainRevision = undefined;
			this.exitShown = true;
			return;
		}
		const revision = details["chainRevision"];
		if (typeof revision !== "string") {
			return;
		}
		this.exitShown = false;
		this.currentChainRevision = revision;
	}

	private setCurrentState(chain: WorkflowChain): void {
		this.currentChainRevision = getChainRevision(chain);
		this.exitShown = false;
	}

	private publishRecord(
		content: string,
		kind: Exclude<WorkflowJournalKind, "activation_options">,
		chain: WorkflowChain,
		publication: Readonly<Record<string, unknown>> & {
			readonly stageId: string;
			readonly delivery?: WorkflowJournalDelivery;
		},
	): void {
		const { delivery = "steer", ...metadata } = publication;
		this.publish(this.buildRecord(content, kind, chain, metadata), delivery);
	}

	/** Builds a lifecycle record that carries the chain view and the metadata of the current workflow state. */
	private buildRecord(
		content: string,
		kind: Exclude<WorkflowJournalKind, "activation_options">,
		chain: WorkflowChain,
		metadata: Readonly<Record<string, unknown>>,
	): WorkflowJournalRecord {
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
		return {
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
				...(pendingTransitions.length === 0 ? {} : { pendingTransitions }),
				...metadata,
			},
		};
	}
}

/** Renders an activation with the shared rules and the graph, or with a reference to the visible record that shows them when `reusesDefinition` is true. */
function renderWorkflowActivation(
	state: WorkflowState,
	stage: WorkflowStage,
	guidelines: "inline" | "reuse",
	reusesDefinition: boolean,
): string {
	const workflow = state.workflow;
	const opening = `<workflow_activated id="${escapeXml(workflow.id)}" source="${state.source}"`;
	return [
		...(reusesDefinition
			? [`${opening} guidelines="reuse" />`]
			: [
					`${opening}>`,
					...renderWorkflowDefinition(workflow),
					"</workflow_activated>",
				]),
		"",
		renderStageActivation(state, stage, guidelines),
	].join("\n");
}

/** Renders the shared rules and the graph that activation and restoration records show. */
function renderWorkflowDefinition(
	workflow: WorkflowDefinition,
): readonly string[] {
	return [
		...renderOptionalGuidelines(workflow.prompt, "guidelines", "  "),
		...renderWorkflowGraph(workflow),
	];
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

/** Renders the active state with the shared rules and the graph only when the context lacks them, and the stage rules only when it lacks them. */
function renderWorkflowCheckpoint(
	state: WorkflowState,
	stage: WorkflowStage,
	includesGraph: boolean,
	guidelines: "inline" | "reuse",
): string {
	return [
		`<workflow_checkpoint id="${escapeXml(state.workflow.id)}" status="active" active_stage_id="${escapeXml(stage.id)}" guidelines="${guidelines}">`,
		...(includesGraph ? renderWorkflowDefinition(state.workflow) : []),
		...renderOptionalGuidelines(stage.goal, "stage_goal", "  "),
		...(guidelines === "inline"
			? [
					"  <active_stage_guidelines>",
					escapeXml(stage.prompt),
					"  </active_stage_guidelines>",
				]
			: []),
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

/** Returns the workflow records that Pi saved and sends to the model with their saved text, in their order. */
function readCountedWorkflowRecords(
	entries: readonly ProjectedSessionEntry[],
): readonly NonNullable<ReturnType<typeof readWorkflowMessage>>[] {
	return entries.flatMap(({ sourceEntry, messages }) => {
		const message = readWorkflowMessage(sourceEntry);
		return message?.details["version"] === 1 &&
			messages.length > 0 &&
			messages.every(
				(projected) =>
					projected.role === "custom" && projected.content === message.content,
			)
			? [message]
			: [];
	});
}

/** Returns the keys of the stage definitions whose prompts the counted records show. */
function readKnownStageKeys(
	entries: readonly ProjectedSessionEntry[],
): ReadonlySet<string> {
	return new Set(
		readCountedWorkflowRecords(entries).flatMap(({ details }) => {
			const key = details["stageKey"];
			const waitingKeys = details["waitingStageKeys"];
			return [
				...(typeof key === "string" ? [key] : []),
				...(Array.isArray(waitingKeys)
					? waitingKeys.filter(
							(waitingKey): waitingKey is string =>
								typeof waitingKey === "string",
						)
					: []),
			];
		}),
	);
}

/** Chooses `reuse` when the known stage keys hold the key of this stage definition, and `inline` otherwise. */
function chooseStageGuidelines(
	key: string,
	knownStageKeys: ReadonlySet<string>,
): "inline" | "reuse" {
	return knownStageKeys.has(key) ? "reuse" : "inline";
}

/** Returns the record metadata that says whether the record shows the stage rules, with their key when it does. */
function describeStageRules(
	key: string,
	guidelines: "inline" | "reuse",
): Readonly<Record<string, string>> {
	return guidelines === "inline"
		? { guidelines, stageKey: key }
		: { guidelines };
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

/** Reports whether the latest counted record that shows the rules and graph of the saved workflow shows its saved definition. */
export function hasVisibleWorkflowGraph(
	state: WorkflowState,
	entries: readonly ProjectedSessionEntry[],
): boolean {
	const latest = readCountedWorkflowRecords(entries)
		.filter(({ details }) => showsWorkflowGraph(details, state.workflow.id))
		.at(-1);
	const keys = latest?.details["definitionKeys"];
	return Array.isArray(keys) && keys.includes(getDefinitionKey(state.workflow));
}

/** Reports whether a workflow record shows the shared rules and the graph of the workflow with this ID. */
function showsWorkflowGraph(
	details: Readonly<Record<string, unknown>>,
	workflowId: string,
): boolean {
	return (
		(details["workflowId"] === workflowId &&
			((details["kind"] === "activation" &&
				details["workflowGuidelines"] !== "reuse") ||
				(details["kind"] === "checkpoint" &&
					details["includesGraph"] === true))) ||
		(details["kind"] === "checkpoint" &&
			Array.isArray(details["graphWorkflowIds"]) &&
			details["graphWorkflowIds"].includes(workflowId))
	);
}

/** Renders a waiting workflow with the parts that no visible record shows: its shared rules and graph, and the goal and rules of the stage at which it waits. */
function renderWaitingWorkflow(
	state: WorkflowState,
	stage: WorkflowStage,
	includesGraph: boolean,
	includesStage: boolean,
): string {
	return [
		`<workflow_waiting id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(stage.id)}">`,
		...(includesGraph ? renderWorkflowDefinition(state.workflow) : []),
		...(includesStage
			? [
					...renderOptionalGuidelines(stage.goal, "stage_goal", "  "),
					"  <waiting_stage_guidelines>",
					escapeXml(stage.prompt),
					"  </waiting_stage_guidelines>",
				]
			: []),
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

/** Keys the shared rules and the graph of a workflow by its ID and the text that records show for them. */
function getDefinitionKey(workflow: WorkflowDefinition): string {
	return createHash("sha256")
		.update(
			JSON.stringify([workflow.id, ...renderWorkflowDefinition(workflow)]),
		)
		.digest("hex");
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
