import { createHash } from "node:crypto";
import {
	getAvailableTransitions,
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

type WorkflowJournalKind =
	| "activation"
	| "stage_activation"
	| "stage_update"
	| "completion"
	| "checkpoint"
	| "activation_options";

/** Publishes append-only hidden workflow records and tracks definitions known in the current context segment. */
export class WorkflowJournal {
	private readonly knownStages = new Set<string>();
	private currentWorkflowId: string | undefined;
	private currentStatus: WorkflowState["status"] | undefined;
	private currentStageId: string | undefined;
	private currentWorkflowRevision: string | undefined;
	private activationOptionsContent: string | undefined;

	public constructor(
		private readonly publish: (record: WorkflowJournalRecord) => void,
	) {}

	public activate(state: WorkflowState): void {
		const stage = requireCurrentStage(state);
		this.knownStages.clear();
		this.knownStages.add(stage.id);
		this.setCurrentState(state);
		this.publishRecord(
			renderWorkflowActivation(state, stage),
			"activation",
			state,
			{ stageId: stage.id, guidelines: "inline" },
		);
	}

	public enterStage(state: WorkflowState): void {
		const stage = requireCurrentStage(state);
		const guidelines = this.knownStages.has(stage.id) ? "reuse" : "inline";
		this.knownStages.add(stage.id);
		this.setCurrentState(state);
		this.publishRecord(
			renderStageActivation(state, stage, guidelines),
			"stage_activation",
			state,
			{ stageId: stage.id, guidelines },
		);
	}

	public updateStage(state: WorkflowState, stageId: string): void {
		const stage = state.workflow.stages.find(({ id }) => id === stageId);
		if (stage === undefined) {
			throw new Error(`workflow stage does not exist: ${stageId}`);
		}
		this.knownStages.add(stageId);
		this.setCurrentState(state);
		this.publishRecord(renderStageUpdate(state, stage), "stage_update", state, {
			stageId,
			active: state.status === "active" && state.route.at(-1) === stageId,
		});
	}

	public complete(state: WorkflowState): void {
		if (state.status !== "completed") {
			throw new Error("workflow completion record requires completed state");
		}
		const stage = requireCurrentStage(state);
		this.setCurrentState(state);
		this.publishRecord(
			renderWorkflowCompletion(state, stage.id),
			"completion",
			state,
			{ stageId: stage.id },
		);
	}

	public checkpoint(state: WorkflowState): void {
		const stage = requireCurrentStage(state);
		this.knownStages.clear();
		if (state.status === "active") {
			this.knownStages.add(stage.id);
		}
		this.setCurrentState(state);
		this.publishRecord(
			renderWorkflowCheckpoint(state, stage),
			"checkpoint",
			state,
			{ stageId: stage.id },
		);
	}

	public activationOptions(workflows: readonly WorkflowDefinition[]): void {
		const content = renderActivationOptions(workflows);
		if (content === this.activationOptionsContent) {
			return;
		}
		this.activationOptionsContent = content;
		this.publish({
			customType: "workflow",
			content,
			display: false,
			details: { version: 1, kind: "activation_options" },
		});
	}

	/** Clears journal-local state when Pi starts a new provider-visible context segment. */
	public startContextSegment(): void {
		this.knownStages.clear();
		this.currentWorkflowId = undefined;
		this.currentStatus = undefined;
		this.currentStageId = undefined;
		this.currentWorkflowRevision = undefined;
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
	public isCurrent(state: WorkflowState): boolean {
		return (
			this.currentWorkflowId === state.workflow.id &&
			this.currentStatus === state.status &&
			this.currentStageId === state.route.at(-1) &&
			this.currentWorkflowRevision === getWorkflowRevision(state.workflow)
		);
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
		const workflowId = details["workflowId"];
		const stageId = details["stageId"];
		const currentStageId = details["currentStageId"];
		const status = details["status"];
		const workflowRevision = details["workflowRevision"];
		if (
			typeof workflowId !== "string" ||
			typeof stageId !== "string" ||
			typeof currentStageId !== "string" ||
			typeof workflowRevision !== "string" ||
			(status !== "active" && status !== "completed")
		) {
			return;
		}
		if (kind === "activation" || kind === "checkpoint") {
			this.knownStages.clear();
		}
		if (
			kind === "activation" ||
			(kind === "stage_activation" && details["guidelines"] === "inline") ||
			kind === "stage_update" ||
			(kind === "checkpoint" && status === "active")
		) {
			this.knownStages.add(stageId);
		}
		this.currentWorkflowId = workflowId;
		this.currentStatus = status;
		this.currentStageId = currentStageId;
		this.currentWorkflowRevision = workflowRevision;
	}

	private setCurrentState(state: WorkflowState): void {
		this.currentWorkflowId = state.workflow.id;
		this.currentStatus = state.status;
		this.currentStageId = state.route.at(-1);
		this.currentWorkflowRevision = getWorkflowRevision(state.workflow);
	}

	private publishRecord(
		content: string,
		kind: Exclude<WorkflowJournalKind, "activation_options">,
		state: WorkflowState,
		metadata: Readonly<Record<string, unknown>> & { readonly stageId: string },
	): void {
		this.publish({
			customType: "workflow",
			content,
			display: false,
			details: {
				version: 1,
				kind,
				workflowId: state.workflow.id,
				status: state.status,
				currentStageId: state.route.at(-1),
				workflowRevision: getWorkflowRevision(state.workflow),
				...metadata,
			},
		});
	}
}

function renderWorkflowActivation(
	state: WorkflowState,
	stage: WorkflowStage,
): string {
	const workflow = state.workflow;
	const stages = workflow.stages.map((item) => {
		const flags = `${item.initial ? ' initial="true"' : ""}${item.final ? ' final="true"' : ""}`;
		return `    <stage id="${escapeXml(item.id)}" description="${escapeXml(item.description)}"${flags} />`;
	});
	const transitions = workflow.transitions.map(
		(edge) =>
			`    <transition from="${escapeXml(edge.from)}" to="${escapeXml(edge.to)}" type="${edge.type}" />`,
	);
	return [
		`<workflow_activated id="${escapeXml(workflow.id)}" source="${state.source}">`,
		...renderOptionalGuidelines(workflow.prompt, "guidelines", "  "),
		"  <stages>",
		...stages,
		"  </stages>",
		"  <transitions>",
		...transitions,
		"  </transitions>",
		"</workflow_activated>",
		"",
		renderStageActivation(state, stage, "inline"),
	].join("\n");
}

function renderStageActivation(
	state: WorkflowState,
	stage: WorkflowStage,
	guidelines: "inline" | "reuse",
): string {
	return [
		`<workflow_stage_activated workflow_id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(stage.id)}" guidelines="${guidelines}">`,
		...(guidelines === "inline"
			? [
					"  <stage_guidelines>",
					escapeXml(stage.prompt),
					"  </stage_guidelines>",
				]
			: []),
		...renderAvailableTransitions(getAvailableTransitions(state), "  "),
		"</workflow_stage_activated>",
	].join("\n");
}

function renderStageUpdate(state: WorkflowState, stage: WorkflowStage): string {
	const active = state.status === "active" && state.route.at(-1) === stage.id;
	const flags = `${stage.initial ? ' initial="true"' : ""}${stage.final ? ' final="true"' : ""}`;
	return [
		`<workflow_stage_updated workflow_id="${escapeXml(state.workflow.id)}" stage_id="${escapeXml(stage.id)}" active="${active}">`,
		`  <stage_definition description="${escapeXml(stage.description)}"${flags}>`,
		"    <stage_guidelines>",
		escapeXml(stage.prompt),
		"    </stage_guidelines>",
		"  </stage_definition>",
		"</workflow_stage_updated>",
	].join("\n");
}

function renderWorkflowCompletion(
	state: WorkflowState,
	stageId: string,
): string {
	return [
		`<workflow_completed id="${escapeXml(state.workflow.id)}" completed_stage_id="${escapeXml(stageId)}">`,
		...renderAvailableTransitions(getAvailableTransitions(state), "  "),
		"</workflow_completed>",
	].join("\n");
}

function renderWorkflowCheckpoint(
	state: WorkflowState,
	stage: WorkflowStage,
): string {
	const stageAttribute =
		state.status === "active" ? "active_stage_id" : "completed_stage_id";
	return [
		`<workflow_checkpoint id="${escapeXml(state.workflow.id)}" status="${state.status}" ${stageAttribute}="${escapeXml(stage.id)}">`,
		...renderOptionalGuidelines(state.workflow.prompt, "guidelines", "  "),
		...(state.status === "active"
			? [
					"  <active_stage_guidelines>",
					escapeXml(stage.prompt),
					"  </active_stage_guidelines>",
				]
			: []),
		...renderAvailableTransitions(getAvailableTransitions(state), "  "),
		"</workflow_checkpoint>",
	].join("\n");
}

function renderActivationOptions(
	workflows: readonly WorkflowDefinition[],
): string {
	if (workflows.length === 0) {
		return "<workflow_activation_options />";
	}
	return [
		"<workflow_activation_options>",
		...workflows.map(
			(workflow) =>
				`  <workflow id="${escapeXml(workflow.id)}" description="${escapeXml(workflow.description)}" />`,
		),
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
		...transitions.map(
			(edge) =>
				`${indent}  <transition to="${escapeXml(edge.to)}" type="${edge.type}" />`,
		),
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

function getWorkflowRevision(workflow: WorkflowDefinition): string {
	return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
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
