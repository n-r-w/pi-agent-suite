import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { normalizeTerminalDisplayText } from "../../../shared/terminal-display-text";
import type { ProjectionNode } from "../projection";
import { formatDuration, renderContext } from "../semantic-layout";
import type { ScrollMetrics } from "./scroll-indicator";
import { AGENT_STATUS_ICONS, countAgentStatuses } from "./status-summary";

const NODE_ROW_COUNT = 2;
const TREE_CONNECTOR_WIDTH = 3;
const PREFERRED_AGENT_IDENTITY_WIDTH = 7;
const PREFERRED_TASK_TEXT_WIDTH = 8;
/** Separates only selected-detail fields that survive availability and width allocation. */
const SELECTED_DETAIL_SEPARATOR = " · ";

interface TreePrefixes {
	readonly identity: string;
	readonly continuation: string;
}

/** Retains hierarchy-only presentation state across overlay instances. */
export interface HierarchyRetainedState {
	readonly expandedStableKeys: readonly string[];
	readonly selectedStableKey: string | null;
	readonly scrollTop: number;
}

/** Supplies optional selected-session metadata that is safe to display. */
interface SelectedSessionMetadata {
	readonly elapsedMs?: number;
	readonly modelId?: string;
	readonly thinking?: string;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly projectionSavedTokens?: number;
}

/** Supplies selected-header rendering inputs without positional ambiguity. */
interface SelectedSessionHeaderOptions {
	readonly nodes: readonly ProjectionNode[];
	readonly selectedStableKey: string | null;
	readonly initialPrompt?: string;
	readonly metadata?: SelectedSessionMetadata;
	readonly width: number;
	readonly theme: Theme;
	readonly focused?: boolean;
}

/** Owns hierarchy selection, branch expansion, and viewport state. */
export class HierarchyPane {
	private nodes: readonly ProjectionNode[] = [];
	private nodesByKey = new Map<string, ProjectionNode>();
	private childrenByParent = new Map<
		string | null,
		readonly ProjectionNode[]
	>();
	private readonly expanded = new Set<string>();
	private selectedStableKey: string | null;
	private scrollTop: number;
	private lastHeight = 0;
	private lastTotalRows = 0;

	public constructor(
		nodes: readonly ProjectionNode[],
		retained?: HierarchyRetainedState,
	) {
		this.selectedStableKey = retained?.selectedStableKey ?? null;
		this.scrollTop = retained?.scrollTop ?? 0;
		for (const key of retained?.expandedStableKeys ?? []) {
			this.expanded.add(key);
		}
		this.update(nodes);
	}

	/** Replaces projected nodes while preserving stable presentation identity. */
	public update(nodes: readonly ProjectionNode[]): void {
		this.nodes = nodes;
		this.nodesByKey = new Map(nodes.map((node) => [node.stableKey, node]));
		this.childrenByParent = groupChildren(nodes);
		for (const key of [...this.expanded]) {
			if (!this.nodesByKey.has(key)) {
				this.expanded.delete(key);
			}
		}
		if (
			this.selectedStableKey === null ||
			!this.nodesByKey.has(this.selectedStableKey)
		) {
			this.selectedStableKey = this.getVisibleStableKeys()[0] ?? null;
		}
		this.ensureSelectedAncestorsExpanded();
		this.clampScrollTop();
	}

	/** Returns the selected complete stable key. */
	public getSelectedStableKey(): string | null {
		return this.selectedStableKey;
	}

	/** Returns visible stable keys in navigation order. */
	public getVisibleStableKeys(): readonly string[] {
		return this.nodes
			.filter((node) => this.isVisible(node))
			.map((node) => node.stableKey);
	}

	/** Moves selection by one visible node. */
	public moveSelection(delta: -1 | 1): boolean {
		const visible = this.getVisibleStableKeys();
		const index =
			this.selectedStableKey === null
				? -1
				: visible.indexOf(this.selectedStableKey);
		const nextIndex = Math.max(0, Math.min(visible.length - 1, index + delta));
		const next = visible[nextIndex] ?? null;
		if (next === this.selectedStableKey) {
			return false;
		}
		this.selectedStableKey = next;
		return true;
	}

	/** Applies parent-or-collapse behavior to the selected node. */
	public moveLeft(): boolean {
		const selected = this.getSelectedNode();
		if (selected === undefined) {
			return false;
		}
		if (
			this.hasChildren(selected.stableKey) &&
			this.expanded.has(selected.stableKey)
		) {
			this.expanded.delete(selected.stableKey);
			return true;
		}
		if (selected.parentStableKey === null) {
			return false;
		}
		this.selectedStableKey = selected.parentStableKey;
		return true;
	}

