/**
 * Width-aware rendering for the run_subagent tool.
 *
 * The default tool renderer wraps raw update text. This renderer keeps subagent
 * progress as fixed rows so terminal width changes do not break the TUI layout.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	getMarkdownTheme,
	type Theme,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";
import {
	formatSubagentContextUsage,
	type SubagentProgressEvent,
	type SubagentRunDetails,
} from "./progress";

/** Identifies the standard Pi action that expands collapsed tool results. */
const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
export const COLLAPSED_SUBAGENT_RESULT_LINES = 5;
const EXPANDED_EVENT_PREVIEW_WIDTH = 240;
const STDERR_PREVIEW_WIDTH = 1000;
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
	readonly elapsedMs: number;
}

/** Describes the subset of Pi renderer context used by this renderer. */
interface RunSubagentRenderContext {
	readonly args?: { readonly prompt?: string };
	readonly state?: RunSubagentRenderState;
	readonly invalidate?: () => void;
}

/** Renders the visible header for a run_subagent tool call. */
export function renderRunSubagentCall(
	args: { readonly agentId?: string; readonly prompt?: string },
	theme: Theme,
	context: RunSubagentRenderContext = {},
): Component {
	const agentId =
		context.state?.headerDetails?.agentId ?? args.agentId ?? "...";
	const promptPreview = args.prompt ? normalizePreviewText(args.prompt) : "...";
	return new FixedLines(
		[
			formatRunSubagentToolHeaderLine(agentId, context.state?.headerDetails),
			[{ text: "  " }, { text: promptPreview, color: "dim", truncate: true }],
		],
		theme,
	);
}

/** Renders live and final progress for one child agent run. */
export function renderRunSubagentResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: RunSubagentRenderContext,
): Component {
	const details = isSubagentRunDetails(result.details)
		? result.details
		: undefined;
	if (details === undefined) {
		return new Text(getResultText(result) ?? "(no output)", 0, 0);
	}

	updateRunSubagentHeaderDetails(details, context);

	if (options.expanded === true) {
		return renderExpandedSubagentResult(details, context.args?.prompt, theme);
	}

	return renderCollapsedSubagentResult(details, theme);
}

/** Renders the default compact view for subagent progress. */
function renderCollapsedSubagentResult(
	details: SubagentRunDetails,
	theme: Theme,
): Component {
	const rows = buildCollapsedSubagentRows(details);
	const displayedRows = rows.slice(-COLLAPSED_SUBAGENT_RESULT_LINES);
	const hiddenLineCount =
		details.omittedEventCount + Math.max(0, rows.length - displayedRows.length);
	const totalLineCount = hiddenLineCount + displayedRows.length;
	const lines = displayedRows.map((row) => row.parts);

	if (lines.length === 0) {
		lines.push([
			{
				text:
					details.status === "running"
						? "(starting...)"
						: "(no progress events)",
				color: "muted",
			},
		]);
	}
	if (hiddenLineCount > 0) {
		lines.push(formatSubagentExpandHintLine(hiddenLineCount, totalLineCount));
	}
	return new FixedLines(lines, theme);
}

interface CollapsedSubagentRow {
	readonly parts: FixedLinePart[];
}

/** Builds collapsed progress rows without duplicating the child final answer. */
function buildCollapsedSubagentRows(
	details: SubagentRunDetails,
): CollapsedSubagentRow[] {
	return details.events.map((event) => ({
		parts: formatSubagentEventLineParts(event),
	}));
}

/** Renders the expanded view with task, progress, stderr, and final output. */
function renderExpandedSubagentResult(
	details: SubagentRunDetails,
	prompt: string | undefined,
	theme: Theme,
): Container {
	const container = new Container();

	if (prompt !== undefined) {
		container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", prompt), 0, 0));
		container.addChild(new Spacer(1));
	}

	container.addChild(new Text(theme.fg("muted", "─── Progress ───"), 0, 0));
	if (details.omittedEventCount > 0) {
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					`... ${details.omittedEventCount} earlier events omitted`,
				),
				0,
				0,
			),
		);
	}
	if (details.events.length === 0) {
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					details.status === "running"
						? "(starting...)"
						: "(no progress events)",
				),
				0,
				0,
			),
		);
	} else {
		for (const event of details.events) {
			container.addChild(
				new Text(
					formatSubagentEventLine(event, theme, EXPANDED_EVENT_PREVIEW_WIDTH),
					0,
					0,
				),
			);
		}
	}

	if (details.stderr.trim().length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Stderr ───"), 0, 0));
		container.addChild(
			new Text(
				theme.fg(
					"error",
					formatPreview(details.stderr.trim(), STDERR_PREVIEW_WIDTH),
				),
				0,
				0,
			),
		);
	}

	if (details.finalOutput.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("muted", "─── Final output ───"), 0, 0),
		);
		container.addChild(
			new Markdown(details.finalOutput.trim(), 0, 0, getMarkdownTheme()),
		);
	}

	return container;
}

