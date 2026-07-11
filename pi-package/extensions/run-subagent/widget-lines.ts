/**
 * Width-safe line rendering for the live subagent widget.
 *
 * Logical rows remain plain segments until grapheme-aware clipping completes.
 * Theme colors are applied afterward, so clipping never injects ANSI resets.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";
import {
	formatSubagentContextUsage,
	formatSubagentProjectionStatus,
	isSubagentToolLifecycleEvent,
	type SubagentContextUsage,
	type SubagentProgressEvent,
	type SubagentRunStatus,
} from "./progress";
import type {
	FocusedSubagentWidgetRun,
	SubagentWidgetNode,
	VisibleWidgetForest,
	VisibleWidgetNode,
	WidgetSummary,
} from "./widget-tree";

/** Converts elapsed milliseconds to seconds. */
const SECOND_MS = 1000;
/** Keeps focused-run durations consistent with historical tool headers. */
const FOCUSED_ELAPSED_SECONDS_FRACTION_DIGITS = 1;
/** Defines the number of seconds in one minute. */
const MINUTE_SECONDS = 60;
/** Defines the number of seconds in one hour. */
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
/** Starts warning-colored context pressure at half of the context window. */
const CONTEXT_WARNING_USED_PERCENT = 50;
/** Starts error-colored context pressure near context exhaustion. */
const CONTEXT_ERROR_USED_PERCENT = 80;
/** Defines the suffix used when a logical row exceeds terminal width. */
const ROW_ELLIPSIS = "...";
/** Keeps activity useful before final terminal-width clipping. */
const MIN_ACTIVITY_PREVIEW_WIDTH = 12;
/** Reserves space for connectors, status, agent, time, and context. */
const ACTIVITY_PREVIEW_RESERVED_WIDTH = 36;

/** Defines the theme subset used by widget line segments. */
export interface SubagentWidgetTheme {
	fg(color: ThemeColor, text: string): string;
}

/** Stores one plain segment and the optional color applied after clipping. */
interface WidgetLinePart {
	readonly text: string;
	readonly color?: ThemeColor;
}

/** Stores verbose and compact forms of one required inline summary. */
interface InlineSummaryVariants {
	readonly verbose: WidgetLinePart;
	readonly compact: WidgetLinePart;
}

/** Stores one logical widget row before terminal-width clipping. */
export type WidgetLine = readonly WidgetLinePart[];

/** Adds the separator and applies theme colors only after plain segment clipping. */
export function formatWidgetPanel(
	lines: readonly WidgetLine[],
	containerWidth: number,
	theme: SubagentWidgetTheme | undefined,
): string[] {
	const safeContainerWidth = Math.max(1, Math.floor(containerWidth));
	return [
		"─".repeat(safeContainerWidth),
		...lines.map((line) => renderWidgetLine(line, safeContainerWidth, theme)),
	];
}

/** Formats the aggregate header as independently styled count segments. */
export function formatWidgetHeader(
	summary: WidgetSummary,
	displayedRunCount: number,
	totalRunCount: number,
): WidgetLine {
	return [
		{ text: "Subagents: " },
		formatSummaryCountPart(summary.running, "accent"),
		{ text: " running · " },
		formatSummaryCountPart(summary.failed, "error"),
		{ text: " failed · " },
		formatSummaryCountPart(summary.done, "success"),
		{ text: ` done · ${displayedRunCount}/${totalRunCount} shown` },
		{ text: " · Ctrl+Shift+G", color: "dim" },
	];
}

/** Renders one selected run and the newest tool events that fit the panel. */
export function renderFocusedSubagentWidget(
	focused: FocusedSubagentWidgetRun,
	lineBudget: number,
): readonly WidgetLine[] {
	const safeBudget = Math.max(0, Math.floor(lineBudget));
	if (safeBudget === 0) {
		return [];
	}

	const lines: WidgetLine[] = [formatFocusedRunHeader(focused)];
	if (focused.parent !== undefined && lines.length < safeBudget) {
		lines.push(formatFocusedParentHeader(focused.parent, focused.depth));
	}

	const eventBudget = safeBudget - lines.length;
	if (eventBudget <= 0) {
		return lines;
	}
	const events = focused.selected.events
		.filter(isSubagentToolLifecycleEvent)
		.slice(-eventBudget);
	for (const [index, event] of events.entries()) {
		lines.push(formatFocusedEventLine(event, index === events.length - 1));
	}
	return lines;
}