	/** Applies child-or-expand behavior to the selected node. */
	public moveRight(): boolean {
		const selected = this.getSelectedNode();
		if (selected === undefined || !this.hasChildren(selected.stableKey)) {
			return false;
		}
		if (!this.expanded.has(selected.stableKey)) {
			this.expanded.add(selected.stableKey);
			return true;
		}
		const firstChild = this.childrenByParent.get(selected.stableKey)?.[0];
		if (firstChild === undefined) {
			return false;
		}
		this.selectedStableKey = firstChild.stableKey;
		return true;
	}

	/** Ensures the selected two-row node remains inside the viewport. */
	public ensureSelectionVisible(height: number): void {
		const selected = this.selectedStableKey;
		if (selected === null || height <= 0) {
			this.scrollTop = 0;
			return;
		}
		const index = this.getVisibleStableKeys().indexOf(selected);
		if (index < 0) {
			return;
		}
		const nodeTop = index * NODE_ROW_COUNT;
		const nodeBottom = nodeTop + NODE_ROW_COUNT - 1;
		if (nodeTop < this.scrollTop) {
			this.scrollTop = nodeTop;
		} else if (nodeBottom >= this.scrollTop + height) {
			this.scrollTop = nodeBottom - height + 1;
		}
		this.clampScrollTop(height);
	}

	/** Renders the visible hierarchy rows within the pane budget. */
	public render(
		width: number,
		height: number,
		theme: Theme,
		_focused = false,
	): string[] {
		if (width <= 0 || height <= 0) {
			return [];
		}
		this.ensureSelectionVisible(height);
		this.lastHeight = height;
		const rows = this.nodes
			.filter((node) => this.isVisible(node))
			.flatMap((node) => this.renderNode(node, width, theme, _focused));
		this.lastTotalRows = rows.length;
		return rows.slice(this.scrollTop, this.scrollTop + height);
	}

	/** Exposes the last rendered viewport for border-only scroll presentation. */
	public getScrollMetrics(): ScrollMetrics {
		return {
			offset: this.scrollTop,
			total: this.lastTotalRows,
			viewport: this.lastHeight,
		};
	}

	/** Captures runtime-local hierarchy state for a later overlay instance. */
	public snapshot(): HierarchyRetainedState {
		return {
			expandedStableKeys: [...this.expanded],
			selectedStableKey: this.selectedStableKey,
			scrollTop: this.scrollTop,
		};
	}

	/** Renders one primary identity row and one compact clipped task row. */
	private renderNode(
		node: ProjectionNode,
		width: number,
		theme: Theme,
		focused: boolean,
	): readonly [string, string] {
		const branchMarker = this.branchMarker(node);
		const status = statusPresentation(node.state);
		const suffix = ` #${node.key.ownerLocalSessionId}`;
		// Marker, status, separators, and the complete local ID are mandatory.
		// Caller ancestry and agent text divide only the columns left afterward.
		const fixedWidth = visibleWidth(
			`${branchMarker} ${status.symbol} ${suffix}`,
		);
		const identityWidth = Math.max(0, width - fixedWidth);
		const callerMinimum = node.parentStableKey === null ? 0 : 1;
		const preferredAgentWidth = Math.min(
			PREFERRED_AGENT_IDENTITY_WIDTH,
			Math.max(0, identityWidth - callerMinimum),
		);
		const prefixes = this.treePrefixesForWidth(
			node,
			Math.max(0, identityWidth - preferredAgentWidth),
		);
		const connector = prefixes.identity;
		const agentWidth = Math.max(0, identityWidth - visibleWidth(connector));
		const agent = clipPlainSegment(
			normalizeTerminalDisplayText(node.agentId),
			agentWidth,
		);
		const beforeStatus = `${connector}${branchMarker} `;
		const afterStatus = ` ${agent}${suffix}`;
		const primaryPlain = `${beforeStatus}${status.symbol}${afterStatus}`;
		const primaryPadding = " ".repeat(
			Math.max(0, width - visibleWidth(primaryPlain)),
		);
		// Plain segments are bounded before foreground styling, so no truncation
		// reset can terminate an enclosing selected background.
		const primary = `${beforeStatus}${theme.fg(status.color, status.symbol)} ${theme.fg("accent", agent)}${suffix}${primaryPadding}`;
		const taskPrefix = this.taskPrefixForWidth(
			node,
			prefixes.continuation,
			width,
		);
		const taskWidth = Math.max(0, width - visibleWidth(taskPrefix));
		const taskText = clipPlainSegment(
			normalizeTerminalDisplayText(node.taskName),
			taskWidth,
		);
		const task = `${taskPrefix}${theme.fg("muted", taskText)}${" ".repeat(
			Math.max(0, taskWidth - visibleWidth(taskText)),
		)}`;
		if (node.stableKey !== this.selectedStableKey) {
			return [primary, task];
		}
		const background = focused ? "selectedBg" : "toolPendingBg";
		return [theme.bg(background, primary), theme.bg(background, task)];
	}

