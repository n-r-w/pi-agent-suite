import {
	type ExtensionContext,
	getMarkdownTheme,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Loader,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { InvocationMetadata, LogicalSession } from "../domain";
import { errorMessage } from "../error-message";
import type { LiveAgentStatus } from "../live-status";
import type { ManagementProjectionView, ProjectionNode } from "../projection";
import type { ToolPresentationRegistry } from "../tool-rendering";
import { ConversationPane, readInitialPrompt } from "./conversation";
import {
	ManagementMessageEditor,
	type ManagementMessageSubmission,
} from "./editor";
import {
	HierarchyPane,
	type HierarchyRetainedState,
	renderHierarchyTitle,
	renderSelectedSessionHeader,
} from "./hierarchy";
import {
	calculateScrollThumb,
	isScrollThumbRow,
	type ScrollMetrics,
	type ScrollThumb,
} from "./scroll-indicator";

const HIERARCHY_MIN_WIDTH = 24;
const CONVERSATION_MIN_WIDTH = 40;
const OUTER_BORDER_WIDTH = 2;
const PANE_SEPARATOR_WIDTH = 1;
const SCROLL_COLUMN_WIDTH = 1;
const HIERARCHY_WIDTH_DIVISOR = 3;
const SCREEN_CHROME_ROWS = 3;
const SELECTED_HEADER_ROWS = 3;
const PANE_DIVIDER_ROWS = 1;
const MIN_CONVERSATION_ROWS = 1;
const MIN_FRAMED_EDITOR_ROWS = 3;
/** Keeps whole-second elapsed presentation current without revising session data. */
const ELAPSED_REFRESH_INTERVAL_MS = 1_000;
/** Converts retry deadlines to whole-second countdown labels. */
const MILLISECONDS_PER_SECOND = 1_000;
/** Ends child SGR and OSC 8 state before screen-owned chrome. */
const SCREEN_SEGMENT_RESET = "\u001b[0m\u001b]8;;\u0007";

/** Identifies the focus owner that may consume pane-local input. */
type ManagementFocusZone = "hierarchy" | "conversation" | "editor";

/** Identifies the visible pane while both minimum widths do not fit. */
type ManagementNarrowPane = "hierarchy" | "conversation";

/** Retains presentation-only hierarchy state for one extension runtime. */
export interface ManagementRetainedState {
	hierarchy: HierarchyRetainedState;
}

/** Publishes immutable management revisions and selected active branches. */
export interface ManagementViewSource {
	getView(): ManagementProjectionView;
	select(stableKey: string | null): Promise<void> | void;
	/** Loads one preceding dependency-complete block for the selected preview. */
	loadEarlierSelected(): Promise<boolean> | boolean;
	refreshSelected(): Promise<void> | void;
	subscribe(listener: (view: ManagementProjectionView) => void): () => void;
}

/** Supplies the dependencies of one disposable full-terminal screen. */
interface SelectedPaneRender {
	readonly lines: readonly string[];
	readonly editorTopIndex?: number;
	readonly conversationStartIndex: number;
	readonly conversationHeight: number;
}

interface ScrollTrack {
	readonly startRow: number;
	readonly length: number;
	readonly loading: boolean;
	readonly thumb?: ScrollThumb;
}

interface WideRowContent {
	readonly hierarchyLines: readonly string[];
	readonly conversationLines: readonly string[];
	readonly editorTopIndex?: number;
	readonly hierarchyScroll?: ScrollTrack;
	readonly conversationScroll?: ScrollTrack;
}

interface NarrowRowContent {
	readonly value: string;
	readonly dividerIndex: number;
	readonly editorTopIndex?: number;
	readonly scroll?: ScrollTrack;
}

interface WideEditorBorderContent {
	readonly hierarchyLine: string;
	readonly conversationLine: string;
	readonly hierarchyScroll: string;
}

interface ManagementScreenOptions {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly cwd: string;
	readonly source: ManagementViewSource;
	readonly tools: ToolPresentationRegistry;
	readonly submission: ManagementMessageSubmission;
	readonly retained: ManagementRetainedState;
	readonly toolsExpanded: boolean;
	readonly notify: (message: string) => void;
	readonly close: () => void;
}

/** Creates the hierarchy state retained across management overlay instances. */
export function createManagementRetainedState(): ManagementRetainedState {
	return {
		hierarchy: {
			expandedStableKeys: [],
			selectedStableKey: null,
			scrollTop: 0,
		},
	};
}

/** Renders and navigates one full-terminal management overlay. */
export class ManagementScreen implements Component, Focusable {
	private view: ManagementProjectionView;
	private readonly hierarchy: HierarchyPane;
	private readonly conversation: ConversationPane;
	private readonly editor: ManagementMessageEditor;
	private readonly unsubscribe: () => void;
	private focus: ManagementFocusZone;
	private narrowPane: ManagementNarrowPane;
	private toolsExpanded: boolean;
	private lastWidth: number;
	private previewFillPromise: Promise<void> | undefined;
	/** Owns the periodic render request for the visible active duration. */
	private elapsedRefreshTimer: ReturnType<typeof setInterval> | undefined;
	/** Owns the public Pi loader used for the selected child runtime status. */
	private liveStatusIndicator: Loader | undefined;
	private disposed = false;
	private _focused = false;

	public constructor(private readonly options: ManagementScreenOptions) {
		this.view = options.source.getView();
		this.hierarchy = new HierarchyPane(
			this.view.nodes,
			options.retained.hierarchy,
		);
		// Every overlay instance starts a fresh focus and one-pane state machine.
		this.focus = "hierarchy";
		this.narrowPane = "hierarchy";
		this.toolsExpanded = options.toolsExpanded;
		this.lastWidth = options.tui.terminal.columns;
		this.conversation = new ConversationPane({
			tui: options.tui,
			theme: options.theme,
			markdownTheme: getMarkdownTheme(),
			cwd: options.cwd,
			tools: options.tools,
			expanded: this.toolsExpanded,
		});
		this.conversation.setEntries(
			this.view.selectedConversation,
			true,
			this.view.selectedConversationComplete,
		);
		this.editor = new ManagementMessageEditor({
			tui: options.tui,
			theme: options.theme,
			keybindings: options.keybindings,
			submission: options.submission,
			selectedStableKey: () => this.hierarchy.getSelectedStableKey(),
			notify: (message) => {
				options.notify(message);
				options.tui.requestRender();
			},
			onAccepted: () => this.refreshSelectedConversation(),
		});
		this.unsubscribe = options.source.subscribe((view) =>
			this.applyProjection(view),
		);
		this.syncSelection(true);
		this.normalizeFocus();
		this.syncFocus();
	}

	/** Propagates overlay focus to the active editor for IME cursor placement. */
	public get focused(): boolean {
		return this._focused;
	}

	public set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	/** Returns the responsive layout selected for one terminal width. */
	public layoutForWidth(width: number): "wide" | "one-pane" {
		const paneBudget = width - OUTER_BORDER_WIDTH - PANE_SEPARATOR_WIDTH;
		return paneBudget >=
			HIERARCHY_MIN_WIDTH + CONVERSATION_MIN_WIDTH + SCROLL_COLUMN_WIDTH * 2
			? "wide"
			: "one-pane";
	}

	/** Returns the current pane focus owner. */
	public getFocusZone(): ManagementFocusZone {
		return this.focus;
	}

	/** Returns the one-pane navigation state. */
	public getNarrowPane(): ManagementNarrowPane {
		return this.narrowPane;
	}

	/** Returns the selected stable internal identity. */
	public getSelectedStableKey(): string | null {
		return this.hierarchy.getSelectedStableKey();
	}

	/** Returns the message editor text. */
	public getEditorText(): string {
		return this.editor.getText();
	}

	/** Returns this overlay's screen-local tool expansion state. */
	public getToolsExpanded(): boolean {
		return this.toolsExpanded;
	}

	/** Replaces message editor text for deterministic interaction or restoration. */
	public setEditorText(text: string): void {
		this.editor.setText(text);
	}

	/** Consumes global input before forwarding focus-local actions. */
	public handleInput(data: string): void {
		if (this.disposed) {
			return;
		}
		if (this.handleGlobalInput(data)) {
			return;
		}
		const changed = this.handleFocusedInput(data);
		if (changed || this.focus === "editor") {
			this.options.tui.requestRender();
		}
	}

	/** Renders exactly the current terminal row budget. */
	public render(width: number): string[] {
		this.lastWidth = width;
		this.normalizeFocus();
		this.syncFocus();
		const rowBudget = Math.max(1, this.options.tui.terminal.rows);
		const layout = this.layoutForWidth(width);
		this.syncElapsedRefresh(this.selectedPaneVisible(width, rowBudget));
		if (width <= 1 || rowBudget < SCREEN_CHROME_ROWS) {
			return Array.from({ length: rowBudget }, () => "".padEnd(width));
		}
		const contentHeight = rowBudget - SCREEN_CHROME_ROWS;
		const content =
			layout === "wide"
				? this.renderWideContent(width, contentHeight)
				: this.renderNarrowContent(width, contentHeight);
		const hint = this.renderHints(Math.max(0, width - OUTER_BORDER_WIDTH));
		return [
			layout === "wide"
				? this.renderWideTopBorder(width)
				: border("┌", "┐", width),
			...content,
			`│${padToWidth(hint, width - OUTER_BORDER_WIDTH)}│`,
			border("└", "┘", width),
		];
	}

	/** Invalidates all visible child components. */
	public invalidate(): void {
		this.conversation.invalidate();
		this.editor.invalidate();
	}

	/** Releases subscriptions and overlay-owned component resources. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const hierarchy = this.hierarchy.snapshot();
		// Reopen retains only approved hierarchy expansion and valid selection.
		this.options.retained.hierarchy = { ...hierarchy, scrollTop: 0 };
		this.unsubscribe();
		this.stopElapsedRefresh();
		this.liveStatusIndicator?.stop();
		this.liveStatusIndicator = undefined;
		// The retained key restores selection later; clearing the runtime selection releases conversation payloads now.
		Promise.resolve(this.options.source.select(null)).catch((error: unknown) =>
			this.options.notify(errorMessage(error)),
		);
		this.conversation.dispose();
		this.editor.dispose();
	}

	/** Handles keys that must never leak into a focused child component. */
	private handleGlobalInput(data: string): boolean {
		if (matchesKey(data, Key.tab)) {
			this.cycleFocus(1);
			this.options.tui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleFocus(-1);
			this.options.tui.requestRender();
			return true;
		}
		if (this.options.keybindings.matches(data, "app.tools.expand")) {
			this.toolsExpanded = !this.toolsExpanded;
			this.conversation.setExpanded(this.toolsExpanded);
			this.options.tui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.ctrlShift("g"))) {
			this.options.close();
			return true;
		}
		if (!matchesKey(data, Key.escape)) {
			return false;
		}
		if (
			this.layoutForWidth(this.lastWidth) === "one-pane" &&
			this.narrowPane === "conversation"
		) {
			this.narrowPane = "hierarchy";
			this.focus = "hierarchy";
			this.syncFocus();
			this.options.tui.requestRender();
			return true;
		}
		this.options.close();
		return true;
	}

	/** Routes pane-local input only to the active focus owner. */
	private handleFocusedInput(data: string): boolean {
		switch (this.focus) {
			case "hierarchy":
				return this.handleHierarchyInput(data);
			case "conversation":
				return this.handleConversationInput(data);
			case "editor":
				this.editor.handleInput(data);
				return true;
		}
	}

	/** Applies configured selection keys and direct tree edge navigation. */
	private handleHierarchyInput(data: string): boolean {
		let changed = false;
		if (this.options.keybindings.matches(data, "tui.select.up")) {
			changed = this.hierarchy.moveSelection(-1);
		} else if (this.options.keybindings.matches(data, "tui.select.down")) {
			changed = this.hierarchy.moveSelection(1);
		} else if (matchesKey(data, Key.left)) {
			changed = this.hierarchy.moveLeft();
		} else if (matchesKey(data, Key.right)) {
			changed = this.hierarchy.moveRight();
		} else if (
			this.layoutForWidth(this.lastWidth) === "one-pane" &&
			this.options.keybindings.matches(data, "tui.select.confirm") &&
			this.hierarchy.getSelectedStableKey() !== null
		) {
			this.narrowPane = "conversation";
			this.focus = "conversation";
			this.syncSelection(true);
			this.syncFocus();
			return true;
		}
		if (changed) {
			this.syncSelection(true);
		}
		return changed;
	}

	/** Scrolls the selected conversation by public visual rows and pages. */
	private handleConversationInput(data: string): boolean {
		if (this.options.keybindings.matches(data, "tui.select.up")) {
			return this.conversation.scrollLines(-1);
		}
		if (this.options.keybindings.matches(data, "tui.select.down")) {
			return this.conversation.scrollLines(1);
		}
		if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
			return this.conversation.scrollPage(-1);
		}
		if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
			return this.conversation.scrollPage(1);
		}
		return false;
	}

	/** Cycles only focus zones available in the current responsive pane. */
	private cycleFocus(delta: -1 | 1): void {
		const zones = this.availableFocusZones();
		const current = zones.indexOf(this.focus);
		const base = current < 0 ? 0 : current;
		this.focus =
			zones[(base + delta + zones.length) % zones.length] ?? "hierarchy";
		this.syncFocus();
	}

	/** Returns the closed focus set for the current responsive state. */
	private availableFocusZones(): readonly ManagementFocusZone[] {
		if (this.layoutForWidth(this.lastWidth) === "wide") {
			return this.hierarchy.getSelectedStableKey() === null
				? ["hierarchy", "conversation"]
				: ["hierarchy", "conversation", "editor"];
		}
		if (this.narrowPane === "hierarchy") {
			return ["hierarchy"];
		}
		return this.hierarchy.getSelectedStableKey() === null
			? ["conversation"]
			: ["conversation", "editor"];
	}

	/** Repairs focus after selection removal or a responsive pane transition. */
	private normalizeFocus(): void {
		const zones = this.availableFocusZones();
		if (!zones.includes(this.focus)) {
			this.focus = zones[0] ?? "hierarchy";
		}
	}

	/** Maintains the single hardware-cursor owner invariant. */
	private syncFocus(): void {
		this.editor.focused = this._focused && this.focus === "editor";
		this.editor.setEnabled(this.hierarchy.getSelectedStableKey() !== null);
	}

	/** Routes stable selection to the projection and resets the branch viewport. */
	private syncSelection(resetConversation: boolean): void {
		const stableKey = this.hierarchy.getSelectedStableKey();
		Promise.resolve(this.options.source.select(stableKey)).catch(
			(error: unknown) => this.options.notify(errorMessage(error)),
		);
		if (resetConversation && stableKey === this.view.selectedStableKey) {
			this.conversation.setEntries(
				this.view.selectedConversation,
				true,
				this.view.selectedConversationComplete,
			);
		}
	}

	/** Applies only visible projection revisions and preserves stable UI state. */
	private applyProjection(view: ManagementProjectionView): void {
		if (this.disposed || view.revision === this.view.revision) {
			return;
		}
		const priorSelected = this.hierarchy.getSelectedStableKey();
		this.view = view;
		this.hierarchy.update(view.nodes);
		const selected = this.hierarchy.getSelectedStableKey();
		if (selected !== priorSelected) {
			this.syncSelection(true);
		}
		if (view.selectedStableKey === selected) {
			this.conversation.setEntries(
				view.selectedConversation,
				selected !== priorSelected,
				view.selectedConversationComplete,
			);
		}
		this.normalizeFocus();
		this.syncFocus();
		this.syncElapsedRefresh(
			this.selectedPaneVisible(
				this.lastWidth,
				Math.max(1, this.options.tui.terminal.rows),
			),
		);
		this.options.tui.requestRender();
	}

	/** Reports whether the selected pane can render within the current screen bounds. */
	private selectedPaneVisible(width: number, rowBudget: number): boolean {
		return (
			width > 1 &&
			rowBudget >= SCREEN_CHROME_ROWS &&
			(this.layoutForWidth(width) === "wide" ||
				this.narrowPane === "conversation")
		);
	}

	/** Runs the presentation refresh only while an active elapsed value is visible. */
	private syncElapsedRefresh(selectedPaneVisible: boolean): void {
		const selected = this.hierarchy.getSelectedStableKey();
		const selectedNode =
			selected === null ? undefined : findProjectionNode(this.view, selected);
		const shouldRefresh =
			selectedPaneVisible &&
			selectedNode?.state === "active" &&
			selectedNode.invocationMetadata !== undefined;
		// Hidden and terminal selections must not retain a presentation timer.
		if (!shouldRefresh) {
			this.stopElapsedRefresh();
			return;
		}
		// Repeated renders and projection revisions share one owned interval.
		if (this.elapsedRefreshTimer !== undefined) {
			return;
		}
		this.elapsedRefreshTimer = setInterval(() => {
			// A queued callback can run once after disposal clears the interval.
			if (!this.disposed) {
				this.options.tui.requestRender();
			}
		}, ELAPSED_REFRESH_INTERVAL_MS);
	}

	/** Releases the screen-owned elapsed refresh timer. */
	private stopElapsedRefresh(): void {
		if (this.elapsedRefreshTimer === undefined) {
			return;
		}
		clearInterval(this.elapsedRefreshTimer);
		this.elapsedRefreshTimer = undefined;
	}

	/** Starts one viewport-driven preview expansion and then full background hydration. */
	private requestPreviewFill(width: number, height: number): void {
		if (
			this.disposed ||
			this.view.selectedConversationComplete ||
			height <= 0 ||
			this.previewFillPromise !== undefined
		) {
			return;
		}
		const selectedStableKey = this.view.selectedStableKey;
		if (selectedStableKey === null) {
			return;
		}
		const fill = this.fillSelectedPreview(selectedStableKey, width, height);
		this.previewFillPromise = fill;
		fill
			.catch((error: unknown) => this.options.notify(errorMessage(error)))
			.finally(() => {
				if (this.previewFillPromise === fill) {
					this.previewFillPromise = undefined;
				}
			});
	}

	/** Requests complete user turns until Pi-rendered rows fill the current viewport. */
	private async fillSelectedPreview(
		selectedStableKey: string,
		width: number,
		height: number,
	): Promise<void> {
		if (
			this.disposed ||
			this.view.selectedStableKey !== selectedStableKey ||
			this.view.selectedConversationComplete
		) {
			return;
		}
		if (this.conversation.getLoadedContentRows(width) >= height) {
			await Promise.resolve(this.options.source.refreshSelected());
			return;
		}
		const complete = await Promise.resolve(
			this.options.source.loadEarlierSelected(),
		);
		if (complete) {
			if (
				!this.disposed &&
				this.view.selectedStableKey === selectedStableKey &&
				!this.view.selectedConversationComplete
			) {
				await Promise.resolve(this.options.source.refreshSelected());
			}
			return;
		}
		await this.fillSelectedPreview(selectedStableKey, width, height);
	}

	/** Requests the selected branch after the coordinator accepts editor input. */
	private refreshSelectedConversation(): void {
		Promise.resolve(this.options.source.refreshSelected()).catch(
			(error: unknown) => this.options.notify(errorMessage(error)),
		);
	}

	/** Renders the split top border with one junction above the pane boundary. */
	private renderWideTopBorder(width: number): string {
		const panes = widePaneWidths(width);
		return `┌${"─".repeat(panes.hierarchy)}┬${"─".repeat(panes.conversation)}┐`;
	}

	/** Renders both readable pane minima with connected top and bottom junctions. */
	private renderWideContent(width: number, height: number): string[] {
		const panes = widePaneWidths(width);
		const normalHeight = Math.max(0, height - 1);
		const hierarchyContentWidth = panes.hierarchy - SCROLL_COLUMN_WIDTH;
		const conversationContentWidth = panes.conversation - SCROLL_COLUMN_WIDTH;
		const hierarchyLines = this.renderHierarchyPane(
			hierarchyContentWidth,
			normalHeight,
		);
		const selectedPane = this.renderSelectedPane(
			conversationContentWidth,
			height,
		);
		const conversationLines = selectedPane.lines;
		const hierarchyScroll = createScrollTrack(
			this.hierarchy.getScrollMetrics(),
			2,
		);
		const conversationScroll = createScrollTrack(
			this.conversation.getScrollMetrics(),
			selectedPane.conversationStartIndex,
			!this.view.selectedConversationComplete,
		);
		return Array.from({ length: height }, (_, index) =>
			this.renderWideRow(index, height, panes, {
				hierarchyLines,
				conversationLines,
				...(selectedPane.editorTopIndex === undefined
					? {}
					: { editorTopIndex: selectedPane.editorTopIndex }),
				...(hierarchyScroll === undefined ? {} : { hierarchyScroll }),
				...(conversationScroll === undefined ? {} : { conversationScroll }),
			}),
		);
	}

	/** Renders only the active full-width pane below the responsive threshold. */
	private renderNarrowContent(width: number, height: number): string[] {
		const paneWidth = width - OUTER_BORDER_WIDTH;
		const contentWidth = Math.max(0, paneWidth - SCROLL_COLUMN_WIDTH);
		const normalHeight = Math.max(0, height - 1);
		const selectedPane =
			this.narrowPane === "conversation"
				? this.renderSelectedPane(contentWidth, height)
				: undefined;
		const lines =
			this.narrowPane === "hierarchy"
				? this.renderHierarchyPane(contentWidth, normalHeight)
				: (selectedPane?.lines ?? []);
		const dividerIndex =
			this.narrowPane === "hierarchy" ? 1 : SELECTED_HEADER_ROWS;
		const scroll =
			this.narrowPane === "hierarchy"
				? createScrollTrack(this.hierarchy.getScrollMetrics(), 2)
				: createScrollTrack(
						this.conversation.getScrollMetrics(),
						selectedPane?.conversationStartIndex ?? 0,
						!this.view.selectedConversationComplete,
					);
		return Array.from({ length: height }, (_, index) =>
			this.renderNarrowRow(index, height, contentWidth, {
				value: lines[index] ?? "",
				dividerIndex,
				...(selectedPane?.editorTopIndex === undefined
					? {}
					: { editorTopIndex: selectedPane.editorTopIndex }),
				...(scroll === undefined ? {} : { scroll }),
			}),
		);
	}

	/** Connects one wide content row to the exact pane and editor junctions. */
	private renderWideRow(
		index: number,
		height: number,
		panes: ReturnType<typeof widePaneWidths>,
		content: WideRowContent,
	): string {
		const hierarchyContentWidth = panes.hierarchy - SCROLL_COLUMN_WIDTH;
		const conversationContentWidth = panes.conversation - SCROLL_COLUMN_WIDTH;
		const hierarchyLine = padToWidth(
			content.hierarchyLines[index] ?? "",
			hierarchyContentWidth,
		);
		const conversationLine = padToWidth(
			content.conversationLines[index] ?? "",
			conversationContentWidth,
		);
		const hierarchyScroll = this.renderScrollColumn(
			index,
			content.hierarchyScroll,
			this.focus === "hierarchy",
		);
		const conversationScroll = this.renderScrollColumn(
			index,
			content.conversationScroll,
			this.focus === "conversation",
		);
		if (index === height - 1) {
			return this.renderWideEditorBorder(
				panes,
				{ hierarchyLine, conversationLine, hierarchyScroll },
				"bottom",
			);
		}
		if (index === content.editorTopIndex) {
			return this.renderWideEditorBorder(
				panes,
				{ hierarchyLine, conversationLine, hierarchyScroll },
				"top",
			);
		}
		if (index === 1) {
			return `├${hierarchyLine}${SCREEN_SEGMENT_RESET}─┤${conversationLine}${SCREEN_SEGMENT_RESET}${conversationScroll}│`;
		}
		if (
			index === SELECTED_HEADER_ROWS &&
			content.conversationLines.length > 0
		) {
			// The divider belongs to the selected-session header and must stay absent with no selection.
			return `│${hierarchyLine}${SCREEN_SEGMENT_RESET}${hierarchyScroll}├${conversationLine}${SCREEN_SEGMENT_RESET}─┤`;
		}
		return `│${hierarchyLine}${SCREEN_SEGMENT_RESET}${hierarchyScroll}│${conversationLine}${SCREEN_SEGMENT_RESET}${conversationScroll}│`;
	}

	/** Joins one editor boundary while limiting focus color to the editor pane. */
	private renderWideEditorBorder(
		panes: ReturnType<typeof widePaneWidths>,
		content: WideEditorBorderContent,
		position: "top" | "bottom",
	): string {
		const editorFocused = this._focused && this.focus === "editor";
		const editorScrollBorder = editorFocused
			? this.options.theme.fg("borderAccent", "─")
			: "─";
		if (position === "bottom") {
			const rightLine = editorFocused
				? content.conversationLine
				: "─".repeat(panes.conversation - SCROLL_COLUMN_WIDTH);
			return `├${"─".repeat(panes.hierarchy)}${SCREEN_SEGMENT_RESET}┴${rightLine}${SCREEN_SEGMENT_RESET}${editorScrollBorder}┤`;
		}
		return `│${content.hierarchyLine}${SCREEN_SEGMENT_RESET}${content.hierarchyScroll}├${this.renderSteerBorder(
			panes.conversation - SCROLL_COLUMN_WIDTH,
			editorFocused,
		)}${SCREEN_SEGMENT_RESET}${editorScrollBorder}┤`;
	}

	/** Connects one narrow content row to status, header, and editor borders. */
	private renderNarrowRow(
		index: number,
		height: number,
		width: number,
		content: NarrowRowContent,
	): string {
		const line = padToWidth(content.value, width);
		const editorFocused = this._focused && this.focus === "editor";
		const scroll = this.renderScrollColumn(
			index,
			content.scroll,
			this.focus === this.narrowPane,
		);
		const editorScrollBorder = editorFocused
			? this.options.theme.fg("borderAccent", "─")
			: "─";
		if (index === height - 1) {
			return editorFocused
				? `├${line}${SCREEN_SEGMENT_RESET}${editorScrollBorder}┤`
				: `├${"─".repeat(width + SCROLL_COLUMN_WIDTH)}┤`;
		}
		if (index === content.editorTopIndex) {
			return `├${this.renderSteerBorder(width, editorFocused)}${SCREEN_SEGMENT_RESET}${editorScrollBorder}┤`;
		}
		if (index === content.dividerIndex) {
			return `├${line}${SCREEN_SEGMENT_RESET}─┤`;
		}
		return `│${line}${SCREEN_SEGMENT_RESET}${scroll}│`;
	}

	/** Renders one dedicated scroll track cell without touching the pane frame. */
	private renderScrollColumn(
		row: number,
		track: ScrollTrack | undefined,
		focused: boolean,
	): string {
		if (track === undefined) {
			return " ";
		}
		const trackRow = row - track.startRow;
		if (trackRow < 0 || trackRow >= track.length) {
			return " ";
		}
		if (track.loading) {
			return this.options.theme.fg("muted", trackRow === 0 ? "⋮" : "▒");
		}
		if (track.thumb === undefined || !isScrollThumbRow(track.thumb, trackRow)) {
			return this.options.theme.fg("muted", "░");
		}
		return this.options.theme.fg(
			this._focused && focused ? "border" : "borderMuted",
			"█",
		);
	}

	/** Embeds the editor purpose without coloring shared frame junctions. */
	private renderSteerBorder(width: number, focused: boolean): string {
		const label = " Steer ";
		const prefix = "─";
		const suffix = "─".repeat(
			Math.max(0, width - visibleWidth(prefix) - visibleWidth(label)),
		);
		if (!focused) {
			return truncateToWidth(`${prefix}${label}${suffix}`, width, "…");
		}
		return truncateToWidth(
			`${this.options.theme.fg("borderAccent", prefix)} ${this.options.theme.fg("borderAccent", "Steer")} ${this.options.theme.fg("borderAccent", suffix)}`,
			width,
			"…",
		);
	}

	/** Places the status summary and its divider above scrollable hierarchy rows. */
	private renderHierarchyPane(width: number, height: number): string[] {
		if (height <= 0) {
			return [];
		}
		const status = renderHierarchyTitle(
			this.view.nodes,
			width,
			this.options.theme,
			this._focused && this.focus === "hierarchy",
		);
		if (height === 1) {
			return [status];
		}
		return [
			status,
			"─".repeat(width),
			...this.hierarchy.render(
				width,
				height - 2,
				this.options.theme,
				this._focused && this.focus === "hierarchy",
			),
		];
	}

	/** Composes selected header, conversation viewport, and attached editor. */
	private renderSelectedPane(
		width: number,
		height: number,
	): SelectedPaneRender {
		const selected = this.hierarchy.getSelectedStableKey();
		if (selected === null || height <= 0) {
			return { lines: [], conversationStartIndex: 0, conversationHeight: 0 };
		}
		const selectedNode = findProjectionNode(this.view, selected);
		if (selectedNode === undefined) {
			return { lines: [], conversationStartIndex: 0, conversationHeight: 0 };
		}
		const header = this.renderSelectedHeader(selectedNode, selected, width);
		const editorLines = this.editor.render(width);
		const maximumEditorRows = Math.max(
			1,
			height - SELECTED_HEADER_ROWS - PANE_DIVIDER_ROWS - MIN_CONVERSATION_ROWS,
		);
		const liveStatusLines = this.renderLiveStatus(width);
		const editorViewport = cropEditorViewport(
			editorLines,
			Math.max(1, maximumEditorRows - liveStatusLines.length),
		);
		const editorHeight = editorViewport.length;
		const conversationHeight = Math.max(
			0,
			height -
				header.length -
				PANE_DIVIDER_ROWS -
				liveStatusLines.length -
				editorHeight,
		);
		const conversationLines = this.conversation.render(
			width,
			conversationHeight,
		);
		this.requestPreviewFill(width, conversationHeight);
		const lines = [
			...header,
			"─".repeat(width),
			...padRows(conversationLines, conversationHeight, width),
			...liveStatusLines,
			...editorViewport,
		].slice(0, height);
		const editorTopIndex =
			editorViewport.length >= MIN_FRAMED_EDITOR_ROWS
				? header.length +
					PANE_DIVIDER_ROWS +
					conversationHeight +
					liveStatusLines.length
				: undefined;
		return {
			lines,
			conversationStartIndex: header.length + PANE_DIVIDER_ROWS,
			conversationHeight,
			...(editorTopIndex === undefined ? {} : { editorTopIndex }),
		};
	}

	/** Renders selected identity and the latest matching invocation metadata. */
	private renderSelectedHeader(
		selectedNode: ProjectionNode,
		selectedStableKey: string,
		width: number,
	): readonly string[] {
		const initialPrompt = readInitialPrompt(this.view.selectedConversation);
		// Active conversation entries can report usage before the durable invocation reaches a terminal state.
		const conversationMetadata = this.conversation.getMetadata();
		const headerMetadata = withLiveElapsed(
			withLiveProjectionSavedTokens(
				withLiveContextTokens(
					selectedNode.invocationMetadata,
					conversationMetadata.modelId,
					conversationMetadata.contextTokens,
				),
				selectedNode.state,
				this.view.selectedProjectionSavedTokens,
			),
			selectedNode.state,
		);
		return renderSelectedSessionHeader({
			nodes: this.view.nodes,
			selectedStableKey,
			...(initialPrompt === undefined ? {} : { initialPrompt }),
			...(headerMetadata === undefined ? {} : { metadata: headerMetadata }),
			width,
			theme: this.options.theme,
			focused: this._focused && this.focus === "conversation",
		});
	}

	/** Renders one transient child status row without adding it to conversation history. */
	private renderLiveStatus(width: number): readonly string[] {
		const notification = this.view.selectedNotification;
		const status = this.view.selectedLiveStatus;
		const message =
			notification?.message ??
			(status !== undefined
				? liveStatusMessage(status, Date.now())
				: undefined);

		if (message === undefined) {
			this.liveStatusIndicator?.stop();
			this.liveStatusIndicator = undefined;
			return [];
		}

		if (this.liveStatusIndicator === undefined) {
			this.liveStatusIndicator = new Loader(
				this.options.tui,
				(text) => {
					const notif = this.view.selectedNotification;
					if (notif !== undefined) {
						return this.options.theme.fg(
							notif.notifyType === "info" ? "accent" : notif.notifyType,
							text,
						);
					}
					return this.options.theme.fg(
						this.view.selectedLiveStatus?.kind === "retrying"
							? "warning"
							: "accent",
						text,
					);
				},
				(text) => this.options.theme.fg("muted", text),
				message,
			);
		}
		this.liveStatusIndicator.setMessage(message);
		// Loader reserves a leading spacer for Pi's standalone status container; this pane owns its row budget.
		const line = this.liveStatusIndicator.render(width)[1];
		return line === undefined ? [] : [truncateToWidth(line, width)];
	}

	/** Renders only actions that apply to the active focus and pane. */
	private renderHints(width: number): string {
		const hints: string[] = [];
		const onePane = this.layoutForWidth(this.lastWidth) === "one-pane";
		if (this.focus === "hierarchy") {
			hints.push(
				bindingPairHint(
					this.options.keybindings,
					"tui.select.up",
					"tui.select.down",
					"select",
				),
				rawKeyHint("left/right", "tree"),
			);
			if (onePane) {
				hints.push(
					bindingHint(this.options.keybindings, "tui.select.confirm", "open"),
				);
			}
		} else if (this.focus === "conversation") {
			hints.push(
				bindingPairHint(
					this.options.keybindings,
					"tui.select.up",
					"tui.select.down",
					"scroll",
				),
				bindingPairHint(
					this.options.keybindings,
					"tui.select.pageUp",
					"tui.select.pageDown",
					"page",
				),
			);
		} else if (this.focus === "editor") {
			hints.push(
				bindingHint(this.options.keybindings, "tui.input.submit", "send"),
			);
		}
		if (this.availableFocusZones().length > 1) {
			hints.push(rawKeyHint("Tab", "focus"));
		}
		if (onePane && this.narrowPane === "conversation") {
			hints.push(rawKeyHint("Esc", "back"));
		}
		hints.push(
			bindingHint(this.options.keybindings, "app.tools.expand", "tools"),
			rawKeyHint("Ctrl+Shift+G", "close"),
		);
		return truncateToWidth(hints.filter(Boolean).join(" · "), width, "…");
	}
}

