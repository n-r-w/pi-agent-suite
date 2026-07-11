/**
 * Live subagent widget state and Pi component integration.
 *
 * The widget keeps recursive run snapshots, delegates ancestor-safe selection
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
	findFocusedSubagentWidgetRun,
	type SubagentWidgetNode,
	selectVisibleWidgetForest,
	summarizeWidgetNodes,
	type VisibleWidgetNode,
} from "./widget-tree";

/** Defines the widget identifier used by ctx.ui.setWidget(). */
export const SUBAGENT_WIDGET_KEY = "subagents";

/** Defines the minimum width of the visual separator above the widget panel. */
const SUBAGENT_WIDGET_SEPARATOR_MIN_WIDTH = 1;
/** Prefix removed from conventional agent IDs in compact user-facing labels. */
const SUBAGENT_AGENT_PREFIX = "SubAgent";

/** Stores the root runs currently known by the widget. */
export interface SubagentWidgetState {
	readonly roots: SubagentWidgetNode[];
	readonly instanceNumberByRunId: Map<string, number>;
	readonly nextInstanceNumberByAgentId: Map<string, number>;
	pinnedRunId: string | undefined;
}

/** Creates an empty subagent widget state for one extension runtime. */
export function createSubagentWidgetState(): SubagentWidgetState {
	return {
		roots: [],
		instanceNumberByRunId: new Map(),
		nextInstanceNumberByAgentId: new Map(),
		pinnedRunId: undefined,
	};
}

/** Resets run identity and view ownership when Pi starts another session. */
export function resetSubagentWidgetState(state: SubagentWidgetState): void {
	state.roots.length = 0;
	state.instanceNumberByRunId.clear();
	state.nextInstanceNumberByAgentId.clear();
	state.pinnedRunId = undefined;
}

/** Updates the UI-only tree with a direct subagent run and its nested runs. */
export function recordSubagentWidgetRun(
	state: SubagentWidgetState,
	details: SubagentRunDetails,
	nowMs: number,
): void {
	const node = toWidgetNode(state, details, nowMs);
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

/** Renders either the automatic hierarchy or one explicitly selected run. */
function renderSubagentWidget(
	state: SubagentWidgetState,
	lineBudget: number,
	width: number,
): readonly WidgetLine[] {
	const normalizedBudget = Math.max(1, Math.floor(lineBudget));
	if (state.pinnedRunId !== undefined) {
		const focused = findFocusedSubagentWidgetRun(
			state.roots,
			state.pinnedRunId,
		);
		if (focused !== undefined) {
			return renderFocusedSubagentWidget(focused, normalizedBudget);
		}
	}

	const summary = summarizeWidgetNodes(state.roots);
	const totalRunCount = summary.running + summary.failed + summary.done;
	const forest = selectVisibleWidgetForest(state.roots, normalizedBudget - 1);
	const displayedRunCount = countVisibleWidgetNodes(forest.roots);
	const header = formatWidgetHeader(summary, displayedRunCount, totalRunCount);
	if (normalizedBudget === 1 || state.roots.length === 0) {
		return [header];
	}

	return [header, ...renderVisibleWidgetForest(forest, width)];
}

/** Counts concrete rendered runs while excluding local and global aggregate rows. */
function countVisibleWidgetNodes(nodes: readonly VisibleWidgetNode[]): number {
	return nodes.reduce(
		(total, node) => total + 1 + countVisibleWidgetNodes(node.children),
		0,
	);
}

/** Converts serializable run details into widget tree nodes. */
function toWidgetNode(
	state: SubagentWidgetState,
	details: SubagentRunDetails,
	nowMs: number,
): SubagentWidgetNode {
	const updatedAtMs = details.events.at(-1)?.timestampMs ?? nowMs;
	const agentId = normalizeTerminalDisplayText(details.agentId);
	const taskName = normalizeTerminalDisplayText(details.taskName);
	const instanceNumber = resolveInstanceNumber(state, details.runId, agentId);
	return {
		runId: details.runId,
		agentId,
		taskName,
		instanceNumber,
		label: `${formatAgentType(agentId)} #${instanceNumber} · ${taskName}`,
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
		children: details.children.map((child) =>
			toWidgetNode(state, child, nowMs),
		),
	};
}

/** Assigns one immutable display sequence across all roots and nested process updates. */
function resolveInstanceNumber(
	state: SubagentWidgetState,
	runId: string,
	agentId: string,
): number {
	const assigned = state.instanceNumberByRunId.get(runId);
	if (assigned !== undefined) {
		return assigned;
	}

	const next = state.nextInstanceNumberByAgentId.get(agentId) ?? 1;
	state.instanceNumberByRunId.set(runId, next);
	state.nextInstanceNumberByAgentId.set(agentId, next + 1);
	return next;
}

/** Removes the conventional prefix while preserving custom agent identifiers. */
function formatAgentType(agentId: string): string {
	if (
		agentId.startsWith(SUBAGENT_AGENT_PREFIX) &&
		agentId.length > SUBAGENT_AGENT_PREFIX.length
	) {
		return agentId.slice(SUBAGENT_AGENT_PREFIX.length);
	}
	return agentId;
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