	/** Returns whether every ancestor branch currently exposes this node. */
	private isVisible(node: ProjectionNode): boolean {
		let parentKey = node.parentStableKey;
		const visited = new Set<string>();
		while (parentKey !== null) {
			if (visited.has(parentKey) || !this.expanded.has(parentKey)) {
				return false;
			}
			visited.add(parentKey);
			parentKey = this.nodesByKey.get(parentKey)?.parentStableKey ?? null;
		}
		return true;
	}

	/** Builds identity and task guides from the same ancestor structure. */
	private treePrefixesForWidth(
		node: ProjectionNode,
		maxWidth: number,
	): TreePrefixes {
		if (node.parentStableKey === null || maxWidth <= 0) {
			return { identity: "", continuation: "" };
		}
		const guideKeys = this.ancestorKeys(node).slice(1);
		const ancestorGuides = guideKeys
			.map((key) => (this.hasLaterSibling(key) ? "│  " : "   "))
			.join("");
		const hasLaterSibling = this.hasLaterSibling(node.stableKey);
		const identity = `${ancestorGuides}${hasLaterSibling ? "├─ " : "└─ "}`;
		const continuation = `${ancestorGuides}${hasLaterSibling ? "│  " : "   "}`;
		if (visibleWidth(identity) <= maxWidth) {
			return { identity, continuation };
		}
		const edge = hasLaterSibling ? "├" : "└";
		const depth = this.ancestorKeys(node).length;
		for (const candidate of [
			`…${depth}${edge} `,
			`…${edge} `,
			`${edge} `,
			edge,
		]) {
			if (visibleWidth(candidate) <= maxWidth) {
				const width = visibleWidth(candidate);
				const continues =
					hasLaterSibling || guideKeys.some((key) => this.hasLaterSibling(key));
				return {
					identity: candidate,
					continuation: `${continues ? "│" : " "}${" ".repeat(
						Math.max(0, width - 1),
					)}`,
				};
			}
		}
		return { identity: "", continuation: "" };
	}

	/** Preserves caller meaning while reserving useful task text at narrow widths. */
	private taskPrefixForWidth(
		node: ProjectionNode,
		continuation: string,
		width: number,
	): string {
		const taskWidth = Math.min(PREFERRED_TASK_TEXT_WIDTH, width);
		const availablePrefixWidth = Math.max(0, width - taskWidth);
		const identityColumn =
			visibleWidth(continuation) + TREE_CONNECTOR_WIDTH + 1;
		const prefixWidth = Math.min(identityColumn, availablePrefixWidth);
		const descendantGuide =
			this.expanded.has(node.stableKey) && this.hasChildren(node.stableKey)
				? "│"
				: " ";
		const guide = `${continuation}${descendantGuide}${" ".repeat(
			TREE_CONNECTOR_WIDTH,
		)}`;
		return padToWidth(sliceByColumn(guide, 0, prefixWidth), prefixWidth);
	}

	/** Returns root-to-parent stable keys for connector calculation. */
	private ancestorKeys(node: ProjectionNode): readonly string[] {
		const keys: string[] = [];
		let parentKey = node.parentStableKey;
		const visited = new Set<string>();
		while (parentKey !== null && !visited.has(parentKey)) {
			visited.add(parentKey);
			keys.unshift(parentKey);
			parentKey = this.nodesByKey.get(parentKey)?.parentStableKey ?? null;
		}
		return keys;
	}

	/** Returns whether a node has a later creation-order sibling. */
	private hasLaterSibling(stableKey: string): boolean {
		const node = this.nodesByKey.get(stableKey);
		if (node === undefined) {
			return false;
		}
		const siblings = this.childrenByParent.get(node.parentStableKey) ?? [];
		return siblings.at(-1)?.stableKey !== stableKey;
	}

	/** Returns the branch marker that matches local expansion state. */
	private branchMarker(node: ProjectionNode): string {
		if (!this.hasChildren(node.stableKey)) {
			return " ";
		}
		return this.expanded.has(node.stableKey) ? "▼" : "▶";
	}

