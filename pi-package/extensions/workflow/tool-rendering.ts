import type {
	AgentToolResult,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stringify } from "yaml";
import { sliceTextByWidth } from "../../shared/display-width.ts";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import { normalizeCollapsedToolText } from "../../shared/terminal-display-text.ts";
import {
	BoundedToolResult,
	getToolResultText,
} from "../../shared/tool-presentation/bounded.ts";
import type { WorkflowDefinition, WorkflowState } from "./workflow.ts";

const PRESENTATION_KIND = "workflow-tool";
const STAGE_CHANGE_ARROW = "->";
/** Matches the standard four-row collapsed content budget used by package tools. */
const COLLAPSED_REFERENCE_CONTENT_LINE_LIMIT = 4;
/** Limits workflow creation YAML without counting its label or expansion hint. */
const COLLAPSED_WORKFLOW_CONTENT_LINE_LIMIT = 3;
/** Reserves indentation, quotes, and continuation markers around wrapped YAML scalars. */
const YAML_SYNTAX_WIDTH_RESERVE = 8;

type WorkflowToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

/** Identifies one workflow or stage without depending on the current catalog. */
interface WorkflowPresentationReference {
	readonly id: string;
	readonly description?: string;
}

/** Contains the fields represented by one catalog workflow YAML file. */
interface WorkflowContent {
	readonly description?: string;
	readonly prompt?: string;
	readonly stages?: readonly unknown[];
	readonly transitions?: readonly unknown[];
}

/** Contains the stage fields exposed by get and accepted by edit. */
interface WorkflowStageContent {
	readonly id: string;
	readonly description: string;
	readonly prompt: string;
	readonly model: Readonly<Record<string, unknown>>;
	readonly initial?: boolean;
	readonly final?: boolean;
}

/** Persists creation identity supplied before validation or state replacement. */
interface WorkflowCreatePresentation {
	readonly presentationKind: typeof PRESENTATION_KIND;
	readonly toolName: "workflow_create";
	readonly workflow: WorkflowPresentationReference;
	readonly stage?: WorkflowPresentationReference;
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

/** Persists one stage and the values needed to render reads or edits. */
interface WorkflowStagePresentation {
	readonly presentationKind: typeof PRESENTATION_KIND;
	readonly toolName: "workflow_get_stage" | "workflow_edit_stage";
	readonly stage: WorkflowPresentationReference;
	readonly content?: WorkflowStageContent;
	readonly editedContent?: WorkflowStageContent;
}

export type WorkflowToolPresentationDetails =
	| WorkflowCreatePresentation
	| WorkflowActivatePresentation
	| WorkflowTransitionPresentation
	| WorkflowStagePresentation;

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
	if (toolName === "workflow_get_stage" || toolName === "workflow_edit_stage") {
		return createWorkflowStagePresentation(toolName, args, state);
	}
	return undefined;
}

