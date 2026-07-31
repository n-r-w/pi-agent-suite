import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sliceTextByWidth } from "../../shared/display-width.ts";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import { getToolResultText } from "../../shared/tool-presentation/bounded.ts";
import type { WorkflowDefinition, WorkflowState } from "./workflow.ts";

const PRESENTATION_KIND = "workflow-tool";

type WorkflowToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

/** Identifies one workflow or stage without depending on the current catalog. */
interface WorkflowPresentationReference {
	readonly id: string;
	readonly description?: string;
}

/** Persists activation identity for replayed tool rows. */
interface WorkflowActivatePresentation {
	readonly presentationKind: typeof PRESENTATION_KIND;
	readonly toolName: "workflow_activate";
	readonly workflow: WorkflowPresentationReference;
}

/** Persists both sides of a transition before execution mutates workflow state. */
interface WorkflowTransitionPresentation {
	readonly presentationKind: typeof PRESENTATION_KIND;
	readonly toolName: "workflow_transition";
	readonly from?: WorkflowPresentationReference;
	readonly to: WorkflowPresentationReference;
}

export type WorkflowToolPresentationDetails =
	| WorkflowActivatePresentation
	| WorkflowTransitionPresentation;

/** Stores presentation evidence shared by one call/result renderer pair. */
interface WorkflowRenderState {
	presentation?: WorkflowToolPresentationDetails;
}

/** Defers width-sensitive rows until Pi supplies the default shell child width. */
class WorkflowRows implements Component {
	public constructor(
		private readonly renderRows: (width: number) => readonly string[],
	) {}

	/** Renders semantic rows within the width owned by Pi's default tool shell. */
	public render(width: number): string[] {
		return [...this.renderRows(Math.max(0, Math.floor(width)))];
	}

	/** Keeps the width-aware component compatible with Pi's invalidation contract. */
	public invalidate(): void {}
}

/** Captures semantic identity before a workflow tool can change route state. */
export function createWorkflowPresentationDetails(
	toolName: string,
	args: unknown,
	catalog: readonly WorkflowDefinition[],
	state: WorkflowState | undefined,
): WorkflowToolPresentationDetails | undefined {
	if (toolName === "workflow_activate") {
		const workflowId = readInputString(args, "workflowId");
		if (workflowId === undefined) {
			return undefined;
		}
		const workflow =
			catalog.find(({ id }) => id === workflowId) ??
			(state?.workflow.id === workflowId ? state.workflow : undefined);
		return {
			presentationKind: PRESENTATION_KIND,
			toolName,
			workflow: createReference(workflowId, workflow?.description),
		};
	}
	if (toolName === "workflow_transition") {
		const stageId = readInputString(args, "stageId");
		if (stageId === undefined) {
			return undefined;
		}
		const fromId = state?.route.at(-1);
		return {
			presentationKind: PRESENTATION_KIND,
			toolName,
			...(fromId === undefined || state === undefined
				? {}
				: {
						from: createReference(
							fromId,
							findStageDescription(state.workflow, fromId),
						),
					}),
			to: createReference(
				stageId,
				state === undefined
					? undefined
					: findStageDescription(state.workflow, stageId),
			),
		};
	}
	return undefined;
}

/** Keeps live pending calls semantic until persisted result evidence is available. */
export function primeWorkflowRenderState(
	context: WorkflowToolRenderContext,
	presentation: WorkflowToolPresentationDetails | undefined,
): void {
	const state = context.state as WorkflowRenderState;
	if (state.presentation === undefined && presentation !== undefined) {
		state.presentation = presentation;
	}
}

/** Renders one workflow activation as a compact semantic header. */
export function renderWorkflowActivateCall(
	args: unknown,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	return new WorkflowRows((width) => {
		const presentation = readActivatePresentation(context);
		const workflow =
			presentation?.workflow ??
			createOptionalReference(readInputString(args, "workflowId"));
		return [
			renderActivationHeader("workflow_activate", workflow, width, theme),
		];
	});
}

/** Renders one workflow transition with explicit source and target rows. */
export function renderWorkflowTransitionCall(
	args: unknown,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	return new WorkflowRows((width) => {
		const presentation = readTransitionPresentation(context);
		const to =
			presentation?.to ??
			createOptionalReference(readInputString(args, "stageId"));
		return [
			renderToolName("workflow_transition", width, theme),
			...(presentation?.from === undefined
				? []
				: [renderEvidenceRow("From:", presentation.from, width, theme)]),
			...(to === undefined ? [] : [renderEvidenceRow("To:", to, width, theme)]),
		];
	});
}