/** Supplies stable factory dependencies shared by command and shortcut handlers. */
interface ManagementScreenFactoryOptions {
	readonly ctx: ExtensionContext;
	readonly source: ManagementViewSource;
	readonly tools: ToolPresentationRegistry;
	readonly submission: ManagementMessageSubmission;
	readonly retained: ManagementRetainedState;
}

/** Creates one stable public custom-component factory for both TUI entries. */
export function createManagementScreenFactory(
	options: ManagementScreenFactoryOptions,
): Parameters<ExtensionContext["ui"]["custom"]>[0] {
	return (tui, theme, keybindings, done) =>
		new ManagementScreen({
			tui,
			theme,
			keybindings,
			cwd: options.ctx.cwd,
			source: options.source,
			tools: options.tools,
			submission: options.submission,
			retained: options.retained,
			// Pi invokes the factory for every open, so each overlay samples the main conversation independently.
			toolsExpanded: options.ctx.ui.getToolsExpanded(),
			notify: (message) => options.ctx.ui.notify(message, "error"),
			close: () => done(undefined),
		});
}

/** Opens the approved full-terminal overlay without touching the main editor. */
export async function openManagementOverlay(
	ctx: ExtensionContext,
	factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
): Promise<void> {
	await ctx.ui.custom(factory, {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		},
	});
}

