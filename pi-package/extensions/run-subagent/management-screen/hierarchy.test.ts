import { describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ProjectionNode } from "../projection";
import {
	HierarchyPane,
	renderHierarchyTitle,
	renderSelectedSessionHeader,
} from "./hierarchy";

/** Provides deterministic marker-free theme behavior for hierarchy assertions. */
const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

/** Marks foreground spans so icons and numeric counts can be distinguished. */
const MARKED_THEME = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

/** Splits returned strings into physical terminal rows. */
const PHYSICAL_ROW_BREAK = /\r\n|[\n\r]/;
/** Recognizes one visible child junction at the start of an identity row. */
const CHILD_BRANCH_PREFIX = /^[├└]─/;

/** Uses Pi's public theme implementation so SGR reset behavior remains observable. */
const ANSI_THEME = new Theme(
	{
		success: 2,
		error: 1,
		warning: 3,
		thinkingXhigh: 5,
		muted: 8,
		accent: 6,
	} as ConstructorParameters<typeof Theme>[0],
	{ selectedBg: 4, toolPendingBg: 0 } as ConstructorParameters<typeof Theme>[1],
	"256color",
);

/** Creates one projected hierarchy node with complete stable identity. */
function node(
	stableKey: string,
	ownerPiSessionId: string,
	ownerLocalSessionId: number,
	parentStableKey: string | null,
	agentId: string,
	creationOrder: number,
	state: ProjectionNode["state"] = "active",
): ProjectionNode {
	return {
		stableKey,
		key: { ownerPiSessionId, ownerLocalSessionId },
		parentStableKey,
		childPiSessionId: `child-${stableKey}`,
		agentId,
		taskName: `Inspect the long task owned by ${agentId}`,
		creationOrder,
		state,
	};
}

/** Creates a repeated-ID hierarchy whose depth exercises caller connectors. */
function hierarchy(): readonly ProjectionNode[] {
	return [
		node("root-a", "root-owner", 1, null, "SubAgentAnalyst", 1),
		node("child-a", "child-root-a", 1, "root-a", "SubAgentExtractor", 1),
		node("grandchild-a", "child-child-a", 1, "child-a", "SubAgentCritic", 1),
		node("sibling-a", "child-root-a", 2, "root-a", "SubAgentReviewer", 2),
		node("root-b", "root-owner", 2, null, "SubAgentDeveloper", 2),
	];
}

/** Creates one ten-level caller chain whose local ID repeats at every depth. */
function deepRepeatedIdHierarchy(): readonly ProjectionNode[] {
	const nodes: ProjectionNode[] = [];
	for (let depth = 0; depth < 10; depth += 1) {
		const stableKey = `depth-${depth}`;
		nodes.push(
			node(
				stableKey,
				depth === 0 ? "root-owner" : `child-depth-${depth - 1}`,
				1,
				depth === 0 ? null : `depth-${depth - 1}`,
				`Agent${String(depth).padStart(2, "0")}LongIdentity`,
				1,
			),
		);
	}
	return nodes;
}