/** Formats the selected run without instance numbering or ancestor paths. */
function formatFocusedRunHeader(focused: FocusedSubagentWidgetRun): WidgetLine {
	const node = focused.selected;
	const parts: WidgetLinePart[] = [
		{
			text: `${focused.parent === undefined ? "Root" : "Child"}: ${node.agentId} · ${node.taskName}`,
		},
	];
	if (node.runtime !== undefined) {
		parts.push({
			text: ` · ${node.runtime.modelId}/${node.runtime.thinking}`,
			color: "muted",
		});
	}
	const context = formatWidgetContextUsage(node);
	if (context !== undefined) {
		parts.push({ text: " · " }, ...context);
	}
	parts.push({
		text: ` · ${formatFocusedElapsedMs(node.elapsedMs)}`,
		color: "dim",
	});
	return parts;
}

/** Formats direct parent ownership with depth relative to the root run. */
function formatFocusedParentHeader(
	parent: SubagentWidgetNode,
	depth: number,
): WidgetLine {
	return [
		{
			text: `Parent: ${parent.agentId} · ${parent.taskName} · Depth ${depth}`,
			color: "muted",
		},
	];
}

/** Formats one call, result, or error as one non-wrapping event row. */
function formatFocusedEventLine(
	event: SubagentProgressEvent,
	isLast: boolean,
): WidgetLine {
	const icon = formatFocusedEventIcon(event.kind);
	const parts: WidgetLinePart[] = [
		{ text: `${isLast ? "└─" : "├─"} ` },
		{ text: icon.text, color: icon.color },
		{ text: ` ${event.title}`, color: "accent" },
	];
	if (event.text !== undefined) {
		parts.push({ text: ` ${event.text}`, color: "dim" });
	}
	return parts;
}

/** Maps tool event kinds to the established call-direction markers. */
function formatFocusedEventIcon(kind: SubagentProgressEvent["kind"]): {
	readonly text: string;
	readonly color: ThemeColor;
} {
	if (kind === "tool_call") {
		return { text: "→", color: "muted" };
	}
	if (kind === "tool_result") {
		return { text: "←", color: "success" };
	}
	return { text: "!", color: "error" };
}

/** Formats focused durations with one fractional second above one second. */
function formatFocusedElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}
	return `${(elapsedMs / SECOND_MS).toFixed(FOCUSED_ELAPSED_SECONDS_FRACTION_DIGITS)}s`;
}

/** Renders selected roots and an optional final root-level omission summary. */
export function renderVisibleWidgetForest(
	forest: VisibleWidgetForest,
	width: number,
): readonly WidgetLine[] {
	const rootItemCount =
		forest.roots.length + (forest.showGlobalSummary ? 1 : 0);
	const lines: WidgetLine[] = [];
	for (const [index, root] of forest.roots.entries()) {
		lines.push(
			...renderVisibleWidgetNode(root, "", index === rootItemCount - 1, width),
		);
	}
	if (forest.showGlobalSummary) {
		lines.push(
			formatOmissionLine(
				"",
				forest.hiddenRootSummary,
				forest.hiddenRootCount,
				width,
			),
		);
	}
	return lines;
}

/** Clips plain grapheme-aware segments and then applies their independent colors. */
function renderWidgetLine(
	parts: WidgetLine,
	width: number,
	theme: SubagentWidgetTheme | undefined,
): string {
	const clippedParts = clipWidgetLineParts(parts, width);
	return clippedParts
		.map((part) =>
			part.color === undefined || theme === undefined
				? part.text
				: theme.fg(part.color, part.text),
		)
		.join("");
}

/** Clips a logical row without parsing, rewriting, or truncating styled ANSI text. */
function clipWidgetLineParts(
	parts: WidgetLine,
	width: number,
): readonly WidgetLinePart[] {
	const safeWidth = Math.max(0, Math.floor(width));
	const fullWidth = parts.reduce(
		(total, part) => total + visibleWidth(part.text),
		0,
	);
	if (fullWidth <= safeWidth) {
		return parts;
	}

	const ellipsis = sliceTextByWidth(ROW_ELLIPSIS, safeWidth);
	let remainingWidth = Math.max(0, safeWidth - visibleWidth(ellipsis));
	const clipped: WidgetLinePart[] = [];
	for (const part of parts) {
		if (remainingWidth <= 0) {
			break;
		}
		const text = sliceTextByWidth(part.text, remainingWidth);
		if (text.length > 0) {
			clipped.push({ ...part, text });
			remainingWidth -= visibleWidth(text);
		}
		if (visibleWidth(text) < visibleWidth(part.text)) {
			break;
		}
	}
	if (ellipsis.length > 0) {
		clipped.push({ text: ellipsis });
	}
	return clipped;
}

/** Colors only positive aggregate counts. */
function formatSummaryCountPart(
	count: number,
	color: ThemeColor,
): WidgetLinePart {
	return count > 0 ? { text: String(count), color } : { text: String(count) };
}

