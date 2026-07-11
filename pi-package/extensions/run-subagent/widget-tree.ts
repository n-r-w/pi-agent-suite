/**
 * Hierarchy-safe selection for the live subagent widget.
 *
 * Selection works on recursive nodes and returns a pruned forest with omission
 * ownership. Connectors are intentionally outside this module because they
 * depend only on the final visible sibling lists.
 */

import type { SubagentContextUsage, SubagentRunStatus } from "./progress";

/** Stores one node in the UI-only subagent run tree. */
export interface SubagentWidgetNode {
	readonly runId: string;
	readonly agentId: string;
	readonly status: SubagentRunStatus;
	readonly updatedAtMs: number;
	readonly elapsedMs: number;
	readonly contextUsage: SubagentContextUsage | undefined;
	readonly contextProjectionStatus: string | undefined;
	readonly activity: string | undefined;
	readonly children: readonly SubagentWidgetNode[];
}

/** Stores aggregate lifecycle counts for one complete subtree set. */
export interface WidgetSummary {
	readonly running: number;
	readonly failed: number;
	readonly done: number;
}

/** Stores one visible node and aggregate ownership of omitted descendants. */
export interface VisibleWidgetNode {
	readonly node: SubagentWidgetNode;
	readonly children: readonly VisibleWidgetNode[];
	readonly hiddenSummary: WidgetSummary;
}

/** Stores the visible roots and optional aggregate for omitted root branches. */
export interface VisibleWidgetForest {
	readonly roots: readonly VisibleWidgetNode[];
	readonly hiddenRootSummary: WidgetSummary;
	readonly hiddenRootCount: number;
	readonly showGlobalSummary: boolean;
}

/** Stores immutable selection metadata calculated from one render snapshot. */
interface AnnotatedWidgetNode {
	readonly node: SubagentWidgetNode;
	readonly children: readonly AnnotatedWidgetNode[];
	readonly summary: WidgetSummary;
	readonly terminalSeverity: TerminalSeverity;
	readonly subtreeUpdatedAtMs: number;
	readonly sourceOrder: number;
}

/** Ranks hidden terminal subtrees without relying on ancestor status propagation. */
type TerminalSeverity = "failed" | "aborted" | "succeeded";

/** Stores selected annotations and omitted root ownership during allocation. */
interface SelectionForest {
	readonly roots: readonly SelectionNode[];
	readonly hiddenRoots: readonly AnnotatedWidgetNode[];
}

/** Stores one selected annotation and its omitted direct child subtrees. */
interface SelectionNode {
	readonly annotated: AnnotatedWidgetNode;
	readonly children: readonly SelectionNode[];
	readonly hiddenChildren: readonly AnnotatedWidgetNode[];
}

/** Groups immutable inputs and mutable membership for one selection pass. */
interface WidgetSelectionContext {
	readonly roots: readonly AnnotatedWidgetNode[];
	readonly selected: Set<SubagentWidgetNode>;
	readonly bodyBudget: number;
}

/** Summarizes all direct and nested nodes for the aggregate header. */
export function summarizeWidgetNodes(
	nodes: readonly SubagentWidgetNode[],
): WidgetSummary {
	let summary = emptyWidgetSummary();
	for (const node of nodes) {
		summary = addWidgetSummaries(summary, summarizeNodeStatus(node.status));
		summary = addWidgetSummaries(summary, summarizeWidgetNodes(node.children));
	}
	return summary;
}

/** Selects an ancestor-complete forest within the body line budget. */
export function selectVisibleWidgetForest(
	nodes: readonly SubagentWidgetNode[],
	bodyBudget: number,
): VisibleWidgetForest {
	const annotations = annotateWidgetTree(nodes);
	const selected = selectWidgetNodes(annotations, bodyBudget);
	const selection = buildSelectionForest(annotations, selected);
	const selectedRows = selection.roots.reduce(
		(total, root) => total + countSelectionNodeRows(root),
		0,
	);
	const showGlobalSummary =
		selection.hiddenRoots.length > 0 &&
		(requiresGlobalSummary(selection.hiddenRoots) || selectedRows < bodyBudget);
	return {
		roots: selection.roots.map(toVisibleWidgetNode),
		hiddenRootSummary: summarizeAnnotatedNodes(selection.hiddenRoots),
		hiddenRootCount: selection.hiddenRoots.length,
		showGlobalSummary,
	};
}

/** Converts an allocated node to the rendering model without priority metadata. */
function toVisibleWidgetNode(node: SelectionNode): VisibleWidgetNode {
	return {
		node: node.annotated.node,
		children: node.children.map(toVisibleWidgetNode),
		hiddenSummary: summarizeAnnotatedNodes(node.hiddenChildren),
	};
}

/** Annotates one immutable render snapshot for deterministic admission decisions. */
function annotateWidgetTree(
	nodes: readonly SubagentWidgetNode[],
): readonly AnnotatedWidgetNode[] {
	const sourceOrder = { value: 0 };
	return nodes.map((node) => annotateWidgetNode(node, sourceOrder));
}