	/** Returns whether one logical session owns projected descendants. */
	private hasChildren(stableKey: string): boolean {
		return (this.childrenByParent.get(stableKey)?.length ?? 0) > 0;
	}

	/** Resolves the current selection without exposing routing identity. */
	private getSelectedNode(): ProjectionNode | undefined {
		return this.selectedStableKey === null
			? undefined
			: this.nodesByKey.get(this.selectedStableKey);
	}

	/** A retained deep selection remains reachable after a reopen. */
	private ensureSelectedAncestorsExpanded(): void {
		const selected = this.getSelectedNode();
		if (selected === undefined) {
			return;
		}
		for (const key of this.ancestorKeys(selected)) {
			this.expanded.add(key);
		}
	}

	/** Keeps the hierarchy viewport within the complete visible row range. */
	private clampScrollTop(height = 1): void {
		const rowCount = this.getVisibleStableKeys().length * NODE_ROW_COUNT;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, rowCount - height));
	}
}

/** Renders the compact outer-border title for the current hierarchy counts. */
export function renderHierarchyTitle(
	nodes: readonly ProjectionNode[],
	width: number,
	theme: Theme,
	focused = false,
): string {
	const counts = countAgentStatuses(nodes);
	const label = theme.bold("Agents");
	const focusedLabel = focused ? theme.fg("borderAccent", label) : label;
	const parts = [
		`${focusedLabel}: ${theme.fg("accent", AGENT_STATUS_ICONS.running)} ${counts.running}`,
		`${theme.fg("success", "✓")} ${counts.done}`,
		`${theme.fg("error", "✗")} ${counts.failed}`,
		`${theme.fg("warning", "■")} ${counts.aborted}`,
	];
	return truncateToWidth(parts.join(" · "), width, "…");
}

/** Renders the selected ancestor chain and available session metadata. */
export function renderSelectedSessionHeader(
	options: SelectedSessionHeaderOptions,
): readonly string[] {
	const nodesByKey = new Map(
		options.nodes.map((node) => [node.stableKey, node]),
	);
	const selected =
		options.selectedStableKey === null
			? undefined
			: nodesByKey.get(options.selectedStableKey);
	if (selected === undefined || options.width <= 0) {
		return [];
	}
	const chainNodes = selectedChain(selected, nodesByKey);
	const identities = chainNodes.map((node) => identityFor(node, options.width));
	const chain = renderSelectedChain(
		clipAncestorChain(identities, options.width),
		options.theme,
		options.focused === true,
	);
	const prompt = renderSelectedPrompt(
		selected,
		options.initialPrompt,
		options.width,
		options.theme,
	);
	const metadata = renderSelectedMetadata(
		options.metadata ?? {},
		options.width,
		options.theme,
	);
	return [chain, prompt, metadata];
}

/** Renders one status icon and the normalized initial prompt without wrapping. */
function renderSelectedPrompt(
	selected: ProjectionNode,
	initialPrompt: string | undefined,
	width: number,
	theme: Theme,
): string {
	const status = statusPresentation(selected.state);
	if (width <= 0) {
		return "";
	}
	const styledStatus = theme.fg(status.color, status.symbol);
	const prompt = normalizeTerminalDisplayText(initialPrompt ?? "");
	if (prompt.length === 0 || width <= visibleWidth(status.symbol)) {
		return styledStatus;
	}
	const separator = " ";
	const promptWidth = Math.max(
		0,
		width - visibleWidth(status.symbol) - visibleWidth(separator),
	);
	const data = `${separator}${truncateToWidth(prompt, promptWidth, "…")}`;
	return `${styledStatus}${theme.fg("muted", data)}`;
}

/** Renders elapsed time, model configuration, and context as one bounded row. */
function renderSelectedMetadata(
	metadata: SelectedSessionMetadata,
	width: number,
	theme: Theme,
): string {
	const elapsed =
		metadata.elapsedMs === undefined
			? undefined
			: theme.fg("muted", formatDuration(metadata.elapsedMs));
	const model =
		metadata.modelId === undefined
			? undefined
			: theme.fg(
					"muted",
					`${metadata.modelId}${metadata.thinking === undefined ? "" : `/${metadata.thinking}`}`,
				);
	const context = renderContext(metadata, theme, { normalColor: "muted" });
	return truncateToWidth(
		[elapsed, model, context]
			.filter((field): field is string => field !== undefined)
			.join(theme.fg("muted", SELECTED_DETAIL_SEPARATOR)),
		width,
		"…",
	);
}