/** Renders one branch and derives all connectors from visible siblings only. */
function renderVisibleWidgetNode(
	node: VisibleWidgetNode,
	prefix: string,
	isLast: boolean,
	width: number,
): readonly WidgetLine[] {
	const branch = isLast ? "└─" : "├─";
	const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
	const hiddenCount = countSummaryNodes(node.hiddenSummary);
	const inlineSummary =
		node.children.length === 0 && hiddenCount > 0
			? node.hiddenSummary
			: undefined;
	const lines: WidgetLine[] = [
		formatWidgetNodeLine(
			`${prefix}${branch} `,
			node.node,
			width,
			inlineSummary,
		),
	];
	const hasLocalSummary = node.children.length > 0 && hiddenCount > 0;
	const childItemCount = node.children.length + (hasLocalSummary ? 1 : 0);
	for (const [index, child] of node.children.entries()) {
		lines.push(
			...renderVisibleWidgetNode(
				child,
				childPrefix,
				index === childItemCount - 1,
				width,
			),
		);
	}
	if (hasLocalSummary) {
		lines.push(
			formatOmissionLine(childPrefix, node.hiddenSummary, undefined, width),
		);
	}
	return lines;
}

/** Formats one node row while reserving inline omission ownership before optional detail. */
function formatWidgetNodeLine(
	connector: string,
	node: SubagentWidgetNode,
	width: number,
	inlineSummary: WidgetSummary | undefined,
): WidgetLine {
	const status = formatWidgetStatus(node.status);
	const prefix: WidgetLinePart[] = [
		{ text: connector },
		{ text: status.icon, color: status.color },
	];
	const details: WidgetLinePart[] = [
		{ text: ` ${node.label} · ${formatElapsedMs(node.elapsedMs)}` },
	];
	const context = formatWidgetContextUsage(node);
	if (context !== undefined) {
		details.push({ text: " · " }, ...context);
	}
	if (node.activity !== undefined) {
		const activityPreviewWidth = Math.max(
			MIN_ACTIVITY_PREVIEW_WIDTH,
			width - ACTIVITY_PREVIEW_RESERVED_WIDTH,
		);
		details.push({
			text: ` · ${truncateTextByWidth(node.activity, activityPreviewWidth, "…")}`,
		});
	}
	if (inlineSummary === undefined) {
		return [...prefix, ...details];
	}
	return reserveInlineSummary(
		prefix,
		details,
		{
			verbose: { text: ` · ${formatInlineSummary(inlineSummary)}` },
			compact: { text: ` · ${formatCompactInlineSummary(inlineSummary)}` },
		},
		width,
	);
}

/** Preserves a hidden-child summary by reducing optional identity and activity detail first. */
function reserveInlineSummary(
	prefix: WidgetLine,
	details: WidgetLine,
	summaries: InlineSummaryVariants,
	width: number,
): WidgetLine {
	const safeWidth = Math.max(0, Math.floor(width));
	const prefixWidth = getWidgetLineWidth(prefix);
	if (prefixWidth >= safeWidth) {
		return clipWidgetLineParts(prefix, safeWidth);
	}
	const availableAfterPrefix = safeWidth - prefixWidth;
	const summary =
		visibleWidth(summaries.verbose.text) <= availableAfterPrefix
			? summaries.verbose
			: summaries.compact;
	const summaryParts = clipWidgetLineParts([summary], availableAfterPrefix);
	const detailsWidth = Math.max(
		0,
		availableAfterPrefix - getWidgetLineWidth(summaryParts),
	);
	return [
		...prefix,
		...clipWidgetLineParts(details, detailsWidth),
		...summaryParts,
	];
}

/** Measures plain logical segments before theme styles are applied. */
function getWidgetLineWidth(parts: WidgetLine): number {
	return parts.reduce((total, part) => total + visibleWidth(part.text), 0);
}

/** Formats child projection savings and compact context pressure. */
function formatWidgetContextUsage(
	node: SubagentWidgetNode,
): readonly WidgetLinePart[] | undefined {
	const label = formatSubagentContextUsage(node.contextUsage);
	if (label === undefined) {
		return undefined;
	}
	const parts: WidgetLinePart[] = [];
	const projectionLabel = formatSubagentProjectionStatus(
		node.contextProjectionStatus,
	);
	if (projectionLabel !== undefined) {
		parts.push({ text: projectionLabel, color: "warning" }, { text: "/" });
	}
	const color = getWidgetContextUsageColor(node.contextUsage);
	parts.push(color === undefined ? { text: label } : { text: label, color });
	return parts;
}

/** Returns context pressure color using the footer threshold contract. */
function getWidgetContextUsageColor(
	contextUsage: SubagentContextUsage | undefined,
): "warning" | "error" | undefined {
	const usedPercent = contextUsage?.percent;
	if (usedPercent === undefined || usedPercent === null) {
		return undefined;
	}
	if (usedPercent >= CONTEXT_ERROR_USED_PERCENT) {
		return "error";
	}
	if (usedPercent >= CONTEXT_WARNING_USED_PERCENT) {
		return "warning";
	}
	return undefined;
}

