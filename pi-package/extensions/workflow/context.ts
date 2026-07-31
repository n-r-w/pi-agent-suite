import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { WorkflowPrompts } from "./config";
import {
	getAvailableTransitions,
	getStageStatuses,
	type WorkflowDefinition,
	type WorkflowState,
} from "./workflow";

/** Appends one transient workflow message to the current chained provider context. */
export function projectWorkflowContext(
	messages: readonly AgentMessage[],
	prompts: WorkflowPrompts,
	catalog: readonly WorkflowDefinition[],
	state: WorkflowState | undefined,
): AgentMessage[] {
	const content = renderWorkflowContext(
		prompts.extensionDescription,
		catalog,
		state,
	);
	return [
		...messages,
		{
			role: "custom",
			customType: "workflow",
			content,
			display: false,
			timestamp: Date.now(),
		},
	];
}

/** Renders guidelines, activation options, and the optional saved snapshot. */
function renderWorkflowContext(
	guidelines: string,
	catalog: readonly WorkflowDefinition[],
	state: WorkflowState | undefined,
): string {
	const options = catalog.filter(({ id }) => id !== state?.workflow.id);
	const sections = [
		`<workflow_guidelines>\n${escapeXml(guidelines)}\n</workflow_guidelines>`,
		renderActivationOptions(options),
	];
	if (state !== undefined) {
		sections.push(renderActiveWorkflow(state));
	}
	return sections.join("\n\n");
}

/** Renders the current catalog or the approved self-closing empty element. */
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

/** Renders the saved definition with route-derived statuses and allowed transitions. */
function renderActiveWorkflow(state: WorkflowState): string {
	const statuses = getStageStatuses(state);
	const activeStageId = state.route.at(-1);
	if (activeStageId === undefined) {
		throw new Error("active workflow route must be non-empty");
	}
	const activeStage = state.workflow.stages.find(
		(stage) => stage.id === activeStageId,
	);
	if (activeStage === undefined) {
		throw new Error("active workflow stage must exist");
	}
	const stages = state.workflow.stages.map((stage) => {
		const flags = [
			stage.initial ? ' initial="true"' : "",
			stage.final ? ' final="true"' : "",
		].join("");
		return `    <stage id="${escapeXml(stage.id)}" description="${escapeXml(stage.description)}" status="${statuses.get(stage.id)}"${flags} />`;
	});
	const transitions = state.workflow.transitions.map(
		(edge) =>
			`    <transition from="${escapeXml(edge.from)}" to="${escapeXml(edge.to)}" type="${edge.type}" />`,
	);
	const available = getAvailableTransitions(state).map(
		(edge) =>
			`    <transition to="${escapeXml(edge.to)}" type="${edge.type}" />`,
	);
	return [
		`<active_workflow id="${escapeXml(state.workflow.id)}" active_stage_id="${escapeXml(activeStageId)}">`,
		"  <active_stage_guidelines>",
		escapeXml(activeStage.prompt),
		"  </active_stage_guidelines>",
		"  <stages>",
		...stages,
		"  </stages>",
		"  <transitions>",
		...transitions,
		"  </transitions>",
		...(available.length === 0
			? ["  <available_transitions />"]
			: [
					"  <available_transitions>",
					...available,
					"  </available_transitions>",
				]),
		"</active_workflow>",
	].join("\n");
}

/** Escapes configured and workflow text before placing it in XML text or attributes. */
function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
