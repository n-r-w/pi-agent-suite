/**
 * Width-aware rendering for the run_subagent tool.
 *
 * The default tool renderer wraps raw update text. This renderer keeps subagent
 * progress as fixed rows so terminal width changes do not break the TUI layout.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	getMarkdownTheme,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import {
	formatSubagentContextUsage,
	formatSubagentProjectionStatus,
	isSubagentRunDetails,
	type SubagentRunDetails,
} from "./progress";

/** Identifies the standard Pi action that expands collapsed tool results. */
const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
/** Limits wrapped task preview rows before the collapsed-call hint is shown. */
const RUN_SUBAGENT_TASK_PREVIEW_LINES = 3;
const SECOND_MS = 1000;
const ELAPSED_SECONDS_FRACTION_DIGITS = 1;

/** Stores metadata that belongs in the tool-call header, not in result body. */
interface RunSubagentRenderState {
	headerDetails?: RunSubagentHeaderDetails;
	headerFingerprint?: string;
}

/** Keeps child runtime metadata compact enough for the first tool row. */
interface RunSubagentHeaderDetails {
	readonly agentId: string;
	readonly sessionId: number;
	readonly runtime: SubagentRunDetails["runtime"];
	readonly contextUsage: SubagentRunDetails["contextUsage"];
	readonly contextProjectionStatus: SubagentRunDetails["contextProjectionStatus"];
	readonly elapsedMs: number | undefined;
}

/** Describes the subset of Pi renderer context used by this renderer. */
interface RunSubagentRenderContext {
	readonly args?: { readonly prompt?: string };
	readonly expanded?: boolean;
	readonly state?: RunSubagentRenderState;
	readonly invalidate?: () => void;
}

/** Supplies shared call rendering with tool-specific initial identity. */
interface RenderSubagentCallOptions {
	readonly toolName: "run_subagent" | "resume_subagent";
	readonly initialAgentId: string | undefined;
	readonly initialSessionId: number | undefined;
	readonly args: { readonly taskName: string; readonly prompt?: string };
	readonly theme: Theme;
	readonly context: RunSubagentRenderContext;
}

/** Supplies one width-bounded header without merging public tool semantics. */
interface FormatSubagentToolHeaderOptions {
	readonly toolName: "run_subagent" | "resume_subagent";
	readonly agentId: string | undefined;
	readonly details: RunSubagentHeaderDetails | undefined;
	readonly sessionId: number | undefined;
}

/** Renders the visible header for a new run_subagent session. */
export function renderRunSubagentCall(
	args: {
		readonly agentId: string;
		readonly taskName: string;
		readonly prompt?: string;
	},
	theme: Theme,
	context: RunSubagentRenderContext = {},
): Component {
	return renderSubagentCall({
		toolName: "run_subagent",
		initialAgentId: args.agentId,
		initialSessionId: undefined,
		args,
		theme,
		context,
	});
}

/** Renders the visible header for a resume_subagent continuation. */
export function renderResumeSubagentCall(
	args: {
		readonly resumeSession: number;
		readonly taskName: string;
		readonly prompt?: string;
	},
	theme: Theme,
	context: RunSubagentRenderContext,
	initialAgentId: string | undefined,
): Component {
	return renderSubagentCall({
		toolName: "resume_subagent",
		initialAgentId,
		initialSessionId: args.resumeSession,
		args,
		theme,
		context,
	});
}

/** Builds one shared historical component while preserving tool-specific identity. */
function renderSubagentCall(options: RenderSubagentCallOptions): Component {
	const details = options.context.state?.headerDetails;
	const namePreview = normalizePreviewText(options.args.taskName);
	const promptPreview = options.args.prompt
		? normalizePreviewText(options.args.prompt)
		: "...";
	return new RunSubagentCallHeader({
		headerLine: formatSubagentToolHeaderLine({
			toolName: options.toolName,
			agentId: details?.agentId ?? options.initialAgentId,
			details,
			sessionId: details?.sessionId ?? options.initialSessionId,
		}),
		namePreview,
		taskPreview: promptPreview,
		theme: options.theme,
		expanded: options.context.expanded === true,
	});
}

/** Renders live and final progress for one child agent run. */
export function renderRunSubagentResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean; readonly isPartial?: boolean },
	theme: Theme,
	context: RunSubagentRenderContext,
): Component {
	const details = isSubagentRunDetails(result.details)
		? result.details
		: undefined;
	if (details === undefined) {
		return new Text(getResultText(result) ?? "(no output)", 0, 0);
	}

	updateRunSubagentHeaderDetails(details, context, options.isPartial === true);

	if (options.expanded === true) {
		return renderExpandedSubagentResult(
			details,
			context.args?.prompt,
			options.isPartial === true ? undefined : getResultText(result),
			theme,
		);
	}

	return new Container();
}