/** Stores the latest result metadata for the next call-header render. */
function updateRunSubagentHeaderDetails(
	details: SubagentRunDetails,
	context: RunSubagentRenderContext,
): void {
	if (context.state === undefined) {
		return;
	}

	const headerDetails: RunSubagentHeaderDetails = {
		agentId: details.agentId,
		runtime: details.runtime,
		contextUsage: details.contextUsage,
		elapsedMs: details.elapsedMs,
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
		formatSubagentContextUsage(details.contextUsage) ?? "",
		String(details.elapsedMs),
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
		...(details === undefined
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
	return [
		{ text: " · " },
		{
			text: `${details.runtime.modelId}/${details.runtime.thinking}`,
			color: "muted",
			truncate: true,
		},
		...(contextUsage !== undefined
			? ([
					{ text: " · " },
					{ text: contextUsage, color: "muted" },
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

/** Formats one extracted child-run event for display. */
function formatSubagentEventLine(
	event: SubagentProgressEvent,
	theme: Theme,
	textLimit: number,
): string {
	return renderFixedLine(
		formatSubagentEventLineParts(event, textLimit),
		Number.MAX_SAFE_INTEGER,
		theme,
	);
}

/** Formats one extracted child-run event as plain parts for fixed-width rendering. */
function formatSubagentEventLineParts(
	event: SubagentProgressEvent,
	textLimit?: number,
): FixedLinePart[] {
	const parts: FixedLinePart[] = [
		{
			text: formatSubagentEventIconText(event.kind),
			color: formatSubagentEventIconColor(event.kind),
		},
		{ text: " " },
		{ text: event.title, color: "accent" },
	];
	if (event.text === undefined) {
		return parts;
	}

	parts.push(
		{ text: " " },
		{
			text: normalizePreviewText(event.text, textLimit),
			color: "dim",
			truncate: true,
		},
	);
	return parts;
}

/** Selects the uncolored icon text for a child event kind. */
function formatSubagentEventIconText(
	kind: SubagentProgressEvent["kind"],
): string {
	if (kind === "tool_call") {
		return "→";
	}
	if (kind === "tool_result") {
		return "←";
	}
	if (kind === "error") {
		return "!";
	}

	return "•";
}

/** Selects the theme color for a child event icon. */
function formatSubagentEventIconColor(
	kind: SubagentProgressEvent["kind"],
): ThemeColor {
	if (kind === "tool_call") {
		return "muted";
	}
	if (kind === "tool_result") {
		return "success";
	}
	if (kind === "error") {
		return "error";
	}

	return "toolOutput";
}

/** Formats elapsed milliseconds into a short duration string. */
function formatElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}

	return `${(elapsedMs / SECOND_MS).toFixed(ELAPSED_SECONDS_FRACTION_DIGITS)}s`;
}

/** Keeps long prompts and event text readable in the tool view. */
function formatPreview(value: string, maxLength: number): string {
	return truncateTextByWidth(normalizePreviewText(value), maxLength, "…");
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

/** Renders fixed lines without wrapping into extra terminal rows. */
class FixedLines implements Component {
	public constructor(
		private readonly lines: readonly (readonly FixedLinePart[])[],
		private readonly theme: Theme,
	) {}

	/** Returns lines clipped by visible terminal columns before color is applied. */
	public render(width: number): string[] {
		return this.lines.map((line) => renderFixedLine(line, width, this.theme));
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

		const styledText =
			part.color !== undefined
				? theme.fg(
						part.color,
						part.bold === true ? theme.bold(partText) : partText,
					)
				: partText;
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
		typeof details.depth === "number" &&
		typeof details.status === "string" &&
		typeof details.elapsedMs === "number" &&
		Array.isArray(details.events) &&
		Array.isArray(details.children)
	);
}