/** Captures the caller-owned dynamic workflow reference even when validation later fails. */
function createWorkflowCreatePresentation(
	args: unknown,
): WorkflowCreatePresentation | undefined {
	const workflowId = readInputString(args, "id");
	if (workflowId === undefined) {
		return undefined;
	}
	const presentation: WorkflowCreatePresentation = {
		presentationKind: PRESENTATION_KIND,
		toolName: "workflow_create",
		workflow: createReference(workflowId, readInputString(args, "description")),
	};
	const stage = findInitialStageReference(args);
	return stage === undefined ? presentation : { ...presentation, stage };
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

/** Captures stage content from saved state for get or replacement arguments for edit. */
function createWorkflowStagePresentation(
	toolName: "workflow_get_stage" | "workflow_edit_stage",
	args: unknown,
	state: WorkflowState | undefined,
): WorkflowStagePresentation | undefined {
	const stageId = readInputString(args, "stageId");
	if (stageId === undefined) {
		return undefined;
	}
	const savedStage = state?.workflow.stages.find(({ id }) => id === stageId);
	const content =
		savedStage === undefined
			? undefined
			: {
					id: savedStage.id,
					description: savedStage.description,
					prompt: savedStage.prompt,
					model: { thinking: savedStage.model?.thinking },
					initial: savedStage.initial,
					final: savedStage.final,
				};
	const editedContent =
		toolName === "workflow_edit_stage"
			? createEditedStageContent(args, savedStage?.initial, savedStage?.final)
			: undefined;
	return {
		presentationKind: PRESENTATION_KIND,
		toolName,
		stage: createReference(stageId, savedStage?.description),
		...(content === undefined ? {} : { content }),
		...(editedContent === undefined ? {} : { editedContent }),
	};
}

/** Reads the closed editable stage fields without inventing immutable flags. */
function createEditedStageContent(
	args: unknown,
	initial: boolean | undefined,
	final: boolean | undefined,
): WorkflowStageContent | undefined {
	if (!isRecord(args) || !isRecord(args["model"])) {
		return undefined;
	}
	const id = readInputString(args, "stageId");
	const description = readInputString(args, "description");
	const prompt = readInputString(args, "prompt");
	const thinking = readInputString(args["model"], "thinking");
	if (
		id === undefined ||
		description === undefined ||
		prompt === undefined ||
		thinking === undefined
	) {
		return undefined;
	}
	return {
		id,
		description,
		prompt,
		model: { thinking },
		...(initial === undefined ? {} : { initial }),
		...(final === undefined ? {} : { final }),
	};
}

/** Keeps live pending calls semantic until persisted result evidence is available. */
export function primeWorkflowRenderState(
	context: WorkflowToolRenderContext,
	presentation: WorkflowToolPresentationDetails | undefined,
): void {
	const state = context.state as WorkflowRenderState;
	if (
		context.argsComplete &&
		state.presentation === undefined &&
		presentation !== undefined
	) {
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
	const fallback = createWorkflowCreatePresentation(args);
	return renderWorkflowReferenceCall({
		toolName: "workflow_create",
		workflow: presentation?.workflow ?? fallback?.workflow,
		stage: presentation?.stage ?? fallback?.stage,
		content: createWorkflowContent(args),
		theme,
		context,
	});
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
	return renderWorkflowReferenceCall({
		toolName: "workflow_activate",
		workflow,
		stage: undefined,
		theme,
		context,
	});
}

/** Shares bounded workflow-reference rows between create and activate calls. */
function renderWorkflowReferenceCall(options: {
	readonly toolName:
		| "workflow_create"
		| "workflow_activate"
		| "workflow_get_stage"
		| "workflow_edit_stage";
	readonly workflow: WorkflowPresentationReference | undefined;
	readonly stage: WorkflowPresentationReference | undefined;
	readonly content?: WorkflowContent | WorkflowStageContent | undefined;
	readonly theme: Theme;
	readonly context: WorkflowToolRenderContext;
}): Component {
	return new WorkflowRows((width) => [
		renderToolName(options.toolName, width, options.theme),
		...(options.workflow === undefined
			? []
			: renderReference({
					label: "Workflow",
					reference: options.workflow,
					expanded: options.context.expanded,
					width,
					theme: options.theme,
				})),
		...(options.stage === undefined
			? []
			: renderReference({
					label: "Stage",
					reference: options.stage,
					expanded: options.context.expanded,
					width,
					theme: options.theme,
				})),
		...(options.content === undefined
			? []
			: renderWorkflowContent({
					content: options.content,
					expanded: options.context.expanded,
					width,
					theme: options.theme,
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

/** Renders one stage inspection or edit with bounded semantic content. */
export function renderWorkflowStageCall(
	toolName: "workflow_get_stage" | "workflow_edit_stage",
	args: unknown,
	theme: Theme,
	context: WorkflowToolRenderContext,
): Component {
	const presentation = readStagePresentation(context, toolName);
	const fallback = createWorkflowStagePresentation(toolName, args, undefined);
	const resolved = presentation ?? fallback;
	return new WorkflowRows((width) => {
		const stageId = resolved?.stage.id;
		const title = stageId === undefined ? toolName : `${toolName}: ${stageId}`;
		const attributes =
			toolName === "workflow_get_stage"
				? createStageAttributes(resolved?.content)
				: createStageChanges(resolved?.content, resolved?.editedContent);
		return [
			renderToolName(title, width, theme),
			...renderStageAttributes(attributes, context.expanded, width, theme),
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
	if (
		value["toolName"] === "workflow_get_stage" ||
		value["toolName"] === "workflow_edit_stage"
	) {
		return parseStagePresentation(value, value["toolName"]);
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
		const stage = parseReference(value["stage"]);
		const presentation: WorkflowCreatePresentation = {
			presentationKind: PRESENTATION_KIND,
			toolName,
			workflow,
		};
		return stage === undefined ? presentation : { ...presentation, stage };
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

/** Parses one persisted stage reference and its optional content. */
function parseStagePresentation(
	value: Record<string, unknown>,
	toolName: "workflow_get_stage" | "workflow_edit_stage",
): WorkflowStagePresentation | undefined {
	const stage = parseReference(value["stage"]);
	const content = parseStageContent(value["content"]);
	const editedContent = parseStageContent(value["editedContent"]);
	if (
		stage === undefined ||
		(value["content"] !== undefined && content === undefined) ||
		(value["editedContent"] !== undefined && editedContent === undefined)
	) {
		return undefined;
	}
	return {
		presentationKind: PRESENTATION_KIND,
		toolName,
		stage,
		...(content === undefined ? {} : { content }),
		...(editedContent === undefined ? {} : { editedContent }),
	};
}

/** Parses persisted stage content before rendering it as YAML. */
function parseStageContent(value: unknown): WorkflowStageContent | undefined {
	if (!isRecord(value) || !isRecord(value["model"])) {
		return undefined;
	}
	const id = value["id"];
	const description = value["description"];
	const prompt = value["prompt"];
	const thinking = value["model"]["thinking"];
	const initial = value["initial"];
	const final = value["final"];
	if (
		!isNonEmptyString(id) ||
		!isNonEmptyString(description) ||
		!isNonEmptyString(prompt) ||
		!isNonEmptyString(thinking) ||
		(initial !== undefined && typeof initial !== "boolean") ||
		(final !== undefined && typeof final !== "boolean")
	) {
		return undefined;
	}
	return {
		id,
		description,
		prompt,
		model: { thinking },
		...(initial === undefined ? {} : { initial }),
		...(final === undefined ? {} : { final }),
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

/** Reads stage evidence from the shared row state. */
function readStagePresentation(
	context: WorkflowToolRenderContext,
	toolName: "workflow_get_stage" | "workflow_edit_stage",
): WorkflowStagePresentation | undefined {
	const presentation = (context.state as WorkflowRenderState).presentation;
	return presentation?.toolName === toolName ? presentation : undefined;
}

/** Renders one standalone bright workflow tool name. */
function renderToolName(toolName: string, width: number, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(sliceTextByWidth(toolName, width)));
}

interface StageAttributeRow {
	readonly label: string;
	readonly value: string;
	readonly nextValue?: string;
}

/** Selects every stage field shown by the read tool. */
function createStageAttributes(
	content: WorkflowStageContent | undefined,
): readonly StageAttributeRow[] | undefined {
	if (content === undefined) {
		return undefined;
	}
	return [
		{ label: "Description", value: content.description },
		{ label: "Prompt", value: content.prompt },
		{ label: "Thinking", value: String(content.model["thinking"]) },
		...(content.initial === undefined
			? []
			: [{ label: "Initial", value: String(content.initial) }]),
		...(content.final === undefined
			? []
			: [{ label: "Final", value: String(content.final) }]),
	];
}

/** Selects only editable fields whose captured old and new values differ. */
function createStageChanges(
	content: WorkflowStageContent | undefined,
	editedContent: WorkflowStageContent | undefined,
): readonly StageAttributeRow[] | undefined {
	if (content === undefined || editedContent === undefined) {
		return undefined;
	}
	const editableValues: ReadonlyArray<readonly [string, string, string]> = [
		["Description", content.description, editedContent.description],
		["Prompt", content.prompt, editedContent.prompt],
		[
			"Thinking",
			String(content.model["thinking"]),
			String(editedContent.model["thinking"]),
		],
	];
	return editableValues
		.filter(([, previous, next]) => previous !== next)
		.map(([label, value, nextValue]) => ({ label, value, nextValue }));
}

/** Renders one collapsed attribute after normalizing its source line breaks. */
function renderCollapsedStageAttribute(
	attribute: StageAttributeRow,
	width: number,
	theme: Theme,
): readonly string[] {
	const value = normalizeCollapsedToolText(attribute.value);
	const nextValue =
		attribute.nextValue === undefined
			? undefined
			: normalizeCollapsedToolText(attribute.nextValue);
	const label = theme.fg("toolTitle", theme.bold(`${attribute.label}:`));
	const renderedValue =
		nextValue === undefined
			? theme.fg("toolOutput", ` ${value}`)
			: `${theme.fg("toolOutput", ` ${value} `)}${theme.fg("success", STAGE_CHANGE_ARROW)}${theme.fg("toolOutput", ` ${nextValue}`)}`;
	return new Text(`${label}${renderedValue}`, 0, 0).render(width);
}

/** Renders one expanded attribute as a standard named section. */
function renderExpandedStageAttribute(
	attribute: StageAttributeRow,
	width: number,
	theme: Theme,
): readonly string[] {
	return [
		...new Text(theme.fg("muted", `--- ${attribute.label} ---`), 0, 0).render(
			width,
		),
		...new Text(theme.fg("toolOutput", attribute.value), 0, 0).render(width),
		...(attribute.nextValue === undefined
			? []
			: [
					...new Text(theme.fg("success", STAGE_CHANGE_ARROW), 0, 0).render(
						width,
					),
					...new Text(theme.fg("toolOutput", attribute.nextValue), 0, 0).render(
						width,
					),
				]),
	];
}

/** Applies one shared collapsed budget after rendering independent attributes. */
function renderStageAttributes(
	attributes: readonly StageAttributeRow[] | undefined,
	expanded: boolean,
	width: number,
	theme: Theme,
): readonly string[] {
	if (attributes === undefined) {
		return [];
	}
	if (attributes.length === 0) {
		return new Text(theme.fg("toolOutput", "No changes."), 0, 0).render(width);
	}
	if (expanded) {
		return attributes.flatMap((attribute) =>
			renderExpandedStageAttribute(attribute, width, theme),
		);
	}
	return new BoundedToolResult({
		text: "",
		theme,
		isError: false,
		expanded: false,
		collapsedContentLineLimit: COLLAPSED_REFERENCE_CONTENT_LINE_LIMIT,
		showHiddenLineHint: true,
		showExpandedErrorLabel: false,
		renderCollapsedLines: (renderWidth) =>
			attributes.flatMap((attribute) =>
				renderCollapsedStageAttribute(attribute, renderWidth, theme),
			),
	}).render(width);
}

/** Renders complete expanded YAML or a three-line collapsed YAML preview. */
function renderWorkflowContent(options: {
	readonly content: WorkflowContent | WorkflowStageContent;
	readonly expanded: boolean;
	readonly width: number;
	readonly theme: Theme;
}): readonly string[] {
	const serialize = (width: number) =>
		serializeWorkflowContent(options.content, width).map((line) =>
			options.theme.fg("toolOutput", line),
		);
	if (options.expanded) {
		return [
			...new Text(options.theme.fg("muted", "--- Content ---"), 0, 0).render(
				options.width,
			),
			...serialize(options.width),
		];
	}
	return [
		...new Text(
			options.theme.fg("toolTitle", options.theme.bold("Content:")),
			0,
			0,
		).render(options.width),
		...new BoundedToolResult({
			text: "",
			theme: options.theme,
			isError: false,
			expanded: false,
			collapsedContentLineLimit: COLLAPSED_WORKFLOW_CONTENT_LINE_LIMIT,
			showHiddenLineHint: true,
			showExpandedErrorLabel: false,
			renderCollapsedLines: serialize,
		}).render(options.width),
	];
}

/** Selects the complete section or Pi's standard bounded collapsed preview. */
function renderReference(options: {
	readonly label: "Workflow" | "Stage" | "From" | "To";
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
		text: "",
		theme: options.theme,
		isError: false,
		expanded: false,
		collapsedContentLineLimit: COLLAPSED_REFERENCE_CONTENT_LINE_LIMIT,
		showHiddenLineHint: true,
		showExpandedErrorLabel: false,
		renderCollapsedLines: (width) =>
			renderLabeledWrappedText({
				label: `${options.label}:`,
				text: normalizeCollapsedToolText(formatReference(options.reference)),
				width,
				labelStyle: (value) =>
					options.theme.fg("toolTitle", options.theme.bold(value)),
				textStyle: (value) => options.theme.fg("toolOutput", value),
			}),
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

function findInitialStageReference(
	args: unknown,
): WorkflowPresentationReference | undefined {
	if (!isRecord(args) || !Array.isArray(args["stages"])) {
		return undefined;
	}
	const stage = args["stages"].find(
		(value) => isRecord(value) && value["initial"] === true,
	);
	if (!isRecord(stage)) {
		return undefined;
	}
	const stageId = readInputString(stage, "id");
	return stageId === undefined
		? undefined
		: createReference(stageId, readInputString(stage, "description"));
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

/** Selects YAML serialization that fits without display-layer line wrapping. */
function serializeWorkflowContent(
	content: WorkflowContent | WorkflowStageContent,
	width: number,
): readonly string[] {
	const renderWidth = Math.max(1, Math.floor(width));
	const defaultLines = yamlLines(stringify(content));
	if (defaultLines.every((line) => visibleWidth(line) <= renderWidth)) {
		return defaultLines;
	}
	let narrowestLines = defaultLines;
	for (
		let lineWidth = Math.max(1, renderWidth - YAML_SYNTAX_WIDTH_RESERVE);
		lineWidth >= 1;
		lineWidth--
	) {
		narrowestLines = yamlLines(
			stringify(content, {
				defaultKeyType: "PLAIN",
				defaultStringType: "QUOTE_DOUBLE",
				lineWidth,
				minContentWidth: 0,
			}),
		);
		if (narrowestLines.every((line) => visibleWidth(line) <= renderWidth)) {
			return narrowestLines;
		}
	}
	return narrowestLines;
}

/** Removes only the serializer's final newline before row rendering. */
function yamlLines(content: string): readonly string[] {
	return content.trimEnd().split("\n");
}

/** Selects the definition fields owned by catalog workflow YAML files. */
function createWorkflowContent(args: unknown): WorkflowContent | undefined {
	if (!isRecord(args)) {
		return undefined;
	}
	// Streaming parsers expose fields independently, so select each compatible value.
	const content: WorkflowContent = {
		...(typeof args["description"] === "string"
			? { description: args["description"] }
			: {}),
		...(typeof args["prompt"] === "string" ? { prompt: args["prompt"] } : {}),
		...(Array.isArray(args["stages"]) ? { stages: args["stages"] } : {}),
		...(Array.isArray(args["transitions"])
			? { transitions: args["transitions"] }
			: {}),
	};
	return Object.keys(content).length === 0 ? undefined : content;
}

/** Reads one exact string field without normalizing tool arguments. */
function readInputString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const field = value[key];
	return isNonEmptyString(field) ? field : undefined;
}

/** Narrows persisted values to plain key-value objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects empty persisted identifiers and descriptions. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