/** Renders the expanded task and terminal result without retained progress events. */
function renderExpandedSubagentResult(
	details: SubagentRunDetails,
	prompt: string | undefined,
	resultText: string | undefined,
	theme: Theme,
): Container {
	const container = new Container();

	if (prompt !== undefined) {
		container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", prompt), 0, 0));
	}

	const finalOutput =
		details.status === "running"
			? undefined
			: details.finalOutput.trim() ||
				resultText?.trim() ||
				details.errorMessage?.trim();
	if (finalOutput !== undefined && finalOutput.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("muted", "─── Final output ───"), 0, 0),
		);
		container.addChild(new Markdown(finalOutput, 0, 0, getMarkdownTheme()));
	}

	return container;
}

/** Stores the latest result metadata for the next call-header render. */
function updateRunSubagentHeaderDetails(
	details: SubagentRunDetails,
	context: RunSubagentRenderContext,
	isPartial: boolean,
): void {
	if (context.state === undefined) {
		return;
	}

	const headerDetails: RunSubagentHeaderDetails = {
		agentId: details.agentId,
		sessionId: details.sessionId,
		runtime: details.runtime,
		contextUsage: isPartial ? undefined : details.contextUsage,
		contextProjectionStatus: isPartial
			? undefined
			: details.contextProjectionStatus,
		elapsedMs: isPartial ? undefined : details.elapsedMs,
	};
	const headerFingerprint = formatRunSubagentHeaderFingerprint(headerDetails);
	if (context.state.headerFingerprint === headerFingerprint) {
		return;
	}

	context.state.headerDetails = headerDetails;
	context.state.headerFingerprint = headerFingerprint;
	if (context.invalidate !== undefined) {
		queueMicrotask(context.invalidate);
	}
}

/** Formats a stable value used to avoid redundant renderer invalidations. */
function formatRunSubagentHeaderFingerprint(
	details: RunSubagentHeaderDetails,
): string {
	return [
		details.agentId,
		String(details.sessionId),
		details.runtime?.modelId ?? "",
		details.runtime?.thinking ?? "",
		formatSubagentProjectionStatus(details.contextProjectionStatus) ?? "",
		formatSubagentContextUsage(details.contextUsage) ?? "",
		details.elapsedMs === undefined ? "" : String(details.elapsedMs),
	].join("\u001F");
}

/** Formats the tool-call header so result body can focus on progress events. */
function formatSubagentToolHeaderLine(
	options: FormatSubagentToolHeaderOptions,
): FixedLinePart[] {
	const sessionParts = formatSessionHeaderParts(options.sessionId);
	const reservedSessionWidth = measureFixedLineParts(sessionParts);
	return [
		{
			text:
				options.agentId === undefined
					? options.toolName
					: `${options.toolName} `,
			color: "toolTitle",
			bold: true,
		},
		...(options.agentId === undefined
			? []
			: ([
					{
						text: options.agentId,
						color: "accent",
						truncate: true,
						reserveAfterWidth: reservedSessionWidth,
					},
				] satisfies FixedLinePart[])),
		...(options.details === undefined
			? sessionParts
			: formatSubagentRuntimeHeaderParts(options.details, sessionParts)),
		...(options.details?.elapsedMs === undefined
			? []
			: ([
					{ text: " · " },
					{
						text: formatElapsedMs(options.details.elapsedMs),
						color: "dim",
					},
				] satisfies FixedLinePart[])),
	];
}

/** Formats runtime metadata as parts for ANSI-safe clipping. */
function formatSubagentRuntimeHeaderParts(
	details: RunSubagentHeaderDetails,
	sessionParts: readonly FixedLinePart[],
): FixedLinePart[] {
	if (details.runtime === undefined) {
		return [...sessionParts];
	}

	const contextUsage = formatSubagentContextUsage(details.contextUsage);
	const projectionStatus = formatSubagentProjectionStatus(
		details.contextProjectionStatus,
	);
	const projectedContextUsage =
		contextUsage !== undefined && projectionStatus !== undefined
			? `${projectionStatus}/${contextUsage}`
			: contextUsage;
	return [
		{
			text: ` · ${details.runtime.modelId}/${details.runtime.thinking}`,
			truncate: true,
			minimumWidth: 4,
			reserveAfterWidth: measureFixedLineParts(sessionParts),
		},
		...sessionParts,
		...(projectedContextUsage !== undefined
			? ([
					{ text: " · " },
					{ text: projectedContextUsage, color: "muted" },
				] satisfies FixedLinePart[])
			: []),
	];
}

/** Formats the stable local session label for either public subagent tool. */
function formatSessionHeaderParts(
	sessionId: number | undefined,
): FixedLinePart[] {
	return sessionId === undefined ? [] : [{ text: ` · #${sessionId}` }];
}

/** Measures plain fixed-line parts before the width-prioritized header is rendered. */
function measureFixedLineParts(parts: readonly FixedLinePart[]): number {
	return parts.reduce((total, part) => total + visibleWidth(part.text), 0);
}

