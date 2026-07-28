import type {
	AgentToolResult,
	MessageRenderer,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container } from "@earendil-works/pi-tui";
import { getToolResultText } from "../../shared/tool-presentation/bounded.ts";
import { parseAgentOperationEvidence } from "./agent-operation-wire.ts";
import type {
	AcceptedPresentationEvidence,
	SubagentFeedback,
	WaitFeedbackPresentationEvidence,
} from "./domain.ts";
import { parseFeedback } from "./journal-codec.ts";
import {
	formatDuration,
	formatIds,
	formatMetadataRuntime,
	formatRuntime,
	renderBoundedText,
	renderContextHeader,
	renderError,
	renderFeedbackBody,
	renderHeader,
	renderMetadata,
	renderName,
	renderPrompt,
	SemanticComponent,
	type SemanticHeaderPart,
} from "./semantic-layout.ts";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

interface WaitFeedbackRenderOptions {
	readonly evidence: WaitFeedbackPresentationEvidence;
	readonly ids: readonly number[];
	readonly timeoutMs: number;
	readonly expanded: boolean;
	readonly theme: Theme;
}

interface SubagentRenderState {
	accepted?: {
		readonly sessionId: number;
		readonly evidence: AcceptedPresentationEvidence;
	};
	phase?: "error" | "settled";
}

/** Renders pending or accepted subagent_start identity and prompt. */
export function renderSubagentStartCall(
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	return new SemanticComponent((width) => {
		const state = renderState(context);
		const agentId =
			state.accepted?.evidence.agentId ?? readString(args, "agentId");
		const taskName =
			state.accepted?.evidence.taskName ?? readString(args, "taskName");
		const prompt = readString(args, "prompt") ?? "";
		const headerParts: readonly SemanticHeaderPart[] =
			state.accepted === undefined
				? [
						{ value: agentId, role: "agent" },
						{
							value: state.phase === "error" ? undefined : "starting…",
							role: "metadata",
						},
					]
				: [
						{ value: state.accepted.evidence.agentId, role: "agent" },
						{
							value: formatRuntime(state.accepted.evidence),
							role: "metadata",
						},
						{ value: `#${state.accepted.sessionId}`, role: "primary" },
					];
		const lines = [renderHeader("subagent_start", headerParts, width, theme)];
		if (taskName !== undefined) {
			lines.push(...renderName(taskName, width, theme, context.expanded));
		}
		if (state.phase !== "error") {
			lines.push(...renderPrompt(prompt, width, theme, context.expanded));
		}
		return lines;
	});
}

/** Updates one start row from accepted details or renders a structured error. */
export function renderSubagentStartResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	if (context.isError) {
		setPhase(context, "error");
		return renderError(readErrorText(result), options.expanded, theme);
	}
	const evidence = readAcceptedEvidence(result.details);
	const sessionId = readPositiveInteger(result.details, "sessionId");
	if (evidence !== undefined && sessionId !== undefined) {
		// The call component reads this row-local state lazily during Pi's current render.
		renderState(context).accepted = { evidence, sessionId };
	}
	return new Container();
}

/** Renders pending or accepted subagent_steer identity and prompt. */
export function renderSubagentSteerCall(
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	return new SemanticComponent((width) => {
		const state = renderState(context);
		const sessionId = readPositiveInteger(args, "sessionId");
		const prompt = readString(args, "prompt") ?? "";
		const accepted = state.accepted;
		let headerParts: readonly SemanticHeaderPart[];
		if (accepted === undefined) {
			headerParts = [
				{
					value: sessionId === undefined ? undefined : `#${sessionId}`,
					role: "primary",
				},
				{
					value: state.phase === "error" ? undefined : "sending…",
					role: "metadata",
				},
			];
		} else if (context.expanded) {
			headerParts = [
				{ value: accepted.evidence.agentId, role: "agent" },
				{ value: formatRuntime(accepted.evidence), role: "metadata" },
				{ value: `#${accepted.sessionId}`, role: "primary" },
			];
		} else {
			headerParts = [
				{ value: `#${accepted.sessionId}`, role: "primary" },
				{ value: accepted.evidence.agentId, role: "agent" },
				{ value: formatRuntime(accepted.evidence), role: "metadata" },
			];
		}
		const lines = [renderHeader("subagent_steer", headerParts, width, theme)];
		if (accepted !== undefined) {
			lines.push(
				...renderName(
					accepted.evidence.taskName,
					width,
					theme,
					context.expanded,
				),
			);
		}
		if (state.phase !== "error") {
			lines.push(...renderPrompt(prompt, width, theme, context.expanded));
		}
		return lines;
	});
}

