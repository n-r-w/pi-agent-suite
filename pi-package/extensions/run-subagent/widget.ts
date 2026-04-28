/**
 * Subagent widget helpers.
 *
 * The widget uses a width-aware component because TUI components must never
 * return lines wider than the `render(width)` argument.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateTextByWidth } from "../../shared/display-width";
import {
	formatSubagentContextUsage,
	type SubagentContextUsage,
	type SubagentRunDetails,
	type SubagentRunStatus,
} from "./progress";

/** Defines the widget identifier used by ctx.ui.setWidget(). */
export const SUBAGENT_WIDGET_KEY = "subagents";

/** Defines the minimum width of the visual separator above the widget panel. */
const SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH = 1;
const MIN_ACTIVITY_PREVIEW_LENGTH = 12;
const ACTIVITY_PREVIEW_RESERVED_WIDTH = 32;
const FAILED_STATUS_PRIORITY = 0;
const ABORTED_STATUS_PRIORITY = 1;
const RUNNING_STATUS_PRIORITY = 2;
const COMPLETED_STATUS_PRIORITY = 3;
const SECOND_MS = 1000;

/** Stores one node in the UI-only subagent run tree. */
export interface SubagentWidgetNode {
	readonly runId: string;
	readonly agentId: string;
	readonly status: SubagentRunStatus;
	readonly depth: number;
	readonly updatedAtMs: number;
	readonly elapsedMs: number;
	readonly contextUsage: SubagentContextUsage | undefined;
	readonly contextProjectionStatus: string | undefined;
	readonly activity: string | undefined;
	readonly children: readonly SubagentWidgetNode[];
}

/** Stores the root runs currently known by the widget. */
export interface SubagentWidgetState {
	readonly roots: SubagentWidgetNode[];
}

/** Creates an empty subagent widget state for one extension runtime. */
export function createSubagentWidgetState(): SubagentWidgetState {
	return { roots: [] };
}

/** Updates the UI-only tree with a direct subagent run and its nested runs. */
export function recordSubagentWidgetRun(
	state: SubagentWidgetState,
	details: SubagentRunDetails,
	nowMs: number,
): void {
	const node = toWidgetNode(details, nowMs);
	const existingIndex = state.roots.findIndex(
		(root) => root.runId === node.runId,
	);
	if (existingIndex >= 0) {
		state.roots[existingIndex] = node;
		return;
	}

	state.roots.push(node);
}

/** Creates the component factory passed to ctx.ui.setWidget(). */
export function createSubagentWidgetFactory(
	state: SubagentWidgetState,
	lineBudget: number,
): () => Component {
	return () => ({
		render(width: number): string[] {
			const safeWidth = Math.max(
				SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH,
				Math.floor(width),
			);
			const rendered = renderSubagentWidget(state, lineBudget, safeWidth).lines;
			return formatSubagentWidgetPanel(rendered, safeWidth);
		},
		invalidate(): void {},
	});
}

/** Adds a separator and constrains every widget row to the terminal width. */
export function formatSubagentWidgetPanel(
	lines: readonly string[],
	containerWidth: number,
): string[] {
	const safeContainerWidth = Math.max(
		SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH,
		Math.floor(containerWidth),
	);
	const constrainedLines = lines.map((line) =>
		truncateTextByWidth(line, safeContainerWidth, "..."),
	);
	return ["─".repeat(safeContainerWidth), ...constrainedLines];
}

/** Renders compact widget lines within the configured line budget. */
function renderSubagentWidget(
	state: SubagentWidgetState,
	lineBudget: number,
	width: number,
): { lines: string[]; hiddenCount: number } {
	const normalizedBudget = Math.max(1, Math.floor(lineBudget));
	const summary = summarizeSubagentTree(state.roots);
	const header = `Subagents: ${summary.running} running · ${summary.failed} failed · ${summary.done} done`;
	if (normalizedBudget === 1) {
		return { lines: [header], hiddenCount: countNodes(state.roots) };
	}

	const previewLength = Math.max(
		MIN_ACTIVITY_PREVIEW_LENGTH,
		width - ACTIVITY_PREVIEW_RESERVED_WIDTH,
	);
	const candidates = flattenTreeRows(
		state.roots,
		"",
		{ value: 0 },
		previewLength,
	);
	const bodyBudget = normalizedBudget - 1;
	const selectedRows = selectWidgetRows(candidates, bodyBudget);
	const hiddenRows = candidates.filter(
		(candidate) => !selectedRows.includes(candidate),
	);
	const lines = [header, ...selectedRows.map((row) => row.text)];
	if (hiddenRows.length > 0) {
		const hiddenSummary = summarizeWidgetRows(hiddenRows);
		const hiddenText = `└─ … ${hiddenRows.length} hidden: ${hiddenSummary.done} done · ${hiddenSummary.running} running`;
		if (lines.length >= normalizedBudget) {
			lines[lines.length - 1] = hiddenText;
		} else {
			lines.push(hiddenText);
		}
	}

	return { lines, hiddenCount: hiddenRows.length };
}

/** Converts serializable run details into widget tree nodes. */
function toWidgetNode(
	details: SubagentRunDetails,
	nowMs: number,
): SubagentWidgetNode {
	const updatedAtMs = details.events.at(-1)?.timestampMs ?? nowMs;
	return {
		runId: details.runId,
		agentId: details.agentId,
		status: details.status,
		depth: details.depth,
		updatedAtMs,
		elapsedMs: details.elapsedMs,
		contextUsage: details.contextUsage
			? { ...details.contextUsage }
			: undefined,
		contextProjectionStatus: details.contextProjectionStatus,
		activity: getCurrentActivity(details),
		children: details.children.map((child) => toWidgetNode(child, nowMs)),
	};
}