describe("management hierarchy", () => {
	test("keeps hierarchy selection stable across status updates", () => {
		// Purpose: a live status update must replace one stable-keyed row without reordering siblings or moving selection.
		// Inputs and expected output: repeated owner-local IDs at three depths remain in caller creation order while the selected grandchild changes from active to successful.
		// Edge case: every rendered primary and clipped task row must fit the 24-column minimum.
		// Dependencies: immutable ProjectionNode values and public Pi width utilities.
		// ARRANGE: select the deepest repeated local ID while every branch is expanded.
		const initial = hierarchy();
		const pane = new HierarchyPane(initial, {
			expandedStableKeys: ["root-a", "child-a"],
			selectedStableKey: "grandchild-a",
			scrollTop: 0,
		});
		const orderBefore = pane.getVisibleStableKeys();

		// ACT: update only the selected node's terminal status.
		const updated = initial.map((item) =>
			item.stableKey === "grandchild-a"
				? { ...item, state: "terminal-success" as const }
				: item,
		);
		pane.update(updated);
		const lines = pane.render(24, 10, THEME);

		// ASSERT: stable identity, creation order, connectors, local IDs, and width remain unchanged.
		expect({
			selected: pane.getSelectedStableKey(),
			order: pane.getVisibleStableKeys(),
			orderBefore,
			allRowsFit: lines.every((line) => visibleWidth(line) <= 24),
			showsCompletedSelected: lines.some(
				(line) => line.includes("✓") && line.includes("#1"),
			),
			showsCallerConnector: lines.some((line) => line.includes("├─")),
		}).toEqual({
			selected: "grandchild-a",
			order: ["root-a", "child-a", "grandchild-a", "sibling-a", "root-b"],
			orderBefore: ["root-a", "child-a", "grandchild-a", "sibling-a", "root-b"],
			allRowsFit: true,
			showsCompletedSelected: true,
			showsCallerConnector: true,
		});
	});

	test("keeps tree connectors on identity rows and aligns task rows", () => {
		// Purpose: hierarchy edges must identify nodes without appearing beside their secondary task text.
		// Inputs and expected output: every visible identity row owns its connector, while the following task starts under the agent identity.
		// Edge case: nested nodes and later siblings may use different primary connectors but no task row repeats a junction.
		// Dependencies: two-row node layout and projected parent/sibling relationships.
		const nodes = hierarchy();
		const pane = new HierarchyPane(nodes, {
			expandedStableKeys: ["root-a", "child-a"],
			selectedStableKey: "root-a",
			scrollTop: 0,
		});

		const lines = pane.render(80, 10, THEME);
		const visibleNodes = pane
			.getVisibleStableKeys()
			.map((key) => nodes.find((item) => item.stableKey === key));
		const rowPairs = visibleNodes.map((visibleNode, index) => {
			if (visibleNode === undefined) {
				throw new Error("visible hierarchy key has no projected node");
			}
			const primary = lines[index * 2] ?? "";
			const task = lines[index * 2 + 1] ?? "";
			return {
				junctionOnTask: task.includes("├") || task.includes("└"),
				aligned:
					primary.indexOf(visibleNode.agentId) === task.indexOf("Inspect"),
			};
		});

		expect({
			rowPairs,
			parentDescent:
				(lines[1]?.startsWith("│") ?? false) &&
				CHILD_BRANCH_PREFIX.test(lines[2] ?? ""),
		}).toEqual({
			rowPairs: visibleNodes.map(() => ({
				junctionOnTask: false,
				aligned: true,
			})),
			parentDescent: true,
		});
	});

	test("keeps structural guide columns continuous across sibling subtrees", () => {
		// Purpose: every physical row must derive guides from the same ancestor and sibling structure.
		// Inputs and expected output: two expanded sibling branches keep the first sibling guide continuous through its leaf rows.
		// Edge case: the last sibling and its leaf must not inherit a continuation line.
		// Dependencies: two-row nodes, branch disclosure, and ordered parent edges.
		const nodes = [
			{
				...node("root", "owner", 1, null, "Root", 1, "terminal-success"),
				taskName: "root task",
			},
			{
				...node(
					"child-a",
					"child-root",
					1,
					"root",
					"ChildA",
					1,
					"terminal-success",
				),
				taskName: "child a task",
			},
			{
				...node(
					"leaf-a",
					"child-a",
					1,
					"child-a",
					"LeafA",
					1,
					"terminal-success",
				),
				taskName: "leaf a task",
			},
			{
				...node(
					"child-b",
					"child-root",
					2,
					"root",
					"ChildB",
					2,
					"terminal-success",
				),
				taskName: "child b task",
			},
			{
				...node(
					"leaf-b",
					"child-b",
					1,
					"child-b",
					"LeafB",
					1,
					"terminal-success",
				),
				taskName: "leaf b task",
			},
		];
		const pane = new HierarchyPane(nodes, {
			expandedStableKeys: ["root", "child-a", "child-b"],
			selectedStableKey: "root",
			scrollTop: 0,
		});

		expect(pane.render(80, 10, THEME).map((line) => line.trimEnd())).toEqual([
			"▼ ✓ Root #1",
			"│   root task",
			"├─ ▼ ✓ ChildA #1",
			"│  │   child a task",
			"│  └─   ✓ LeafA #1",
			"│         leaf a task",
			"└─ ▼ ✓ ChildB #2",
			"   │   child b task",
			"   └─   ✓ LeafB #1",
			"          leaf b task",
		]);
	});

	test("reaches arbitrary descendants through collapse and tree navigation", () => {
		// Purpose: branch navigation must keep every configured-depth descendant reachable without flattening owner-local IDs.
		// Inputs and expected output: right expands or enters a child, left selects its parent or collapses it, and collapsed descendants leave the visible order.
		// Edge case: a selected collapsed branch uses the parent action only after its descendants are hidden.
		// Dependencies: stable parent keys supplied by the projection.
		// ARRANGE: start with only the root branch expanded and the root selected.
		const pane = new HierarchyPane(hierarchy(), {
			expandedStableKeys: [],
			selectedStableKey: "root-a",
			scrollTop: 0,
		});

		// ACT: expand root, enter child, expand child, and enter the grandchild.
		const actions = [
			pane.moveRight(),
			pane.moveRight(),
			pane.moveRight(),
			pane.moveRight(),
		];
		const deepest = pane.getSelectedStableKey();
		pane.moveLeft();
		const parent = pane.getSelectedStableKey();
		pane.moveLeft();

		// ASSERT: navigation follows direct caller edges and collapse removes only descendants.
		expect({
			actions,
			deepest,
			parent,
			visible: pane.getVisibleStableKeys(),
		}).toEqual({
			actions: [true, true, true, true],
			deepest: "grandchild-a",
			parent: "child-a",
			visible: ["root-a", "child-a", "sibling-a", "root-b"],
		});
	});

	test("starts with every branch collapsed when retained state is empty", () => {
		// Purpose: opening management must show only root agents until the user expands a branch.
		// Inputs and expected output: an explicit empty retained state keeps expansion empty and hides descendants.
		// Edge case: selecting the first visible root must not expand that root automatically.
		// Dependencies: retained hierarchy state and visible-order projection.
		const pane = new HierarchyPane(hierarchy(), {
			expandedStableKeys: [],
			selectedStableKey: null,
			scrollTop: 0,
		});

		expect({
			expanded: pane.snapshot().expandedStableKeys,
			visible: pane.getVisibleStableKeys(),
			selected: pane.getSelectedStableKey(),
		}).toEqual({
			expanded: [],
			visible: ["root-a", "root-b"],
			selected: "root-a",
		});
	});

	test("moves selection only within the visible creation order", () => {
		// Purpose: hierarchy up/down navigation must follow visible rows without wrapping at either boundary.
		// Inputs and expected output: down enters the first creation-order child, up returns to root, and another up no-ops.
		// Edge case: collapsed descendants do not participate in the visible navigation order.
		// Dependencies: projection DFS order and retained branch expansion.
		// ARRANGE: expose only the first root's direct children.
		const pane = new HierarchyPane(hierarchy(), {
			expandedStableKeys: ["root-a"],
			selectedStableKey: "root-a",
			scrollTop: 0,
		});

		// ACT: move down once, up once, and attempt to move before the first row.
		const down = pane.moveSelection(1);
		const child = pane.getSelectedStableKey();
		const up = pane.moveSelection(-1);
		const root = pane.getSelectedStableKey();
		const beforeStart = pane.moveSelection(-1);

		// ASSERT: movement is stable, bounded, and limited to visible nodes.
		expect({ down, child, up, root, beforeStart }).toEqual({
			down: true,
			child: "child-a",
			up: true,
			root: "root-a",
			beforeStart: false,
		});
	});

	test("retains deep identity and caller cues at the 24-column minimum", () => {
		// Purpose: mandatory navigation and identity columns must survive arbitrary supported depth before agent text receives width.
		// Inputs and expected output: every row in a ten-level repeated-#1 chain keeps caller meaning, status, applicable branch marker, agent distinction, and the complete local ID at 24 columns.
		// Edge case: collapsing and reopening the ninth-level parent preserves creation order and stable deep selection.
		// Dependencies: public Pi visible-width accounting and projection parent keys.
		// ARRANGE: expand every parent and select the deepest repeated local ID.
		const nodes = deepRepeatedIdHierarchy();
		const stableOrder = nodes.map((item) => item.stableKey);
		const pane = new HierarchyPane(nodes, {
			expandedStableKeys: stableOrder.slice(0, -1),
			selectedStableKey: stableOrder.at(-1) ?? null,
			scrollTop: 0,
		});

		// ACT: render every two-row node, then collapse and reopen the selected parent branch.
		const lines = pane.render(24, 20, THEME);
		const primaryRows = lines.filter((_line, index) => index % 2 === 0);
		const deepSibling = node(
			"depth-9-sibling",
			"child-depth-8",
			1,
			"depth-8",
			"SiblingLongIdentity",
			2,
		);
		const siblingPane = new HierarchyPane([...nodes, deepSibling], {
			expandedStableKeys: stableOrder.slice(0, -1),
			selectedStableKey: "depth-9",
			scrollTop: 0,
		});
		const siblingPrimaryRows = siblingPane
			.render(24, 22, THEME)
			.filter((_line, index) => index % 2 === 0)
			.slice(-2);
		const maximumIdNodes = nodes.map((item) =>
			item.stableKey === "depth-9"
				? {
						...item,
						key: {
							...item.key,
							ownerLocalSessionId: Number.MAX_SAFE_INTEGER,
						},
						agentId: "ZMaximumIdentity",
					}
				: item,
		);
		const maximumIdPane = new HierarchyPane(maximumIdNodes, {
			expandedStableKeys: stableOrder.slice(0, -1),
			selectedStableKey: "depth-9",
			scrollTop: 0,
		});
		const maximumIdPrimary = maximumIdPane.render(24, 2, THEME)[0] ?? "";
		const selectionBefore = pane.getSelectedStableKey();
		const toParent = pane.moveLeft();
		const collapseParent = pane.moveLeft();
		const collapsedOrder = pane.getVisibleStableKeys();
		const collapsedParentRow = pane.render(24, 18, THEME).at(-2) ?? "";
		const reopenParent = pane.moveRight();
		const toChild = pane.moveRight();

		// ASSERT: reserved columns remain complete on every depth and navigation state remains stable.
		expect({
			rowCount: primaryRows.length,
			allRowsFit: lines.every((line) => visibleWidth(line) <= 24),
			allStatuses: primaryRows.every((line) => line.includes("⧗")),
			allLocalIds: primaryRows.every((line) => line.includes("#1")),
			allCallerEdges: primaryRows.slice(1).every((line) => line.includes("└")),
			allAgentsDistinct: primaryRows.every((line, depth) =>
				line.includes(`Agent${String(depth).padStart(2, "0")}`),
			),
			allBranchMarkers: primaryRows
				.slice(0, -1)
				.every((line) => line.includes("▼")),
			deepSiblingEdges:
				siblingPrimaryRows[0]?.includes("├") === true &&
				siblingPrimaryRows[1]?.includes("└") === true,
			maximumIdReserved:
				maximumIdPrimary.includes("└") &&
				maximumIdPrimary.includes("⧗") &&
				maximumIdPrimary.includes("Z") &&
				maximumIdPrimary.includes(`#${Number.MAX_SAFE_INTEGER}`),
			leafHasNoBranchMarker:
				!primaryRows.at(-1)?.includes("▼") &&
				!primaryRows.at(-1)?.includes("▶"),
			selectionBefore,
			toParent,
			collapseParent,
			collapsedOrder,
			collapsedParentMarker:
				collapsedParentRow.includes("▶") && collapsedParentRow.includes("⧗"),
			reopenParent,
			toChild,
			selectionAfter: pane.getSelectedStableKey(),
		}).toEqual({
			rowCount: 10,
			allRowsFit: true,
			allStatuses: true,
			allLocalIds: true,
			allCallerEdges: true,
			allAgentsDistinct: true,
			allBranchMarkers: true,
			deepSiblingEdges: true,
			maximumIdReserved: true,
			leafHasNoBranchMarker: true,
			selectionBefore: "depth-9",
			toParent: true,
			collapseParent: true,
			collapsedOrder: stableOrder.slice(0, -1),
			collapsedParentMarker: true,
			reopenParent: true,
			toChild: true,
			selectionAfter: "depth-9",
		});
	});

	test("keeps selected background active through clipped and padded rows", () => {
		// Purpose: selected-row emphasis must cover every visible column after plain content clipping.
		// Inputs and expected output: Pi's real ANSI theme wraps clipped identity and task rows with a sole final background reset.
		// Edge case: status foreground reset remains allowed because it does not terminate the selected background.
		// Dependencies: public Pi Theme, visible-width accounting, and minimum-width hierarchy rendering.
		// ARRANGE: select a middle branch whose long identity and wide task both fill the minimum width after clipping.
		const parent = node("ansi-parent", "root-owner", 1, null, "Parent", 1);
		const selected = {
			...node(
				"ansi-selected",
				"child-ansi-parent",
				12_345,
				"ansi-parent",
				"AgentIdentityThatMustClipAtMinimumWidth",
				1,
			),
			taskName: `界界\u001b[0m界\u001b[49m${"界".repeat(17)}`,
		};
		const child = node(
			"ansi-child",
			"child-ansi-selected",
			1,
			"ansi-selected",
			"Child",
			1,
		);
		const pane = new HierarchyPane([parent, selected, child], {
			expandedStableKeys: ["ansi-parent", "ansi-selected"],
			selectedStableKey: "ansi-selected",
			scrollTop: 0,
		});

		// ACT: render the selected primary and task rows through the real ANSI theme.
		const rows = pane.render(24, 2, ANSI_THEME, true);
		const selectedBackground = ANSI_THEME.getBgAnsi("selectedBg");
		const backgroundReset = "\u001b[49m";

		// ASSERT: clipping adds no global reset and the only background reset follows all 24 columns.
		expect({
			rowCount: rows.length,
			allRowsFit: rows.every((line) => visibleWidth(line) === 24),
			allRowsStartSelected: rows.every((line) =>
				line.startsWith(selectedBackground),
			),
			allRowsEndSelected: rows.every((line) => line.endsWith(backgroundReset)),
			noGlobalReset: rows.every((line) => !line.includes("\u001b[0m")),
			noEarlyBackgroundReset: rows.every(
				(line) =>
					!line.slice(0, -backgroundReset.length).includes(backgroundReset),
			),
			primaryIdentity:
				rows[0]?.includes("▼") === true &&
				rows[0]?.includes("⧗") === true &&
				rows[0]?.includes("#12345") === true,
			taskClippedAndFilled:
				rows[1]?.includes("…") === true && visibleWidth(rows[1] ?? "") === 24,
		}).toEqual({
			rowCount: 2,
			allRowsFit: true,
			allRowsStartSelected: true,
			allRowsEndSelected: true,
			noGlobalReset: true,
			noEarlyBackgroundReset: true,
			primaryIdentity: true,
			taskClippedAndFilled: true,
		});
	});

	test("changes selected background when hierarchy focus changes", () => {
		// Purpose: the selected agent must remain visible while its background shows whether keyboard focus belongs to the hierarchy.
		// Inputs and expected output: focused rendering uses selectedBg and unfocused rendering uses toolPendingBg on both node rows.
		// Edge case: the same selected identity is retained across the focus-only render change.
		// Dependencies: real ANSI theme backgrounds and hierarchy-local selection state.
		const selected = node("focus-row", "root-owner", 1, null, "Agent", 1);
		const pane = new HierarchyPane([selected], {
			expandedStableKeys: [],
			selectedStableKey: selected.stableKey,
			scrollTop: 0,
		});

		const focused = pane.render(24, 2, ANSI_THEME, true);
		const unfocused = pane.render(24, 2, ANSI_THEME, false);
		const selectedBackground = ANSI_THEME.getBgAnsi("selectedBg");
		const mutedBackground = ANSI_THEME.getBgAnsi("toolPendingBg");

		expect({
			focused: focused.every((line) => line.startsWith(selectedBackground)),
			unfocused: unfocused.every((line) => line.startsWith(mutedBackground)),
		}).toEqual({ focused: true, unfocused: true });
	});

	test("always includes all four status counts without total", () => {
		// Purpose: the hierarchy title must show every lifecycle count without a redundant total.
		// Inputs and expected output: an all-aborted hierarchy shows three zero counts, the aborted count, and one aborted symbol on every node row.
		// Edge case: zero counts remain explicit rather than disappearing.
		// Dependencies: shared status aggregation for the management title and main indicator.
		// ARRANGE: terminalize every node as aborted and expand each caller branch.
		const nodes = hierarchy().map((item) => ({
			...item,
			state: "terminal-aborted" as const,
		}));
		const pane = new HierarchyPane(nodes, {
			expandedStableKeys: ["root-a", "child-a"],
			selectedStableKey: "root-a",
			scrollTop: 0,
		});

		// ACT: render the closed title contract and every visible node row.
		const title = renderHierarchyTitle(nodes, 60, THEME);
		const coloredTitle = renderHierarchyTitle(nodes, 200, MARKED_THEME);
		const primaryRows = pane
			.render(60, nodes.length * 2, THEME)
			.filter((_line, index) => index % 2 === 0);

		// ASSERT: the title reports every count while each node retains its exact status symbol.
		expect({
			title,
			coloredTitle,
			primaryRowCount: primaryRows.length,
			allNodesAborted: primaryRows.every((line) => line.includes("■")),
		}).toEqual({
			title: "Agents: ⧗ 0 · ✓ 0 · ✗ 0 · ■ 5",
			coloredTitle:
				"Agents: <accent>⧗</accent> 0 · <success>✓</success> 0 · <error>✗</error> 0 · <warning>■</warning> 5",
			primaryRowCount: 5,
			allNodesAborted: true,
		});
	});

	test("renders the selected session as three exact header rows", () => {
		// Purpose: the selected pane must separate identity, initial prompt, and invocation metadata into stable one-line rows.
		// Inputs and expected output: one active session renders status icon only, normalized initial prompt, model/thinking, and projected context.
		// Edge case: line indentation is folded into one space and cannot create physical terminal rows.
		// Dependencies: selected hierarchy identity, persisted initial user message, and invocation metadata.
		const selected = {
			...node("selected-header", "root-owner", 2, null, "SubAgentExtractor", 1),
			state: "terminal-success" as const,
		};

		const header = renderSelectedSessionHeader({
			nodes: [selected],
			selectedStableKey: selected.stableKey,
			initialPrompt: "Prompt\n    without\r\tline breaks",
			metadata: {
				elapsedMs: 9_000,
				modelId: "openai-codex/gpt-5.6-sol",
				thinking: "low",
				contextTokens: 15_100,
				contextWindow: 372_000,
				projectionSavedTokens: 10,
			},
			width: 120,
			theme: THEME,
		});

		expect(header).toEqual([
			"SubAgentExtractor #2",
			"✓ Prompt without line breaks",
			"9s · openai-codex/gpt-5.6-sol/low · ~10/15.1k/372k",
		]);
	});

	test("mutes hierarchy task and selected-session data text", () => {
		// Purpose: descriptive agent data must remain secondary to identities and lifecycle state.
		// Inputs and expected output: task, prompt, elapsed time, model, and normal context use the muted foreground.
		// Edge case: lifecycle status keeps its semantic color beside a muted prompt.
		// Dependencies: hierarchy rows and selected-session header presentation.
		const selected = {
			...node("muted-data", "root-owner", 2, null, "SubAgentExtractor", 1),
			state: "terminal-success" as const,
		};
		const pane = new HierarchyPane([selected]);
		const hierarchyRows = pane.render(100, 2, MARKED_THEME, true);
		const header = renderSelectedSessionHeader({
			nodes: [selected],
			selectedStableKey: selected.stableKey,
			initialPrompt: "Inspect selected presentation",
			metadata: {
				elapsedMs: 12_999,
				modelId: "openai/test-model",
				thinking: "low",
				contextTokens: 49,
				contextWindow: 100,
			},
			width: 120,
			theme: MARKED_THEME,
		});

		expect(hierarchyRows[0]).toContain("<accent>SubAgentExtractor</accent> #2");
		expect(hierarchyRows[1]).toContain(
			"<muted>Inspect the long task owned by SubAgentExtractor</muted>",
		);
		expect(header[0]).toBe("<accent>SubAgentExtractor</accent> #2");
		expect(header[1]).toBe(
			"<success>✓</success><muted> Inspect selected presentation</muted>",
		);
		expect(header[2]).toBe(
			"<muted>12s</muted><muted> · </muted><muted>openai/test-model/low</muted><muted> · </muted><muted>49/100</muted>",
		);
	});

	test("applies V1 context pressure thresholds to selected metadata", () => {
		// Purpose: selected context must retain the V1 warning and error thresholds.
		// Inputs and expected output: 49%, 50%, 79%, and 80% produce normal, warning, warning, and error usage colors.
		// Edge case: projected savings remain warning-colored independently of current usage.
		// Dependencies: shared context formatting and the selected-session metadata row.
		const selected = node(
			"context-pressure",
			"root-owner",
			2,
			null,
			"SubAgentExtractor",
			1,
		);
		const renderAt = (contextTokens: number) =>
			renderSelectedSessionHeader({
				nodes: [selected],
				selectedStableKey: selected.stableKey,
				initialPrompt: "Inspect context pressure",
				metadata: {
					contextTokens,
					contextWindow: 100,
					projectionSavedTokens: 10,
				},
				width: 120,
				theme: MARKED_THEME,
			})[2];

		expect([renderAt(49), renderAt(50), renderAt(79), renderAt(80)]).toEqual([
			"<warning>~10/</warning><muted>49/100</muted>",
			"<warning>~10/</warning><warning>50/100</warning>",
			"<warning>~10/</warning><warning>79/100</warning>",
			"<warning>~10/</warning><error>80/100</error>",
		]);
	});

	test("keeps terminal-safe selected fields at the 40-column minimum", () => {
		// Purpose: supported control input must not create physical rows or hide any available minimum-width header field.
		// Inputs and expected output: normalized agent/task text and complete production-shaped metadata remain recognizable at width 40.
		// Edge case: newline, carriage return, tab, C0/C1 controls, and input VT sequences are removed before allocation.
		// Dependencies: shared terminal-display normalization and public Pi width utilities.
		// ARRANGE: select one node whose identity and task contain every supported control class.
		const inputControls = [
			"\n",
			"\r",
			"\t",
			"\u0001",
			"\u0085",
			"\u001b[38;5;201m",
		];
		const selected = {
			...node("controlled", "root-owner", 1, null, "Agent", 1),
			agentId: "Agent\nSafe\r\t\u0001\u0085\u001b[38;5;201mID\u001b[0m",
			taskName: "Task\nSafe\r\t\u0001\u0085\u001b[38;5;201mBody\u001b[0m",
		};

		// ACT: render the exact approved selected-pane minimum with every metadata field available.
		const header = renderSelectedSessionHeader({
			nodes: [selected],
			selectedStableKey: selected.stableKey,
			initialPrompt:
				"Prompt\nSafe\r\t\u0001\u0085\u001b[38;5;201mBody\u001b[0m",
			metadata: {
				elapsedMs: 102_000,
				modelId: "openai-codex/gpt-5.6-sol",
				contextTokens: 34_000,
				contextWindow: 190_000,
			},
			width: 40,
			theme: THEME,
		});

		// ASSERT: three physical rows remain safe and preserve recognizable identity, prompt, and metadata prefixes.
		expect({
			rows: header.length,
			physicalRows: header.reduce(
				(count, line) => count + line.split(PHYSICAL_ROW_BREAK).length,
				0,
			),
			inputControlsRemoved: inputControls.every((control) =>
				header.every((line) => !line.includes(control)),
			),
			identityRecognizable: header[0]?.includes("Agent Safe") ?? false,
			prompt: header[1]?.startsWith("⧗ Prompt Safe Body") ?? false,
			metadata: header[2]?.startsWith("1m42s · openai") ?? false,
			fits: header.every((line) => visibleWidth(line) <= 40),
		}).toEqual({
			rows: 3,
			physicalRows: 3,
			inputControlsRemoved: true,
			identityRecognizable: true,
			prompt: true,
			metadata: true,
			fits: true,
		});
	});

	test("redistributes width when selected metadata fields are unavailable", () => {
		// Purpose: optional metadata omission must remove only the unavailable field and its separator.
		// Inputs and expected output: elapsed-only, model-only, and context-only omissions keep every remaining field recognizable.
		// Edge case: omission never produces an empty separator.
		// Dependencies: one-line selected metadata formatting.
		// ARRANGE: use long safe model values so field preservation remains observable.
		const selected = {
			...node("optional", "root-owner", 1, null, "Agent", 1),
			taskName: "Inspect task allocation",
		};
		const render = (metadata: {
			readonly elapsedMs?: number;
			readonly modelId?: string;
			readonly contextTokens?: number;
			readonly contextWindow?: number;
		}) =>
			renderSelectedSessionHeader({
				nodes: [selected],
				selectedStableKey: selected.stableKey,
				metadata,
				width: 80,
				theme: THEME,
			})[2] ?? "";

		// ACT: omit each optional metadata field independently.
		const withoutElapsed = render({
			modelId: "openai-codex/gpt-5.6-sol",
			contextTokens: 34_000,
			contextWindow: 190_000,
		});
		const withoutModel = render({
			elapsedMs: 102_000,
			contextTokens: 34_000,
			contextWindow: 190_000,
		});
		const withoutContext = render({
			elapsedMs: 102_000,
			modelId: "openai-codex/gpt-5.6-sol",
		});

		// ASSERT: only the absent field disappears while separators and variable allocation remain valid.
		expect({
			withoutElapsed: {
				remaining:
					withoutElapsed.includes("openai-codex/gpt-5.6-sol") &&
					withoutElapsed.includes("34k/190k"),
				absent: !withoutElapsed.includes("1m42s"),
				separators: !withoutElapsed.includes("·  ·"),
				fits: visibleWidth(withoutElapsed) <= 40,
			},
			withoutModel: {
				remaining:
					withoutModel.includes("1m42s") && withoutModel.includes("34k/190k"),
				absent: !withoutModel.includes("openai"),
				separators: !withoutModel.includes("·  ·"),
				fits: visibleWidth(withoutModel) <= 40,
			},
			withoutContext: {
				remaining:
					withoutContext.includes("1m42s") &&
					withoutContext.includes("openai-codex/gpt-5.6-sol"),
				absent: !withoutContext.includes("34k/190k"),
				separators: !withoutContext.includes("·  ·"),
				fits: visibleWidth(withoutContext) <= 40,
			},
		}).toEqual({
			withoutElapsed: {
				remaining: true,
				absent: true,
				separators: true,
				fits: true,
			},
			withoutModel: {
				remaining: true,
				absent: true,
				separators: true,
				fits: true,
			},
			withoutContext: {
				remaining: true,
				absent: true,
				separators: true,
				fits: true,
			},
		});
	});

	test("clips prompt and metadata rows at the right edge", () => {
		// Purpose: narrow selected panes must keep row meaning at the left while clipping overflow at the right.
		// Inputs and expected output: long prompt and metadata rows end with ellipses and never exceed width 16.
		// Edge case: status remains visible even when almost the entire prompt is hidden.
		// Dependencies: one-line prompt normalization and Pi width-aware truncation.
		const selected = node("below-minimum", "root-owner", 1, null, "Agent", 1);

		const header = renderSelectedSessionHeader({
			nodes: [selected],
			selectedStableKey: selected.stableKey,
			initialPrompt: "Inspect a prompt that is wider than the pane",
			metadata: {
				elapsedMs: 102_000,
				modelId: "openai-codex/gpt-5.6-sol",
				contextTokens: 34_000,
				contextWindow: 190_000,
			},
			width: 16,
			theme: THEME,
		});

		expect({
			prompt: header[1]?.startsWith("⧗ Inspect") ?? false,
			promptClipped: header[1]?.includes("…") ?? false,
			metadata: header[2]?.startsWith("1m42s") ?? false,
			metadataClipped: header[2]?.includes("…") ?? false,
			fits: header.every((line) => visibleWidth(line) <= 16),
		}).toEqual({
			prompt: true,
			promptClipped: true,
			metadata: true,
			metadataClipped: true,
			fits: true,
		});
	});

	test("clips ancestry while preserving selected identity and available metadata", () => {
		// Purpose: the selected header must preserve the selected logical identity while removing oldest ancestors under width pressure.
		// Inputs and expected output: a deep selected node keeps status, initial prompt, elapsed, model, and context metadata without exposing routing identities.
		// Edge case: all four global status counts remain visible together.
		// Dependencies: projected parent edges and public Pi width utilities.
		// ARRANGE: provide a deep selection and non-zero running, failed, and completed counts.
		const nodes = hierarchy().map((item) => {
			if (item.stableKey === "root-b") {
				return { ...item, state: "terminal-success" as const };
			}
			if (item.stableKey === "root-a" || item.stableKey === "child-a") {
				return {
					...item,
					agentId: `${item.agentId}WithAnIntentionallyLongIdentity`,
					...(item.stableKey === "root-a"
						? { state: "terminal-failure" as const }
						: {}),
				};
			}
			return item;
		});

		// ACT: render a header whose ancestry exceeds a width that still fits all available metadata.
		const headerWidth = 100;
		const header = renderSelectedSessionHeader({
			nodes,
			selectedStableKey: "grandchild-a",
			initialPrompt: "Inspect the long task",
			metadata: {
				elapsedMs: 102_000,
				modelId: "openai-codex/gpt-5.6-sol",
				thinking: "low",
				contextTokens: 34_000,
				contextWindow: 190_000,
				projectionSavedTokens: 20_000,
			},
			width: headerWidth,
			theme: THEME,
		});
		const title = renderHierarchyTitle(nodes, 60, THEME);

		// ASSERT: selected identity and metadata survive while routing data and the forbidden label remain hidden.
		expect({
			rows: header.length,
			chainClipped: header[0]?.startsWith("… ›") ?? false,
			selectedIdentity: header[0]?.endsWith("SubAgentCritic #1") ?? false,
			metadataComplete:
				header[1]?.includes("⧗ Inspect the long task") === true &&
				header[2]?.includes("1m42s") === true &&
				header[2]?.includes("openai-codex/gpt-5.6-sol/low") === true &&
				header[2]?.includes("~20k/34k/190k") === true,
			fits: header.every((line) => visibleWidth(line) <= headerWidth),
			hidesRouting: header.every(
				(line) => !line.includes("grandchild-a") && !line.includes("Path:"),
			),
			title,
		}).toEqual({
			rows: 3,
			chainClipped: true,
			selectedIdentity: true,
			metadataComplete: true,
			fits: true,
			hidesRouting: true,
			title: "Agents: ⧗ 3 · ✓ 1 · ✗ 1 · ■ 0",
		});
	});
});
