import type {
	SubagentContextUsage,
	SubagentProgressEvent,
	SubagentRunDetails,
	SubagentRunStatus,
	SubagentRuntimeDetails,
} from "../../pi-package/extensions/run-subagent/progress";
import type { SubagentWidgetTheme } from "../../pi-package/extensions/run-subagent/widget-lines";

export type { SubagentWidgetTheme };

import {
	createSubagentWidgetFactory,
	createSubagentWidgetState,
	recordSubagentWidgetRun,
} from "../../pi-package/extensions/run-subagent/widget";

const DEFAULT_SUBAGENT_ELAPSED_MS = 1000;

export const DEFAULT_SUBAGENT_WIDGET_WIDTH = 200;

export interface SubagentWidgetRunFixture {
	readonly runId: string;
	readonly agentId?: string;
	readonly taskName?: string;
	readonly sessionId?: number;
	readonly childSessionId?: string;
	readonly status?: SubagentRunStatus;
	readonly elapsedMs?: number;
	readonly runtime?: SubagentRuntimeDetails;
	readonly contextUsage?: SubagentContextUsage;
	readonly contextProjectionStatus?: string;
	readonly isResume?: boolean;
	readonly events?: readonly SubagentProgressEvent[];
	readonly children?: readonly SubagentWidgetRunFixture[];
}

interface SubagentWidgetEventTiming {
	readonly timestampMs: number;
	readonly toolCallId: string;
}

/** Creates one recursive run snapshot with explicit behavior-relevant fields. */
function createRun(
	fixture: SubagentWidgetRunFixture,
	depth = 1,
): SubagentRunDetails {
	return {
		formatVersion: 1,
		runId: fixture.runId,
		agentId: fixture.agentId ?? fixture.runId,
		taskName: fixture.taskName ?? `Inspect ${fixture.runId}`,
		sessionId: fixture.sessionId ?? 1,
		childSessionId: fixture.childSessionId ?? fixture.runId,
		depth,
		runtime: fixture.runtime,
		contextUsage: fixture.contextUsage,
		contextProjectionStatus: fixture.contextProjectionStatus,
		isResume: fixture.isResume ?? false,
		status: fixture.status ?? "running",
		elapsedMs: fixture.elapsedMs ?? DEFAULT_SUBAGENT_ELAPSED_MS,
		exitCode: undefined,
		finalOutput: "",
		stderr: "",
		stopReason: undefined,
		errorMessage: undefined,
		events: fixture.events ?? [],
		omittedEventCount: 0,
		children: (fixture.children ?? []).map((child) =>
			createRun(child, depth + 1),
		),
	};
}

interface RenderSubagentWidgetFixtureOptions {
	readonly roots: readonly SubagentWidgetRunFixture[];
	readonly lineBudget: number;
	readonly width: number;
	readonly theme: SubagentWidgetTheme | undefined;
	readonly pinnedChildSessionId: string | undefined;
}

/** Renders the automatic widget through its public state and component factory. */
export function renderSubagentWidgetFixture(
	roots: readonly SubagentWidgetRunFixture[],
	lineBudget: number,
	width = DEFAULT_SUBAGENT_WIDGET_WIDTH,
	theme?: SubagentWidgetTheme,
): string[] {
	return renderSubagentWidget({
		roots,
		lineBudget,
		width,
		theme,
		pinnedChildSessionId: undefined,
	});
}

/** Renders one pinned session without adding pin controls to unrelated tests. */
export function renderPinnedSubagentWidgetFixture(
	roots: readonly SubagentWidgetRunFixture[],
	pinnedChildSessionId: string,
	lineBudget: number,
	width = DEFAULT_SUBAGENT_WIDGET_WIDTH,
): string[] {
	return renderSubagentWidget({
		roots,
		lineBudget,
		width,
		theme: undefined,
		pinnedChildSessionId,
	});
}

/** Renders one pinned session with explicit styling for color assertions. */
export function renderStyledPinnedSubagentWidgetFixture(
	options: RenderSubagentWidgetFixtureOptions,
): string[] {
	return renderSubagentWidget(options);
}

/** Builds widget state once so automatic and pinned fixtures share session labels. */
function renderSubagentWidget(
	options: RenderSubagentWidgetFixtureOptions,
): string[] {
	const state = createSubagentWidgetState();
	for (const [index, root] of options.roots.entries()) {
		recordSubagentWidgetRun(state, createRun(root), index + 1);
	}
	state.pinnedChildSessionId = options.pinnedChildSessionId;
	return createSubagentWidgetFactory(state, options.lineBudget)(
		undefined,
		options.theme,
	).render(options.width);
}

/** Removes the separator that Pi renders outside the configured line budget. */
export function getSubagentWidgetContentLines(
	rendered: readonly string[],
): readonly string[] {
	return rendered.slice(1);
}

/** Creates a progress event used to control activity and admission recency. */
export function createSubagentWidgetEvent(
	kind: SubagentProgressEvent["kind"],
	title: string,
	text: string | undefined,
	timing: number | SubagentWidgetEventTiming,
): SubagentProgressEvent {
	const timestampMs = typeof timing === "number" ? timing : timing.timestampMs;
	const toolCallId = typeof timing === "number" ? undefined : timing.toolCallId;
	return { kind, title, text, toolCallId, timestampMs };
}