/** Updates one steer row from accepted details or renders a structured error. */
export function renderSubagentSteerResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	return renderSubagentStartResult(result, options, theme, context);
}

/** Renders one pending wait request in caller-provided session order. */
export function renderSubagentWaitCall(
	args: unknown,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	return new SemanticComponent((width) => {
		if (renderState(context).phase === "settled") {
			return [];
		}
		const ids = readSessionIds(args);
		const timeoutMs = readNonNegativeInteger(args, "timeoutMs");
		return [
			renderHeader(
				"subagent_wait",
				[
					{ value: formatIds(ids), role: "primary" },
					{
						value:
							timeoutMs === undefined
								? undefined
								: `up to ${formatDuration(timeoutMs)}`,
						role: "metadata",
					},
					{ value: "waiting…", role: "metadata" },
				],
				width,
				theme,
			),
		];
	});
}

/** Renders one settled wait outcome without inferring unavailable source metadata. */
export function renderSubagentWaitResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	setPhase(context, "settled");
	const ids = readSessionIds(context.args);
	const timeoutMs = readNonNegativeInteger(context.args, "timeoutMs");
	if (context.isError) {
		return renderWaitCard(
			[{ value: formatIds(ids), role: "primary" }],
			{
				label: "Error:",
				text: readErrorText(result),
				color: "error",
			},
			options.expanded,
			theme,
		);
	}
	const outcome = readString(result.details, "outcome");
	if (outcome === "timeout") {
		const timeout = timeoutMs ?? 0;
		return renderWaitCard(
			[
				{ value: formatIds(ids), role: "primary" },
				{
					value: `${formatDuration(timeout)}/${formatDuration(timeout)}`,
					role: "metadata",
				},
				{ value: "timeout", role: "metadata" },
			],
			{
				label: "Result:",
				text: "No feedback before timeout. Subagents were not stopped.",
				color: "muted",
			},
			options.expanded,
			theme,
		);
	}
	if (outcome === "no_active_sessions") {
		return renderWaitCard(
			[
				{ value: formatIds(ids), role: "primary" },
				{ value: "no active sessions", role: "metadata" },
			],
			{
				label: "Result:",
				text: "None of the requested sessions is active.",
				color: "muted",
			},
			options.expanded,
			theme,
		);
	}
	const evidence = readWaitEvidence(result.details);
	return evidence === undefined
		? new Container()
		: renderWaitFeedback({
				evidence,
				ids,
				timeoutMs: timeoutMs ?? 0,
				expanded: options.expanded,
				theme,
			});
}

/** Renders one settled wait result with explicit normal or failure semantics. */
function renderWaitCard(
	parts: readonly SemanticHeaderPart[],
	body: {
		readonly label: string;
		readonly text: string;
		readonly color: "muted" | "error";
	},
	expanded: boolean,
	theme: Theme,
): Component {
	return new SemanticComponent((width) => [
		renderHeader("subagent_wait", parts, width, theme),
		...renderBoundedText({
			label: body.label,
			text: body.text,
			width,
			theme,
			expanded,
			color: body.color,
		}),
	]);
}

/** Renders direct owner-history feedback through the same terminal snapshot layout. */
export const renderSubagentFeedback: MessageRenderer<unknown> = (
	message,
	options,
	theme,
) => {
	const feedback = parseFeedback(message.details);
	if (feedback === undefined) {
		return undefined;
	}
	const background =
		feedback.status === "success" ? "toolSuccessBg" : "toolErrorBg";
	const box = new Box(options.outputPad, 0, (text) =>
		theme.bg(background, text),
	);
	box.addChild(renderDirectFeedback(feedback, options.expanded, theme));
	return box;
};

/** Renders one wait-owned feedback card from validated evidence. */
function renderWaitFeedback(options: WaitFeedbackRenderOptions): Component {
	return new SemanticComponent((width) => {
		const feedback = options.evidence.feedback;
		const presentation = feedback.presentation;
		return [
			renderHeader(
				"subagent_wait",
				[
					{ value: formatIds(options.ids), role: "primary" },
					{
						value: `${formatDuration(options.evidence.waitElapsedMs)}/${formatDuration(options.timeoutMs)}`,
						role: "metadata",
					},
					{ value: "->", role: "metadata" },
					{
						value: `#${feedback.sessionKey.ownerLocalSessionId}`,
						role: "primary",
						separator: " ",
					},
				],
				width,
				options.theme,
			),
			renderMetadata(presentation, width, options.theme),
			...renderName(
				presentation.taskName,
				width,
				options.theme,
				options.expanded,
			),
			...renderFeedbackBody(feedback, width, options.theme, options.expanded),
		];
	});
}