/** Extracts the latest visible activity without exposing nested final answers. */
function getCurrentActivity(details: SubagentRunDetails): string | undefined {
	const lastEvent = details.events.at(-1);
	if (lastEvent === undefined) {
		return details.status === "running" ? "starting" : undefined;
	}

	return lastEvent.text
		? `${lastEvent.title} ${lastEvent.text}`
		: lastEvent.title;
}

/** Summarizes visible status counts and maximum tree depth. */
function summarizeSubagentTree(nodes: readonly SubagentWidgetNode[]): {
	running: number;
	failed: number;
	done: number;
	maxDepth: number;
} {
	const summary = { running: 0, failed: 0, done: 0, maxDepth: 0 };
	for (const node of nodes) {
		if (node.status === "running") {
			summary.running += 1;
		} else if (node.status === "failed" || node.status === "aborted") {
			summary.failed += 1;
		} else {
			summary.done += 1;
		}
		summary.maxDepth = Math.max(summary.maxDepth, node.depth);
		const childSummary = summarizeSubagentTree(node.children);
		summary.running += childSummary.running;
		summary.failed += childSummary.failed;
		summary.done += childSummary.done;
		summary.maxDepth = Math.max(summary.maxDepth, childSummary.maxDepth);
	}

	return summary;
}

/** Summarizes flattened rows without counting descendants twice. */
function summarizeWidgetRows(rows: readonly WidgetRow[]): {
	running: number;
	failed: number;
	done: number;
} {
	const summary = { running: 0, failed: 0, done: 0 };
	for (const row of rows) {
		if (row.node.status === "running") {
			summary.running += 1;
		} else if (row.node.status === "failed" || row.node.status === "aborted") {
			summary.failed += 1;
		} else {
			summary.done += 1;
		}
	}

	return summary;
}

/** Counts all nodes in the tree. */
function countNodes(nodes: readonly SubagentWidgetNode[]): number {
	return nodes.reduce(
		(count, node) => count + 1 + countNodes(node.children),
		0,
	);
}

/** Stores one pre-rendered row with priority metadata. */
interface WidgetRow {
	readonly text: string;
	readonly node: SubagentWidgetNode;
	readonly order: number;
}

/** Flattens the tree while preserving visible parent-child indentation. */
function flattenTreeRows(
	nodes: readonly SubagentWidgetNode[],
	prefix = "",
	orderRef = { value: 0 },
	activityPreviewLength = 80,
): WidgetRow[] {
	const rows: WidgetRow[] = [];
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (node === undefined) {
			continue;
		}
		const isLast = index === nodes.length - 1;
		const branch = isLast ? "└─" : "├─";
		const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
		rows.push({
			text: `${prefix}${branch} ${formatWidgetNode(node, activityPreviewLength)}`,
			node,
			order: orderRef.value,
		});
		orderRef.value += 1;
		rows.push(
			...flattenTreeRows(
				node.children,
				childPrefix,
				orderRef,
				activityPreviewLength,
			),
		);
	}

	return rows;
}

/** Selects rows by status priority while keeping output order stable. */
function selectWidgetRows(
	rows: readonly WidgetRow[],
	budget: number,
): WidgetRow[] {
	if (rows.length <= budget) {
		return [...rows];
	}

	return [...rows]
		.sort(
			(left, right) =>
				getStatusPriority(left.node.status) -
					getStatusPriority(right.node.status) ||
				right.node.updatedAtMs - left.node.updatedAtMs,
		)
		.slice(0, Math.max(0, budget - 1))
		.sort((left, right) => left.order - right.order);
}

/** Formats one compact node row for the widget. */
function formatWidgetNode(
	node: SubagentWidgetNode,
	activityPreviewLength: number,
): string {
	const contextUsage = formatWidgetContextUsage(node);
	const contextText = contextUsage ? ` · ${contextUsage}` : "";
	const activity = node.activity
		? ` · ${formatWidgetPreview(node.activity, activityPreviewLength)}`
		: "";
	return `${formatWidgetStatusIcon(node.status)} ${node.agentId} ${formatElapsedMs(node.elapsedMs)}${contextText}${activity}`;
}

/** Formats child-owned projection savings next to the same child context usage. */
function formatWidgetContextUsage(
	node: SubagentWidgetNode,
): string | undefined {
	const contextUsage = formatSubagentContextUsage(node.contextUsage);
	if (contextUsage === undefined) {
		return undefined;
	}
	if (node.contextProjectionStatus === undefined) {
		return contextUsage;
	}

	return `${node.contextProjectionStatus}/${contextUsage}`;
}

/** Assigns lower numeric values to rows that must stay visible first. */
function getStatusPriority(status: SubagentRunStatus): number {
	if (status === "failed") {
		return FAILED_STATUS_PRIORITY;
	}
	if (status === "aborted") {
		return ABORTED_STATUS_PRIORITY;
	}
	if (status === "running") {
		return RUNNING_STATUS_PRIORITY;
	}

	return COMPLETED_STATUS_PRIORITY;
}

/** Selects the status icon used in the widget. */
function formatWidgetStatusIcon(status: SubagentRunStatus): string {
	if (status === "running") {
		return "⏳";
	}
	if (status === "succeeded") {
		return "✓";
	}
	if (status === "aborted") {
		return "■";
	}

	return "✗";
}

/** Formats elapsed milliseconds into compact widget text. */
function formatElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}

	return `${Math.round(elapsedMs / SECOND_MS)}s`;
}

/** Keeps widget activity text short before width-based clipping. */
function formatWidgetPreview(value: string, maxLength: number): string {
	const normalizedValue = value.replace(/\s+/g, " ").trim();
	if (normalizedValue.length <= maxLength) {
		return normalizedValue;
	}

	return `${normalizedValue.slice(0, maxLength)}…`;
}