/** Formats the collapsed expansion hint with Pi's current keybinding. */
function formatSubagentExpandHintLine(
	hiddenLineCount: number,
	totalLineCount: number,
): FixedLinePart[] {
	return [
		{
			text: `... (${hiddenLineCount} more ${formatLineWord(hiddenLineCount)}, ${totalLineCount} total, `,
			color: "muted",
		},
		{ text: formatToolExpandKeybindingText(), color: "dim" },
		{ text: " to expand)", color: "muted" },
	];
}

/** Selects a readable singular or plural word for hidden-line status. */
function formatLineWord(lineCount: number): string {
	return lineCount === 1 ? "line" : "lines";
}

/** Formats the currently configured keys for expanding collapsed tool results. */
function formatToolExpandKeybindingText(): string {
	return getKeybindings().getKeys(EXPAND_TOOL_RESULT_KEYBINDING).join("/");
}

/** Formats elapsed milliseconds into a short duration string. */
function formatElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}

	return `${(elapsedMs / SECOND_MS).toFixed(ELAPSED_SECONDS_FRACTION_DIGITS)}s`;
}

/** Normalizes multi-line output into one preview line before width clipping. */
function normalizePreviewText(value: string, maxWidth?: number): string {
	const normalizedValue = value.replace(/\s+/g, " ").trim();
	return maxWidth === undefined
		? normalizedValue
		: truncateTextByWidth(normalizedValue, maxWidth, "…");
}

/** One renderable piece of a fixed-width line before color is applied. */
interface FixedLinePart {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly bold?: boolean;
	readonly truncate?: boolean;
	readonly minimumWidth?: number;
	readonly reserveAfterWidth?: number;
}

/** Groups immutable inputs for one historical call component. */
interface RunSubagentCallHeaderOptions {
	readonly headerLine: readonly FixedLinePart[];
	readonly namePreview: string;
	readonly taskPreview: string;
	readonly theme: Theme;
	readonly expanded: boolean;
}

/** Renders the subagent call header with a bounded, expandable task preview. */
class RunSubagentCallHeader implements Component {
	public constructor(private readonly options: RunSubagentCallHeaderOptions) {}

	/** Renders the common header and adds a bounded task preview only when collapsed. */
	public render(width: number): string[] {
		const headerLine = renderFixedLine(
			this.options.headerLine,
			width,
			this.options.theme,
		);
		const nameLine = renderFixedLine(
			[
				{ text: "Name:", bold: true },
				{
					text: ` ${this.options.namePreview}`,
					color: "muted",
					truncate: true,
				},
			],
			width,
			this.options.theme,
		);
		if (this.options.expanded) {
			return [headerLine, nameLine];
		}

		const taskLines = renderLabeledWrappedText({
			label: "Task:",
			text: this.options.taskPreview,
			width,
			labelStyle: (value) => this.options.theme.bold(value),
			textStyle: (value) => this.options.theme.fg("muted", value),
		});
		const previewLines = taskLines.slice(0, RUN_SUBAGENT_TASK_PREVIEW_LINES);
		const hiddenLineCount = taskLines.length - previewLines.length;
		if (hiddenLineCount <= 0) {
			return [headerLine, nameLine, ...previewLines];
		}

		return [
			headerLine,
			nameLine,
			...previewLines,
			renderFixedLine(
				formatSubagentExpandHintLine(hiddenLineCount, taskLines.length),
				width,
				this.options.theme,
			),
		];
	}

	/** Keeps the component compatible with the TUI invalidation contract. */
	public invalidate(): void {}
}

/** Renders one line by clipping raw text first, then applying theme colors. */
function renderFixedLine(
	parts: readonly FixedLinePart[],
	width: number,
	theme: Theme,
): string {
	let remainingWidth = width;
	let renderedLine = "";
	for (const part of parts) {
		if (remainingWidth <= 0) {
			break;
		}

		const partWidth = Math.max(
			0,
			remainingWidth - (part.reserveAfterWidth ?? 0),
		);
		if (part.minimumWidth !== undefined && partWidth < part.minimumWidth) {
			continue;
		}
		const partText =
			part.truncate === true
				? truncateTextByWidth(part.text, partWidth, "…")
				: sliceTextByWidth(part.text, remainingWidth);
		if (partText.length === 0) {
			continue;
		}

		const emphasizedText = part.bold === true ? theme.bold(partText) : partText;
		const styledText =
			part.color === undefined
				? emphasizedText
				: theme.fg(part.color, emphasizedText);
		renderedLine += styledText;
		remainingWidth -= visibleWidth(partText);
	}

	return renderedLine;
}

/** Reads the first text part from a tool result for fallback rendering. */
function getResultText(result: AgentToolResult<unknown>): string | undefined {
	const part = result.content[0];
	return part?.type === "text" ? part.text : undefined;
}