/** Formats one child Pi status without claiming unsupported management actions. */
function liveStatusMessage(status: LiveAgentStatus, nowMs: number): string {
	switch (status.kind) {
		case "working":
			return "Working...";
		case "retrying": {
			const seconds = Math.ceil(
				Math.max(0, status.deadlineAtMs - nowMs) / MILLISECONDS_PER_SECOND,
			);
			return `Retrying (${status.attempt}/${status.maxAttempts}) in ${seconds}s...`;
		}
		case "compacting":
			if (status.reason === "manual") {
				return "Compacting context...";
			}
			return status.reason === "overflow"
				? "Context overflow detected, Auto-compacting..."
				: "Auto-compacting...";
		case "summarizingBranch":
			return "Summarizing branch...";
	}
}

/** Derives active elapsed presentation without mutating durable invocation metadata. */
function withLiveElapsed(
	metadata: InvocationMetadata | undefined,
	state: ProjectionNode["state"],
): InvocationMetadata | undefined {
	// Terminal snapshots retain the coordinator's finalized monotonic duration.
	if (metadata === undefined || state !== "active") {
		return metadata;
	}
	// The durable wall-clock start lets a newly opened screen catch up immediately.
	const wallElapsedMs = Math.max(
		0,
		Math.floor(Date.now() - metadata.startedAtMs),
	);
	return {
		...metadata,
		elapsedMs: Math.max(metadata.elapsedMs, wallElapsedMs),
	};
}