/** Calculates subtree counts, priority, recency, and stable source order. */
function annotateWidgetNode(
	node: SubagentWidgetNode,
	sourceOrder: { value: number },
): AnnotatedWidgetNode {
	const nodeOrder = sourceOrder.value;
	sourceOrder.value += 1;
	const children = node.children.map((child) =>
		annotateWidgetNode(child, sourceOrder),
	);
	const summary = addWidgetSummaries(
		summarizeNodeStatus(node.status),
		summarizeAnnotatedNodes(children),
	);
	return {
		node,
		children,
		summary,
		terminalSeverity: getSubtreeTerminalSeverity(node.status, children),
		subtreeUpdatedAtMs: Math.max(
			node.updatedAtMs,
			...children.map((child) => child.subtreeUpdatedAtMs),
		),
		sourceOrder: nodeOrder,
	};
}

/** Selects roots and descendant frontiers without ever admitting an orphan. */
function selectWidgetNodes(
	roots: readonly AnnotatedWidgetNode[],
	bodyBudget: number,
): ReadonlySet<SubagentWidgetNode> {
	const context: WidgetSelectionContext = {
		roots,
		selected: new Set<SubagentWidgetNode>(),
		bodyBudget,
	};
	admitCandidates(
		roots.filter((root) => root.summary.running > 0),
		compareCandidateRecency,
		context,
	);
	admitCandidates(
		roots.filter(
			(root) =>
				root.summary.running === 0 && root.terminalSeverity !== "succeeded",
		),
		compareTerminalCandidates,
		context,
	);
	admitFrontierPhase(
		context,
		(candidate) => candidate.summary.running > 0,
		compareCandidateRecency,
	);
	admitFrontierPhase(
		context,
		(candidate) =>
			candidate.summary.running === 0 &&
			candidate.terminalSeverity !== "succeeded",
		compareTerminalCandidates,
	);
	admitFrontierPhase(context, isCompletedWidgetNode, compareCandidateRecency);
	admitCompletedRootCandidates(
		roots.filter(isCompletedWidgetNode),
		compareCandidateRecency,
		context,
	);

	// Completed descendants cannot consume the aggregate row for omitted roots.
	const rootSelection = buildSelectionForest(roots, context.selected);
	if (rootSelection.hiddenRoots.length === 0) {
		admitFrontierPhase(context, isCompletedWidgetNode, compareCandidateRecency);
	}
	return context.selected;
}

/** Identifies terminal successful work that may use rows left after attention paths. */
function isCompletedWidgetNode(candidate: AnnotatedWidgetNode): boolean {
	return (
		candidate.summary.running === 0 &&
		candidate.terminalSeverity === "succeeded"
	);
}

/** Admits each root candidate once in deterministic priority order. */
function admitCandidates(
	candidates: readonly AnnotatedWidgetNode[],
	compare: (left: AnnotatedWidgetNode, right: AnnotatedWidgetNode) => number,
	context: WidgetSelectionContext,
): void {
	for (const candidate of [...candidates].sort(compare)) {
		tryAdmitWidgetNode(candidate, context);
	}
}

/** Uses spare rows for completed roots while preserving one summary for remaining root overflow. */
function admitCompletedRootCandidates(
	candidates: readonly AnnotatedWidgetNode[],
	compare: (left: AnnotatedWidgetNode, right: AnnotatedWidgetNode) => number,
	context: WidgetSelectionContext,
): void {
	for (const candidate of [...candidates].sort(compare)) {
		context.selected.add(candidate.node);
		const prospective = buildSelectionForest(context.roots, context.selected);
		const optionalSummaryRows =
			prospective.hiddenRoots.length > 0 &&
			!requiresGlobalSummary(prospective.hiddenRoots)
				? 1
				: 0;
		if (
			countRequiredWidgetRows(prospective) + optionalSummaryRows <=
			context.bodyBudget
		) {
			continue;
		}
		context.selected.delete(candidate.node);
	}
}

/** Expands at most one fitting frontier per visible root in each fair round. */
function admitFrontierPhase(
	context: WidgetSelectionContext,
	matches: (candidate: AnnotatedWidgetNode) => boolean,
	compare: (left: AnnotatedWidgetNode, right: AnnotatedWidgetNode) => number,
): void {
	let admittedInRound: boolean;
	do {
		admittedInRound = false;
		const forest = buildSelectionForest(context.roots, context.selected);
		const selectedRoots = [...forest.roots].sort((left, right) =>
			compare(left.annotated, right.annotated),
		);
		for (const root of selectedRoots) {
			const candidates = collectFrontierCandidates(root)
				.filter(matches)
				.sort(compare);
			for (const candidate of candidates) {
				if (tryAdmitWidgetNode(candidate, context)) {
					admittedInRound = true;
					break;
				}
			}
		}
	} while (admittedInRound);
}

/** Collects nearest hidden children whose parents are already visible. */
function collectFrontierCandidates(node: SelectionNode): AnnotatedWidgetNode[] {
	return [
		...node.hiddenChildren,
		...node.children.flatMap(collectFrontierCandidates),
	];
}

