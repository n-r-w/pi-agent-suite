import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { sliceTextByWidth } from "../../shared/display-width.ts";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import {
	BoundedToolResult,
	getToolResultText,
} from "../../shared/tool-presentation/bounded.ts";
import type { WorkflowDefinition, WorkflowState } from "./workflow.ts";

const PRESENTATION_KIND = "workflow-tool";
/** Matches the standard four-row collapsed content budget used by package tools. */
const COLLAPSED_REFERENCE_CONTENT_LINE_LIMIT = 4;

type WorkflowToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

/** Identifies one workflow or stage without depending on the current catalog. */
interface WorkflowPresentationReference {
	readonly id: string;
	readonly description?: string;
}

/** Persists creation identity supplied before validation or state replacement. */
interface WorkflowCreatePresentation {
	readonly presentationKind: typeof PRESENTATION_KIND;
	readonly toolName: "workflow_create";
	readonly workflow: WorkflowPresentationReference;
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
	| WorkflowCreatePresentation
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
	if (toolName === "workflow_create") {
		return createWorkflowCreatePresentation(args);
	}
	if (toolName === "workflow_activate") {
		return createWorkflowActivatePresentation(args, catalog, state);
	}
	if (toolName === "workflow_transition") {
		return createWorkflowTransitionPresentation(args, state);
	}
	return undefined;
}

/** Captures the caller-owned dynamic workflow reference even when validation later fails. */
function createWorkflowCreatePresentation(
	args: unknown,
): WorkflowCreatePresentation | undefined {
	const workflowId = readInputString(args, "id");
	return workflowId === undefined
		? undefined
		: {
				presentationKind: PRESENTATION_KIND,
				toolName: "workflow_create",
				workflow: createReference(
					workflowId,
					readInputString(args, "description"),
				),
			};
}

/** Resolves activation descriptions from catalog or saved state before replacement. */
function createWorkflowActivatePresentation(
	args: unknown,
	catalog: readonly WorkflowDefinition[],
	state: WorkflowState | undefined,
): WorkflowActivatePresentation | undefined {
	const workflowId = readInputString(args, "workflowId");
	if (workflowId === undefined) {
		return undefined;
	}
	const workflow =
		catalog.find(({ id }) => id === workflowId) ??
		(state?.workflow.id === workflowId ? state.workflow : undefined);
	return {
		presentationKind: PRESENTATION_KIND,
		toolName: "workflow_activate",
		workflow: createReference(workflowId, workflow?.description),
	};
}

/** Captures transition endpoints before route mutation removes the source stage. */
function createWorkflowTransitionPresentation(
	args: unknown,
	state: WorkflowState | undefined,
): WorkflowTransitionPresentation | undefined {
	const stageId = readInputString(args, "stageId");
	if (stageId === undefined) {
		return undefined;
	}
	const fromId = state?.route.at(-1);
	return {
		presentationKind: PRESENTATION_KIND,
		toolName: "workflow_transition",
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

/** Renders one workflow creation with its caller-supplied reference. */
export function renderWorkflowCreateCall(
	args: unknown,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	const presentation = readCreatePresentation(context);
	const workflowId = readInputString(args, "id");
	const fallback =
		workflowId === undefined
			? undefined
			: createReference(workflowId, readInputString(args, "description"));
	return renderWorkflowReferenceCall(
		"workflow_create",
		presentation?.workflow ?? fallback,
		theme,
		context,
	);
}

/** Renders one workflow activation with a bounded or complete reference section. */
export function renderWorkflowActivateCall(
	args: unknown,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	const presentation = readActivatePresentation(context);
	const workflow =
		presentation?.workflow ??
		createOptionalReference(readInputString(args, "workflowId"));
	return renderWorkflowReferenceCall(
		"workflow_activate",
		workflow,
		theme,
		context,
	);
}

/** Shares bounded workflow-reference rows between create and activate calls. */
function renderWorkflowReferenceCall(
	toolName: "workflow_create" | "workflow_activate",
	workflow: WorkflowPresentationReference | undefined,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	return new WorkflowRows((width) => [
		renderToolName(toolName, width, theme),
		...(workflow === undefined
			? []
			: renderReference({
					label: "Workflow",
					reference: workflow,
					expanded: context.expanded,
					width,
					theme,
				})),
	]);
}

/** Renders one workflow transition with bounded or complete endpoint sections. */
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
				: renderReference({
						label: "From",
						reference: presentation.from,
						expanded: context.expanded,
						width,
						theme,
					})),
			...(to === undefined
				? []
				: renderReference({
						label: "To",
						reference: to,
						expanded: context.expanded,
						width,
						theme,
					})),
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
	if (value["toolName"] === "workflow_create") {
		return parseWorkflowReferencePresentation(value, "workflow_create");
	}
	if (value["toolName"] === "workflow_activate") {
		return parseWorkflowReferencePresentation(value, "workflow_activate");
	}
	return value["toolName"] === "workflow_transition"
		? parseTransitionPresentation(value)
		: undefined;
}

/** Parses persisted create or activate evidence with one shared workflow reference. */
function parseWorkflowReferencePresentation(
	value: Record<string, unknown>,
	toolName: "workflow_create" | "workflow_activate",
): WorkflowCreatePresentation | WorkflowActivatePresentation | undefined {
	const workflow = parseReference(value["workflow"]);
	if (workflow === undefined) {
		return undefined;
	}
	if (toolName === "workflow_create") {
		return { presentationKind: PRESENTATION_KIND, toolName, workflow };
	}
	return { presentationKind: PRESENTATION_KIND, toolName, workflow };
}

/** Parses persisted transition evidence and rejects a malformed optional source. */
function parseTransitionPresentation(
	value: Record<string, unknown>,
): WorkflowTransitionPresentation | undefined {
	const from =
		value["from"] === undefined ? undefined : parseReference(value["from"]);
	const to = parseReference(value["to"]);
	if ((value["from"] !== undefined && from === undefined) || to === undefined) {
		return undefined;
	}
	return {
		presentationKind: PRESENTATION_KIND,
		toolName: "workflow_transition",
		...(from === undefined ? {} : { from }),
		to,
	};
}

/** Reads creation evidence from the shared row state. */
function readCreatePresentation(
	context: WorkflowToolRenderContext,
): WorkflowCreatePresentation | undefined {
	const presentation = (context.state as WorkflowRenderState).presentation;
	return presentation?.toolName === "workflow_create"
		? presentation
		: undefined;
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

/** Renders one standalone bright workflow tool name. */
function renderToolName(toolName: string, width: number, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(sliceTextByWidth(toolName, width)));
}

/** Selects the complete section or Pi's standard bounded collapsed preview. */
function renderReference(options: {
	readonly label: "Workflow" | "From" | "To";
	readonly reference: WorkflowPresentationReference;
	readonly expanded: boolean;
	readonly width: number;
	readonly theme: Theme;
}): readonly string[] {
	if (options.expanded) {
		return [
			...new Text(
				options.theme.fg("muted", `--- ${options.label} ---`),
				0,
				0,
			).render(options.width),
			...new Text(
				options.theme.fg("toolOutput", formatReference(options.reference)),
				0,
				0,
			).render(options.width),
		];
	}
	return new BoundedToolResult({
		text: `${options.label}: ${formatReference(options.reference)}`,
		theme: options.theme,
		isError: false,
		expanded: false,
		collapsedContentLineLimit: COLLAPSED_REFERENCE_CONTENT_LINE_LIMIT,
		showHiddenLineHint: true,
		showExpandedErrorLabel: false,
	}).render(options.width);
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