/** Adds live usage only when it belongs to the active invocation model. */
function withLiveContextTokens(
	metadata: InvocationMetadata | undefined,
	liveModelId: string | undefined,
	liveContextTokens: number | undefined,
): InvocationMetadata | undefined {
	// Durable terminal usage remains the final source once the coordinator has committed it.
	if (metadata === undefined || metadata.contextTokens !== undefined) {
		return metadata;
	}
	// A different or unknown model cannot provide comparable usage for this invocation.
	if (
		metadata.modelId === undefined ||
		metadata.modelId !== liveModelId ||
		liveContextTokens === undefined
	) {
		return metadata;
	}
	return { ...metadata, contextTokens: liveContextTokens };
}

/** Applies current projection savings only while the selected invocation remains active. */
function withLiveProjectionSavedTokens(
	metadata: InvocationMetadata | undefined,
	state: LogicalSession["state"],
	liveProjectionSavedTokens: number | undefined,
): InvocationMetadata | undefined {
	// Terminal metadata remains authoritative after the coordinator commits the final invocation state.
	if (metadata === undefined || state !== "active") {
		return metadata;
	}
	if (liveProjectionSavedTokens !== undefined) {
		return {
			...metadata,
			projectionSavedTokens: liveProjectionSavedTokens,
		};
	}
	if (metadata.projectionSavedTokens === undefined) {
		return metadata;
	}
	// An active clear removes a stale prefix without changing context usage or final metadata.
	const { projectionSavedTokens: _clearedProjectionSavedTokens, ...cleared } =
		metadata;
	return cleared;
}