/** Formats a local or root-level omission row. */
function formatOmissionLine(
	prefix: string,
	summary: WidgetSummary,
	rootCount: number | undefined,
	width: number,
): WidgetLine {
	const count = countSummaryNodes(summary);
	const verboseSubject =
		rootCount === undefined
			? `${count} more`
			: `${rootCount} root ${rootCount === 1 ? "agent" : "agents"}`;
	const compactSubject =
		rootCount === undefined
			? `${count} more`
			: `${rootCount} ${rootCount === 1 ? "root" : "roots"}`;
	const verboseText = `${prefix}└─ … ${verboseSubject}: ${formatSummaryStatuses(summary)}`;
	const compactText = `${prefix}└─ … ${compactSubject}: ${formatCompactSummaryStatuses(summary)}`;
	return [
		{ text: visibleWidth(verboseText) <= width ? verboseText : compactText },
	];
}

/** Formats a zero-row omission aggregate on its owning parent row. */
function formatInlineSummary(summary: WidgetSummary): string {
	const count = countSummaryNodes(summary);
	const singleStatus = getSingleSummaryStatus(summary);
	return singleStatus === undefined
		? `${count} nested: ${getSummaryStatusSegments(summary).join(" · ")}`
		: `${count} nested ${singleStatus}`;
}

/** Formats mixed inline ownership with compact status icons. */
function formatCompactInlineSummary(summary: WidgetSummary): string {
	return `${countSummaryNodes(summary)} nested: ${formatCompactSummaryStatuses(summary)}`;
}

/** Counts all nodes represented by one omission aggregate. */
function countSummaryNodes(summary: WidgetSummary): number {
	return summary.running + summary.failed + summary.done;
}

/** Returns the status label when every omitted node shares one lifecycle state. */
function getSingleSummaryStatus(summary: WidgetSummary): string | undefined {
	if (summary.running > 0 && summary.failed === 0 && summary.done === 0) {
		return "running";
	}
	if (summary.failed > 0 && summary.running === 0 && summary.done === 0) {
		return "failed";
	}
	if (summary.done > 0 && summary.running === 0 && summary.failed === 0) {
		return "done";
	}
	return undefined;
}

/** Formats only non-zero lifecycle segments for omission summaries. */
function formatSummaryStatuses(summary: WidgetSummary): string {
	return getSummaryStatusSegments(summary).join(" · ");
}

/** Formats every non-zero lifecycle count with its existing status icon. */
function formatCompactSummaryStatuses(summary: WidgetSummary): string {
	const segments: string[] = [];
	if (summary.running > 0) {
		segments.push(`⏳${summary.running}`);
	}
	if (summary.failed > 0) {
		segments.push(`✗${summary.failed}`);
	}
	if (summary.done > 0) {
		segments.push(`✓${summary.done}`);
	}
	return segments.join(" ");
}

/** Produces lifecycle labels in live-attention order. */
function getSummaryStatusSegments(summary: WidgetSummary): string[] {
	const segments: string[] = [];
	if (summary.running > 0) {
		segments.push(`${summary.running} running`);
	}
	if (summary.failed > 0) {
		segments.push(`${summary.failed} failed`);
	}
	if (summary.done > 0) {
		segments.push(`${summary.done} done`);
	}
	return segments;
}

/** Selects the status icon and its theme color. */
function formatWidgetStatus(status: SubagentRunStatus): {
	readonly icon: string;
	readonly color: ThemeColor;
} {
	if (status === "running") {
		return { icon: "⏳", color: "accent" };
	}
	if (status === "succeeded") {
		return { icon: "✓", color: "success" };
	}
	if (status === "aborted") {
		return { icon: "■", color: "error" };
	}
	return { icon: "✗", color: "error" };
}

/** Formats elapsed milliseconds as seconds, m:ss, or h:mm:ss. */
export function formatElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}
	const totalSeconds = Math.round(elapsedMs / SECOND_MS);
	if (totalSeconds < MINUTE_SECONDS) {
		return `${totalSeconds}s`;
	}
	if (totalSeconds < HOUR_SECONDS) {
		const minutes = Math.floor(totalSeconds / MINUTE_SECONDS);
		const seconds = totalSeconds % MINUTE_SECONDS;
		return `${minutes}:${String(seconds).padStart(2, "0")}`;
	}
	const hours = Math.floor(totalSeconds / HOUR_SECONDS);
	const remainingSeconds = totalSeconds % HOUR_SECONDS;
	const minutes = Math.floor(remainingSeconds / MINUTE_SECONDS);
	const seconds = remainingSeconds % MINUTE_SECONDS;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