/** Renders one direct feedback card with invocation duration in its header. */
function renderDirectFeedback(
	feedback: SubagentFeedback,
	expanded: boolean,
	theme: Theme,
): Component {
	return new SemanticComponent((width) => {
		const presentation = feedback.presentation;
		const metadata = presentation.invocationMetadata;
		return [
			renderContextHeader(
				{
					toolName: "subagent feedback",
					parts: [
						{
							value: `#${feedback.sessionKey.ownerLocalSessionId}`,
							role: "primary",
						},
						{ value: presentation.agentId, role: "agent" },
						{
							value: formatMetadataRuntime(metadata),
							role: "metadata",
						},
						{
							value: formatDuration(metadata.elapsedMs),
							role: "metadata",
						},
					],
					metadata,
					width,
				},
				theme,
			),
			...renderName(presentation.taskName, width, theme, expanded),
			...renderFeedbackBody(feedback, width, theme, expanded),
		];
	});
}

/** Reads one accepted presentation envelope from mixed public result details. */
function readAcceptedEvidence(
	details: unknown,
): AcceptedPresentationEvidence | undefined {
	if (readString(details, "presentationKind") !== "accepted") {
		return undefined;
	}
	return parseAgentOperationEvidence({
		presentationKind: "accepted",
		agentId: readField(details, "agentId"),
		taskName: readField(details, "taskName"),
		...(readField(details, "modelId") === undefined
			? {}
			: { modelId: readField(details, "modelId") }),
		...(readField(details, "thinking") === undefined
			? {}
			: { thinking: readField(details, "thinking") }),
	}) as AcceptedPresentationEvidence | undefined;
}

/** Reads one wait presentation envelope from mixed public result details. */
function readWaitEvidence(
	details: unknown,
): WaitFeedbackPresentationEvidence | undefined {
	if (readString(details, "presentationKind") !== "wait-feedback") {
		return undefined;
	}
	return parseAgentOperationEvidence({
		presentationKind: "wait-feedback",
		feedbackId: readField(details, "feedbackId"),
		invocationId: readField(details, "invocationId"),
		waitRequestId: readField(details, "waitRequestId"),
		waitElapsedMs: readField(details, "waitElapsedMs"),
		feedback: readField(details, "feedback"),
	}) as WaitFeedbackPresentationEvidence | undefined;
}

/** Selects a structured failure message before public result text. */
function readErrorText(result: AgentToolResult<unknown>): string {
	return readString(result.details, "message") ?? getToolResultText(result);
}

/** Returns the shared mutable state owned by one public Pi tool row. */
function renderState(context: ToolRenderContext): SubagentRenderState {
	return context.state as SubagentRenderState;
}

/** Updates one row phase and requests redraw of the same public tool component. */
function setPhase(
	context: ToolRenderContext,
	phase: NonNullable<SubagentRenderState["phase"]>,
): void {
	// Pi renders the existing call component after the result renderer updates this state.
	renderState(context).phase = phase;
}

/** Reads one unknown object field without trusting its shape. */
function readField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, key)
		: undefined;
}

/** Reads one non-empty string field from renderer input. */
function readString(value: unknown, key: string): string | undefined {
	const field = readField(value, key);
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Reads one positive integer identifier from renderer input. */
function readPositiveInteger(value: unknown, key: string): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isSafeInteger(field) && field > 0
		? field
		: undefined;
}

/** Reads one non-negative integer duration from renderer input. */
function readNonNegativeInteger(
	value: unknown,
	key: string,
): number | undefined {
	const field = readField(value, key);
	return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
		? field
		: undefined;
}

/** Reads ordered positive session IDs without sorting or deduplication. */
function readSessionIds(value: unknown): readonly number[] {
	const field = readField(value, "sessionIds");
	return Array.isArray(field)
		? field.filter(
				(item): item is number =>
					typeof item === "number" && Number.isSafeInteger(item) && item > 0,
			)
		: [];
}