/** Groups siblings in the projection's creation order. */
function groupChildren(
	nodes: readonly ProjectionNode[],
): Map<string | null, readonly ProjectionNode[]> {
	const mutable = new Map<string | null, ProjectionNode[]>();
	for (const node of nodes) {
		const siblings = mutable.get(node.parentStableKey) ?? [];
		siblings.push(node);
		mutable.set(node.parentStableKey, siblings);
	}
	return new Map(mutable);
}

/** Maps invocation state to the approved visible status vocabulary. */
function statusPresentation(state: ProjectionNode["state"]): {
	readonly symbol: string;
	readonly label: string;
	readonly color: "accent" | "success" | "error" | "warning";
} {
	switch (state) {
		case "starting":
		case "active":
			return {
				symbol: AGENT_STATUS_ICONS.running,
				label: "running",
				color: "accent",
			};
		case "terminal-success":
			return {
				symbol: AGENT_STATUS_ICONS.done,
				label: "completed",
				color: "success",
			};
		case "terminal-failure":
			return {
				symbol: AGENT_STATUS_ICONS.failed,
				label: "failed",
				color: "error",
			};
		case "terminal-aborted":
			return {
				symbol: AGENT_STATUS_ICONS.aborted,
				label: "aborted",
				color: "warning",
			};
	}
}

/** Counts only non-zero status groups for the compact border title. */
/** Returns one complete root-to-selected logical identity chain. */
function selectedChain(
	selected: ProjectionNode,
	nodesByKey: ReadonlyMap<string, ProjectionNode>,
): readonly ProjectionNode[] {
	const chain = [selected];
	let parentKey = selected.parentStableKey;
	const visited = new Set<string>();
	while (parentKey !== null && !visited.has(parentKey)) {
		visited.add(parentKey);
		const parent = nodesByKey.get(parentKey);
		if (parent === undefined) {
			break;
		}
		chain.unshift(parent);
		parentKey = parent.parentStableKey;
	}
	return chain;
}

/** Preserves the selected local ID when one agent identity exceeds the row width. */
function identityFor(node: ProjectionNode, width: number): string {
	const suffix = ` #${node.key.ownerLocalSessionId}`;
	const agent = clipPlainSegment(
		normalizeTerminalDisplayText(node.agentId),
		Math.max(0, width - visibleWidth(suffix)),
	);
	return `${agent}${suffix}`;
}

/** Removes oldest ancestors until the selected identity fits at the right edge. */
function clipAncestorChain(
	identities: readonly string[],
	width: number,
): string {
	let visible = [...identities];
	let clipped = false;
	while (visible.length > 1) {
		const prefix = clipped ? "… › " : "";
		const candidate = `${prefix}${visible.join(" › ")}`;
		if (visibleWidth(candidate) <= width) {
			return candidate;
		}
		visible = visible.slice(1);
		clipped = true;
	}
	const prefix = clipped ? "… › " : "";
	return truncateLeftToWidth(`${prefix}${visible[0] ?? ""}`, width);
}

/** Colors agent identities while keeping ancestry separators secondary. */
function renderSelectedChain(
	chain: string,
	theme: Theme,
	focused: boolean,
): string {
	if (focused) {
		return theme.fg("borderAccent", chain);
	}
	return chain
		.split(" › ")
		.map((identity) => {
			const suffixStart = identity.lastIndexOf(" #");
			if (suffixStart <= 0) {
				return identity;
			}
			return `${theme.fg("accent", identity.slice(0, suffixStart))}${identity.slice(suffixStart)}`;
		})
		.join(theme.fg("muted", " › "));
}

/** Clips the oldest visible columns so the selected identity suffix remains visible. */
function truncateLeftToWidth(text: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const textWidth = visibleWidth(text);
	if (textWidth <= width) {
		return text;
	}
	const ellipsis = "…";
	const tailWidth = Math.max(0, width - visibleWidth(ellipsis));
	return `${ellipsis}${sliceByColumn(text, textWidth - tailWidth, tailWidth, true)}`;
}

/** Clips one unstyled segment with Pi's grapheme-aware column slicing and no SGR reset. */
function clipPlainSegment(value: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(value) <= maxWidth) {
		return value;
	}
	const ellipsis = "…";
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const identityFragment = sliceByColumn(value, 0, maxWidth, true);
		return visibleWidth(identityFragment) > 0
			? identityFragment
			: sliceByColumn(ellipsis, 0, maxWidth, true);
	}
	return `${sliceByColumn(value, 0, maxWidth - ellipsisWidth, true)}${ellipsis}`;
}

/** Pads a selected row so its emphasis spans the complete visible pane width. */
function padToWidth(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}
