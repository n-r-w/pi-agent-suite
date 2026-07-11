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

/** Renders the visible header for a run_subagent tool call. */
export function renderRunSubagentCall(
	args: {
		readonly agentId?: string;
		readonly taskName: string;
		readonly prompt?: string;
	},
	theme: Theme,
	context: RunSubagentRenderContext = {},
): Component {
	const agentId =
		context.state?.headerDetails?.agentId ?? args.agentId ?? "...";
	const namePreview = normalizePreviewText(args.taskName);
	const promptPreview = args.prompt ? normalizePreviewText(args.prompt) : "...";
	return new RunSubagentCallHeader({
		headerLine: formatRunSubagentToolHeaderLine(
			agentId,
			context.state?.headerDetails,
		),
		namePreview,
		taskPreview: promptPreview,
		theme,
		expanded: context.expanded === true,
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
		details.runtime?.modelId ?? "",
		details.runtime?.thinking ?? "",
		formatSubagentProjectionStatus(details.contextProjectionStatus) ?? "",
		formatSubagentContextUsage(details.contextUsage) ?? "",
		details.elapsedMs === undefined ? "" : String(details.elapsedMs),
	].join("\u001F");
}

/** Formats the tool-call header so result body can focus on progress events. */
function formatRunSubagentToolHeaderLine(
	agentId: string,
	details: RunSubagentHeaderDetails | undefined,
): FixedLinePart[] {
	return [
		{ text: "run_subagent ", color: "toolTitle", bold: true },
		{ text: agentId, color: "accent" },
		...(details === undefined ? [] : formatSubagentRuntimeHeaderParts(details)),
		...(details?.elapsedMs === undefined
			? []
			: ([
					{ text: " · " },
					{ text: formatElapsedMs(details.elapsedMs), color: "dim" },
				] satisfies FixedLinePart[])),
	];
}

/** Formats runtime metadata as parts for ANSI-safe clipping. */
function formatSubagentRuntimeHeaderParts(
	details: RunSubagentHeaderDetails,
): FixedLinePart[] {
	if (details.runtime === undefined) {
		return [];
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
		{ text: " · " },
		{
			text: `${details.runtime.modelId}/${details.runtime.thinking}`,
			truncate: true,
		},
		...(projectedContextUsage !== undefined
			? ([
					{ text: " · " },
					{ text: projectedContextUsage, color: "muted" },
				] satisfies FixedLinePart[])
			: []),
	];
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

	/** Renders the compact runtime header and wraps the task text below it. */
	public render(width: number): string[] {
		const taskLines = renderLabeledWrappedText({
			label: "Task:",
			text: this.options.taskPreview,
			width,
			labelStyle: (value) => this.options.theme.bold(value),
			textStyle: (value) => this.options.theme.fg("muted", value),
		});
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
			return [headerLine, nameLine, ...taskLines];
		}

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

		const partText =
			part.truncate === true
				? truncateTextByWidth(part.text, remainingWidth, "…")
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

/** Validates details before custom rendering uses the subagent progress shape. */
function isSubagentRunDetails(value: unknown): value is SubagentRunDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const details = value as Partial<SubagentRunDetails>;
	return (
		typeof details.runId === "string" &&
		typeof details.agentId === "string" &&
		typeof details.taskName === "string" &&
		typeof details.depth === "number" &&
		typeof details.status === "string" &&
		typeof details.elapsedMs === "number" &&
		Array.isArray(details.events) &&
		Array.isArray(details.children)
	);
}