/** Restores persisted evidence and hides successful internal result content. */
export function renderWorkflowResult(
	result: AgentToolResult<unknown>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	const presentation = parseWorkflowPresentationDetails(result.details);
	if (presentation !== undefined) {
		(context.state as WorkflowRenderState).presentation = presentation;
	}
	if (!context.isError) {
		return new Container();
	}
	return new WorkflowRows((width) =>
		renderLabeledWrappedText({
			label: "Error:",
			text: getToolResultText(result),
			width,
			labelStyle: (value) => theme.fg("toolTitle", theme.bold(value)),
			textStyle: (value) => theme.fg("muted", value),
		}),
	);
}

/** Parses persisted UI evidence before it enters renderer-owned state. */
function parseWorkflowPresentationDetails(
	value: unknown,
): WorkflowToolPresentationDetails | undefined {
	if (!isRecord(value) || value["presentationKind"] !== PRESENTATION_KIND) {
		return undefined;
	}
	if (value["toolName"] === "workflow_activate") {
		const workflow = parseReference(value["workflow"]);
		return workflow === undefined
			? undefined
			: {
					presentationKind: PRESENTATION_KIND,
					toolName: "workflow_activate",
					workflow,
				};
	}
	if (value["toolName"] === "workflow_transition") {
		const from =
			value["from"] === undefined ? undefined : parseReference(value["from"]);
		const to = parseReference(value["to"]);
		if (
			(value["from"] !== undefined && from === undefined) ||
			to === undefined
		) {
			return undefined;
		}
		return {
			presentationKind: PRESENTATION_KIND,
			toolName: "workflow_transition",
			...(from === undefined ? {} : { from }),
			to,
		};
	}
	return undefined;
}

/** Reads activation evidence from the shared row state. */
function readActivatePresentation(
	context: WorkflowToolRenderContext,
): WorkflowActivatePresentation | undefined {
	const presentation = (context.state as WorkflowRenderState).presentation;
	return presentation?.toolName === "workflow_activate"
		? presentation
		: undefined;
}

/** Reads transition evidence from the shared row state. */
function readTransitionPresentation(
	context: WorkflowToolRenderContext,
): WorkflowTransitionPresentation | undefined {
	const presentation = (context.state as WorkflowRenderState).presentation;
	return presentation?.toolName === "workflow_transition"
		? presentation
		: undefined;
}

/** Renders the bright tool name followed by muted activation evidence. */
function renderActivationHeader(
	toolName: string,
	workflow: WorkflowPresentationReference | undefined,
	width: number,
	theme: Theme,
): string {
	const clippedTool = sliceTextByWidth(toolName, width);
	const styledTool = theme.fg("toolTitle", theme.bold(clippedTool));
	if (workflow === undefined) {
		return styledTool;
	}
	const remaining = Math.max(0, width - visibleWidth(clippedTool));
	const evidence = sliceTextByWidth(` ${formatReference(workflow)}`, remaining);
	return `${styledTool}${theme.fg("muted", evidence)}`;
}

/** Renders one standalone bright workflow tool name. */
function renderToolName(toolName: string, width: number, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(sliceTextByWidth(toolName, width)));
}

/** Renders one muted transition endpoint without exceeding its shell row. */
function renderEvidenceRow(
	label: "From:" | "To:",
	reference: WorkflowPresentationReference,
	width: number,
	theme: Theme,
): string {
	return theme.fg(
		"muted",
		sliceTextByWidth(`${label} ${formatReference(reference)}`, width),
	);
}

/** Formats optional description only when validated evidence contains it. */
function formatReference(reference: WorkflowPresentationReference): string {
	return reference.description === undefined
		? reference.id
		: `${reference.id} · ${reference.description}`;
}

/** Creates one immutable reference without inventing unavailable descriptions. */
function createReference(
	id: string,
	description: string | undefined,
): WorkflowPresentationReference {
	return description === undefined ? { id } : { id, description };
}

/** Converts an optional identifier into renderable fallback evidence. */
function createOptionalReference(
	id: string | undefined,
): WorkflowPresentationReference | undefined {
	return id === undefined ? undefined : { id };
}

/** Finds the saved stage description authoritative for the active session. */
function findStageDescription(
	workflow: WorkflowDefinition,
	stageId: string,
): string | undefined {
	return workflow.stages.find(({ id }) => id === stageId)?.description;
}

/** Parses one persisted reference with an optional non-empty description. */
function parseReference(
	value: unknown,
): WorkflowPresentationReference | undefined {
	if (!isRecord(value) || !isNonEmptyString(value["id"])) {
		return undefined;
	}
	const description = value["description"];
	if (description !== undefined && !isNonEmptyString(description)) {
		return undefined;
	}
	return createReference(value["id"], description);
}

/** Reads one exact string field without normalizing tool arguments. */
function readInputString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

/** Narrows persisted values to plain key-value objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects empty persisted identifiers and descriptions. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