/** Resolves one projected node by stable identity. */
export function findProjectionNode(
	view: ManagementProjectionView,
	stableKey: string | null,
): ProjectionNode | undefined {
	return view.nodes.find((node) => node.stableKey === stableKey);
}

/** Formats one configured keybinding without hardcoding its active key. */
function bindingHint(
	keybindings: KeybindingsManager,
	keybinding: Keybinding,
	description: string,
): string {
	const key = keybindings.getKeys(keybinding)[0];
	return key === undefined ? "" : rawKeyHint(key, description);
}

/** Calculates the two inner pane widths from the complete terminal width. */
function widePaneWidths(width: number): {
	readonly hierarchy: number;
	readonly conversation: number;
} {
	const available = width - OUTER_BORDER_WIDTH - PANE_SEPARATOR_WIDTH;
	const hierarchyPaneMinimum = HIERARCHY_MIN_WIDTH + SCROLL_COLUMN_WIDTH;
	const conversationPaneMinimum = CONVERSATION_MIN_WIDTH + SCROLL_COLUMN_WIDTH;
	const hierarchy = Math.max(
		hierarchyPaneMinimum,
		Math.min(
			Math.floor(available / HIERARCHY_WIDTH_DIVISOR),
			available - conversationPaneMinimum,
		),
	);
	return { hierarchy, conversation: available - hierarchy };
}

