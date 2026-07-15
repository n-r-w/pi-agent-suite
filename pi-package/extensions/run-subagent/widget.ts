/**
 * Live subagent widget state and Pi component integration.
 *
 * The widget keeps recursive logical-session snapshots, delegates ancestor-safe selection
 * to the tree allocator, and delegates width-safe output to line rendering.
 */

import type { Component } from "@earendil-works/pi-tui";
import { normalizeTerminalDisplayText } from "../../shared/terminal-display-text";
import {
	isSubagentToolLifecycleEvent,
	type SubagentProgressEvent,
	type SubagentRunDetails,
} from "./progress";
import {
	formatWidgetHeader,
	formatWidgetPanel,
	renderFocusedSubagentWidget,
	renderVisibleWidgetForest,
	type SubagentWidgetTheme,
	type WidgetLine,
} from "./widget-lines";
import {
	findFocusedSubagentWidgetSession,
	type SubagentWidgetNode,
	selectVisibleWidgetForest,
	summarizeWidgetNodes,
	type VisibleWidgetNode,
} from "./widget-tree";

/** Defines the widget identifier used by ctx.ui.setWidget(). */
export const SUBAGENT_WIDGET_KEY = "subagents";

/** Defines the minimum width of the visual separator above the widget panel. */
const SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH = 1;
/** Stores the root child sessions currently known by the widget. */
export interface SubagentWidgetState {
	readonly roots: SubagentWidgetNode[];
	pinnedChildSessionId: string | undefined;
}

/** Creates an empty subagent widget state for one extension runtime. */
export function createSubagentWidgetState(): SubagentWidgetState {
	return {
		roots: [],
		pinnedChildSessionId: undefined,
	};
}

/** Resets logical-session presentation and view ownership for another main session. */
export function resetSubagentWidgetState(state: SubagentWidgetState): void {
	state.roots.length = 0;
	state.pinnedChildSessionId = undefined;
}

/** Updates the UI-only tree with one direct child session and its descendants. */
export function recordSubagentWidgetRun(
	state: SubagentWidgetState,
	details: SubagentRunDetails,
	nowMs: number,
): void {
	const node = toWidgetNode(details, nowMs);
	const existingIndex = state.roots.findIndex(
		(root) => root.childSessionId === node.childSessionId,
	);
	if (existingIndex >= 0) {
		const existing = state.roots[existingIndex];
		if (existing !== undefined) {
			state.roots[existingIndex] = mergeWidgetNodes(existing, node);
		}
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

/** Renders either the automatic hierarchy or one explicitly selected child session. */
function renderSubagentWidget(
	state: SubagentWidgetState,
	lineBudget: number,
	width: number,
): readonly WidgetLine[] {
	const normalizedBudget = Math.max(1, Math.floor(lineBudget));
	if (state.pinnedChildSessionId !== undefined) {
		const focused = findFocusedSubagentWidgetSession(
			state.roots,
			state.pinnedChildSessionId,
		);
		if (focused !== undefined) {
			return renderFocusedSubagentWidget(focused, normalizedBudget);
		}
	}

	const summary = summarizeWidgetNodes(state.roots);
	const totalSessionCount = summary.running + summary.failed + summary.done;
	const forest = selectVisibleWidgetForest(state.roots, normalizedBudget - 1);
	const displayedSessionCount = countVisibleWidgetNodes(forest.roots);
	const header = formatWidgetHeader(
		summary,
		displayedSessionCount,
		totalSessionCount,
	);
	if (normalizedBudget === 1 || state.roots.length === 0) {
		return [header];
	}

	return [header, ...renderVisibleWidgetForest(forest, width)];
}

/** Counts concrete rendered sessions while excluding aggregate rows. */
function countVisibleWidgetNodes(nodes: readonly VisibleWidgetNode[]): number {
	return nodes.reduce(
		(total, node) => total + 1 + countVisibleWidgetNodes(node.children),
		0,
	);
}

/** Converts serializable invocation details into logical widget nodes. */
function toWidgetNode(
	details: SubagentRunDetails,
	nowMs: number,
): SubagentWidgetNode {
	const updatedAtMs = details.events.at(-1)?.timestampMs ?? nowMs;
	const agentId = normalizeTerminalDisplayText(details.agentId);
	const taskName = normalizeTerminalDisplayText(details.taskName);
	return {
		runId: details.runId,
		childSessionId: details.childSessionId,
		agentId,
		taskName,
		sessionId: details.sessionId,
		isResume: details.isResume,
		status: details.status,
		updatedAtMs,
		elapsedMs: details.elapsedMs,
		runtime: details.runtime
			? {
					modelId: normalizeTerminalDisplayText(details.runtime.modelId),
					thinking: normalizeTerminalDisplayText(details.runtime.thinking),
					contextWindow: details.runtime.contextWindow,
				}
			: undefined,
		contextUsage: details.contextUsage
			? { ...details.contextUsage }
			: undefined,
		contextProjectionStatus: normalizeOptionalDisplayText(
			details.contextProjectionStatus,
		),
		activity: getCurrentActivity(details),
		events: details.events.map((event) => ({ ...event })),
		children: details.children.map((child) => toWidgetNode(child, nowMs)),
	};
}

/** Applies the latest invocation snapshot while preserving descendants absent from it. */
function mergeWidgetNodes(
	previous: SubagentWidgetNode,
	latest: SubagentWidgetNode,
): SubagentWidgetNode {
	const children = [...previous.children];
	for (const child of latest.children) {
		const existingIndex = children.findIndex(
			(existing) => existing.childSessionId === child.childSessionId,
		);
		if (existingIndex < 0) {
			children.push(child);
			continue;
		}
		const existing = children[existingIndex];
		if (existing !== undefined) {
			children[existingIndex] = mergeWidgetNodes(existing, child);
		}
	}
	return { ...latest, children };
}

/** Extracts the latest tool activity while ignoring later assistant lifecycle events. */
function getCurrentActivity(details: SubagentRunDetails): string | undefined {
	let lastToolEvent: SubagentProgressEvent | undefined;
	for (let index = details.events.length - 1; index >= 0; index -= 1) {
		const event = details.events[index];
		if (event !== undefined && isSubagentToolLifecycleEvent(event)) {
			lastToolEvent = event;
			break;
		}
	}
	if (lastToolEvent === undefined) {
		return details.status === "running" ? "starting" : undefined;
	}
	if (lastToolEvent.kind === "tool_call") {
		return formatToolActivity(lastToolEvent.title, lastToolEvent.text);
	}

	const matchingCall = findMatchingToolCall(details.events, lastToolEvent);
	const toolActivity = formatToolActivity(
		lastToolEvent.title,
		matchingCall?.text,
	);
	if (lastToolEvent.kind === "error") {
		return `${toolActivity} → failed`;
	}
	if (lastToolEvent.text?.trim().toLowerCase() === "no matches found") {
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
