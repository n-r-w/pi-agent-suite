/**
 * Live subagent widget state and Pi component integration.
 *
 * The widget keeps recursive run snapshots, delegates ancestor-safe selection
 * to the tree allocator, and delegates width-safe output to line rendering.
 */

import type { Component } from "@earendil-works/pi-tui";
import { normalizeTerminalDisplayText } from "../../shared/terminal-display-text";
import type { SubagentProgressEvent, SubagentRunDetails } from "./progress";
import {
	formatWidgetHeader,
	formatWidgetPanel,
	renderVisibleWidgetForest,
	type SubagentWidgetTheme,
	type WidgetLine,
} from "./widget-lines";
import {
	type SubagentWidgetNode,
	selectVisibleWidgetForest,
	summarizeWidgetNodes,
} from "./widget-tree";

/** Defines the widget identifier used by ctx.ui.setWidget(). */
export const SUBAGENT_WIDGET_KEY = "subagents";

/** Defines the minimum width of the visual separator above the widget panel. */
const SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH = 1;

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

/** Creates the passive component factory passed to ctx.ui.setWidget(). */
export function createSubagentWidgetFactory(
	state: SubagentWidgetState,
	lineBudget: number,
): (_tui?: unknown, theme?: SubagentWidgetTheme) => Component {
	return (_tui?: unknown, theme?: SubagentWidgetTheme) => ({
		render(width: number): string[] {
			const safeWidth = Math.max(
				SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH,
				Math.floor(width),
			);
			const lines = renderSubagentWidget(state, lineBudget, safeWidth);
			return formatWidgetPanel(lines, safeWidth, theme);
		},
		invalidate(): void {},
	});
}

/** Renders an ancestor-complete widget within the configured content budget. */
function renderSubagentWidget(
	state: SubagentWidgetState,
	lineBudget: number,
	width: number,
): readonly WidgetLine[] {
	const normalizedBudget = Math.max(1, Math.floor(lineBudget));
	const summary = summarizeWidgetNodes(state.roots);
	const header = formatWidgetHeader(summary);
	if (
		normalizedBudget === 1 ||
		state.roots.length === 0 ||
		(summary.running === 0 && summary.failed === 0)
	) {
		return [header];
	}

	const forest = selectVisibleWidgetForest(state.roots, normalizedBudget - 1);
	return [header, ...renderVisibleWidgetForest(forest, width)];
}

/** Converts serializable run details into widget tree nodes. */
function toWidgetNode(
	details: SubagentRunDetails,
	nowMs: number,
): SubagentWidgetNode {
	const updatedAtMs = details.events.at(-1)?.timestampMs ?? nowMs;
	return {
		runId: details.runId,
		agentId: normalizeTerminalDisplayText(details.agentId),
		status: details.status,
		updatedAtMs,
		elapsedMs: details.elapsedMs,
		contextUsage: details.contextUsage
			? { ...details.contextUsage }
			: undefined,
		contextProjectionStatus: normalizeOptionalDisplayText(
			details.contextProjectionStatus,
		),
		activity: getCurrentActivity(details),
		children: details.children.map((child) => toWidgetNode(child, nowMs)),
	};
}

/** Extracts current activity with tool arguments while excluding tool result payloads. */
function getCurrentActivity(details: SubagentRunDetails): string | undefined {
	const lastEvent = details.events.at(-1);
	if (lastEvent === undefined) {
		return details.status === "running" ? "starting" : undefined;
	}
	if (lastEvent.kind === "assistant") {
		return details.status === "running" ? "assistant" : "assistant completed";
	}
	if (lastEvent.kind === "tool_call") {
		return formatToolActivity(lastEvent.title, lastEvent.text);
	}

	const matchingCall = findMatchingToolCall(details.events, lastEvent);
	const toolActivity = formatToolActivity(lastEvent.title, matchingCall?.text);
	if (lastEvent.kind === "error") {
		return `${toolActivity} → failed`;
	}
	if (lastEvent.text?.trim().toLowerCase() === "no matches found") {
		return `${toolActivity} → no matches`;
	}
	return toolActivity;
}

/** Finds the latest call event that owns a visible tool result. */
function findMatchingToolCall(
	events: readonly SubagentProgressEvent[],
	result: SubagentProgressEvent,
): SubagentProgressEvent | undefined {
	if (result.toolCallId === undefined) {
		return undefined;
	}
	const resultIndex = events.lastIndexOf(result);
	for (let index = resultIndex - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.kind === "tool_call" && event.toolCallId === result.toolCallId) {
			return event;
		}
	}
	return undefined;
}

/** Formats a tool name with the normalized arguments captured at call start. */
function formatToolActivity(
	title: string,
	payload: string | undefined,
): string {
	const normalizedTitle = normalizeTerminalDisplayText(title);
	const toolName = normalizedTitle.startsWith("asteria_")
		? normalizedTitle.slice("asteria_".length)
		: normalizedTitle;
	const argumentsText = normalizeOptionalDisplayText(payload);
	return [toolName, argumentsText]
		.filter((part) => part !== undefined && part !== "")
		.join(" ");
}

/** Normalizes an optional display field and drops empty results. */
function normalizeOptionalDisplayText(
	value: string | undefined,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalizedValue = normalizeTerminalDisplayText(value);
	return normalizedValue.length > 0 ? normalizedValue : undefined;
}