/** Formats two configured directional bindings as one compact action hint. */
function bindingPairHint(
	keybindings: KeybindingsManager,
	first: Keybinding,
	second: Keybinding,
	description: string,
): string {
	const keys = [
		keybindings.getKeys(first)[0],
		keybindings.getKeys(second)[0],
	].filter((key) => key !== undefined);
	return keys.length === 0 ? "" : rawKeyHint(keys.join("/"), description);
}

/** Creates one width-exact horizontal border. */
function border(left: string, right: string, width: number): string {
	return `${left}${"─".repeat(Math.max(0, width - OUTER_BORDER_WIDTH))}${right}`;
}

/** Crops public Pi Editor rows around its hardware cursor while preserving boundaries. */
function cropEditorViewport(
	lines: readonly string[],
	rowBudget: number,
): string[] {
	const height = Math.max(0, Math.min(rowBudget, lines.length));
	if (height === lines.length) {
		return [...lines];
	}
	if (height === 0) {
		return [];
	}
	const cursorIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	const currentIndex = cursorIndex >= 0 ? cursorIndex : lines.length - 2;
	if (height === 1) {
		return [lines[Math.max(0, currentIndex)] ?? ""];
	}
	const bottomBoundary = lines.at(-1) ?? "";
	if (height === 2) {
		return [lines[Math.max(0, currentIndex)] ?? "", bottomBoundary];
	}
	const contentHeight = height - 2;
	const maximumStart = Math.max(1, lines.length - 1 - contentHeight);
	const start = Math.max(
		1,
		Math.min(currentIndex - contentHeight + 1, maximumStart),
	);
	return [
		lines[0] ?? "",
		...lines.slice(start, start + contentHeight),
		bottomBoundary,
	];
}

/** Creates one border track only when the pane has hidden content. */
function createScrollTrack(
	metrics: ScrollMetrics,
	startRow: number,
	loading = false,
): ScrollTrack | undefined {
	if (loading) {
		return metrics.viewport <= 0
			? undefined
			: { startRow, length: metrics.viewport, loading: true };
	}
	const thumb = calculateScrollThumb(metrics, metrics.viewport);
	return thumb === undefined
		? undefined
		: { startRow, length: metrics.viewport, loading: false, thumb };
}

/** Pads or clips one line to an exact pane width. */
function padToWidth(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Pads a viewport without creating a scroll percentage row. */
function padRows(
	rows: readonly string[],
	height: number,
	width: number,
): readonly string[] {
	return Array.from({ length: height }, (_, index) =>
		padToWidth(rows[index] ?? "", width),
	);
}