/** Commits one node only when the complete prospective tree fits the budget. */
function tryAdmitWidgetNode(
	candidate: AnnotatedWidgetNode,
	context: WidgetSelectionContext,
): boolean {
	context.selected.add(candidate.node);
	const prospective = buildSelectionForest(context.roots, context.selected);
	if (countRequiredWidgetRows(prospective) <= context.bodyBudget) {
		return true;
	}
	context.selected.delete(candidate.node);
	return false;
}

/** Builds the selected forest and assigns every omission to its nearest owner. */
function buildSelectionForest(
	roots: readonly AnnotatedWidgetNode[],
	selected: ReadonlySet<SubagentWidgetNode>,
): SelectionForest {
	return {
		roots: roots
			.filter((root) => selected.has(root.node))
			.map((root) => buildSelectionNode(root, selected)),
		hiddenRoots: roots.filter((root) => !selected.has(root.node)),
	};
}

/** Builds one selected branch while retaining omitted direct child subtrees. */
function buildSelectionNode(
	annotated: AnnotatedWidgetNode,
	selected: ReadonlySet<SubagentWidgetNode>,
): SelectionNode {
	return {
		annotated,
		children: annotated.children
			.filter((child) => selected.has(child.node))
			.map((child) => buildSelectionNode(child, selected)),
		hiddenChildren: annotated.children.filter(
			(child) => !selected.has(child.node),
		),
	};
}

/** Counts selected nodes, local summaries, and required root summaries. */
function countRequiredWidgetRows(forest: SelectionForest): number {
	const selectedRows = forest.roots.reduce(
		(total, root) => total + countSelectionNodeRows(root),
		0,
	);
	return selectedRows + (requiresGlobalSummary(forest.hiddenRoots) ? 1 : 0);
}

/** Counts one selected branch including summaries after partial expansion. */
function countSelectionNodeRows(node: SelectionNode): number {
	const childRows = node.children.reduce(
		(total, child) => total + countSelectionNodeRows(child),
		0,
	);
	const localSummaryRows =
		node.children.length > 0 && node.hiddenChildren.length > 0 ? 1 : 0;
	return 1 + childRows + localSummaryRows;
}

/** Requires a root summary while omitted branches contain active or failed work. */
function requiresGlobalSummary(
	hiddenRoots: readonly AnnotatedWidgetNode[],
): boolean {
	return hiddenRoots.some(
		(root) => root.summary.running > 0 || root.terminalSeverity !== "succeeded",
	);
}

/** Summarizes complete annotated subtrees without double counting. */
function summarizeAnnotatedNodes(
	nodes: readonly AnnotatedWidgetNode[],
): WidgetSummary {
	return nodes.reduce(
		(summary, node) => addWidgetSummaries(summary, node.summary),
		emptyWidgetSummary(),
	);
}

/** Creates an empty lifecycle count value. */
function emptyWidgetSummary(): WidgetSummary {
	return { running: 0, failed: 0, done: 0 };
}

/** Adds two immutable lifecycle summaries. */
function addWidgetSummaries(
	left: WidgetSummary,
	right: WidgetSummary,
): WidgetSummary {
	return {
		running: left.running + right.running,
		failed: left.failed + right.failed,
		done: left.done + right.done,
	};
}

/** Maps one run status to the aggregate header categories. */
function summarizeNodeStatus(status: SubagentRunStatus): WidgetSummary {
	if (status === "running") {
		return { running: 1, failed: 0, done: 0 };
	}
	if (status === "failed" || status === "aborted") {
		return { running: 0, failed: 1, done: 0 };
	}
	return { running: 0, failed: 0, done: 1 };
}

/** Calculates the strongest terminal status contained in one subtree. */
function getSubtreeTerminalSeverity(
	status: SubagentRunStatus,
	children: readonly AnnotatedWidgetNode[],
): TerminalSeverity {
	if (
		status === "failed" ||
		children.some((child) => child.terminalSeverity === "failed")
	) {
		return "failed";
	}
	if (
		status === "aborted" ||
		children.some((child) => child.terminalSeverity === "aborted")
	) {
		return "aborted";
	}
	return "succeeded";
}

/** Orders terminal attention by severity before recency. */
function compareTerminalCandidates(
	left: AnnotatedWidgetNode,
	right: AnnotatedWidgetNode,
): number {
	return (
		getTerminalSeverityRank(left.terminalSeverity) -
			getTerminalSeverityRank(right.terminalSeverity) ||
		compareCandidateRecency(left, right)
	);
}

/** Applies deterministic activity-recency and source-order tie breaks. */
function compareCandidateRecency(
	left: AnnotatedWidgetNode,
	right: AnnotatedWidgetNode,
): number {
	return (
		right.subtreeUpdatedAtMs - left.subtreeUpdatedAtMs ||
		left.sourceOrder - right.sourceOrder
	);
}

/** Assigns lower ranks to more important terminal subtree outcomes. */
function getTerminalSeverityRank(severity: TerminalSeverity): number {
	if (severity === "failed") {
		return 0;
	}
	if (severity === "aborted") {
		return 1;
	}
	return 2;
}
