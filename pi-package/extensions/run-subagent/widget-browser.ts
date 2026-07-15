import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	formatSubagentContextUsage,
	formatSubagentProjectionStatus,
} from "./progress";
import {
	createSubagentWidgetFactory,
	SUBAGENT_WIDGET_KEY,
	type SubagentWidgetState,
} from "./widget";
import { formatElapsedMs } from "./widget-lines";
import {
	formatSubagentInvocationIdentity,
	formatSubagentWidgetIdentity,
	type SubagentWidgetNode,
} from "./widget-tree";

/** Internal SelectList value that clears explicit widget ownership. */
export const AUTOMATIC_SUBAGENT_VIEW = "__automatic_subagent_view__";
/** Maximum list rows shown before SelectList scrolls around the selection. */
const MAX_VISIBLE_SUBAGENT_ITEMS = 10;
/** Minimum label column width that keeps short semantic identities readable. */
const MIN_PRIMARY_COLUMN_WIDTH = 32;
/** Maximum label column width that reserves space for live status descriptions. */
const MAX_PRIMARY_COLUMN_WIDTH = 72;

/** Supplies colors without coupling browser behavior to the complete Pi theme. */
export interface SubagentBrowserTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Describes browser callbacks and state required by the focused list component. */
export interface SubagentBrowserListOptions {
	readonly state: SubagentWidgetState;
	readonly theme: SubagentBrowserTheme;
	readonly onSelect: (childSessionId: string | undefined) => void;
	readonly onCancel: () => void;
	readonly requestRender: () => void;
}

/** Controls the focused custom component across command, progress, and session events. */
interface SubagentBrowserController {
	open(ctx: ExtensionContext): Promise<void>;
	refresh(): void;
	close(): void;
}

/** Distinguishes explicit automatic selection from cancellation without state changes. */
type SubagentBrowserSelection =
	| { readonly kind: "automatic" }
	| { readonly kind: "session"; readonly childSessionId: string }
	| { readonly kind: "cancel" };

/** Retains only the live list and its idempotent dialog completion action. */
interface ActiveSubagentBrowser {
	readonly list: SubagentBrowserList;
	close(): void;
}

/** Owns one focused browser while exposing command and progress lifecycle operations. */
class SubagentBrowserControllerImpl implements SubagentBrowserController {
	private activeBrowser: ActiveSubagentBrowser | undefined;

	/** Binds browser state and widget redraws to the extension configuration. */
	public constructor(
		private readonly state: SubagentWidgetState,
		private readonly lineBudget: number,
		private readonly onPinChange: (childSessionId: string | undefined) => void,
	) {}

	/** Opens the focused list and applies only explicit session or Automatic selection. */
	public async open(ctx: ExtensionContext): Promise<void> {
		if (
			ctx.mode !== "tui" ||
			ctx.hasUI === false ||
			typeof ctx.ui.custom !== "function"
		) {
			ctx.ui.notify(
				"Subagent browser requires interactive TUI mode",
				"warning",
			);
			return;
		}

		// Only one focused browser can own keyboard input in the current session.
		this.activeBrowser?.close();
		let openedBrowser: ActiveSubagentBrowser | undefined;
		let selection: SubagentBrowserSelection;
		try {
			selection = await this.promptForSelection(ctx, (active) => {
				openedBrowser = active;
				this.activeBrowser = active;
			});
		} finally {
			if (this.activeBrowser === openedBrowser) {
				this.activeBrowser = undefined;
			}
		}
		if (selection.kind === "cancel") {
			return;
		}

		this.state.pinnedChildSessionId =
			selection.kind === "session" ? selection.childSessionId : undefined;
		this.onPinChange(this.state.pinnedChildSessionId);
		ctx.ui.setWidget(
			SUBAGENT_WIDGET_KEY,
			createSubagentWidgetFactory(this.state, this.lineBudget),
		);
	}

	/** Refreshes descriptions only while the focused browser remains active. */
	public refresh(): void {
		this.activeBrowser?.list.refresh();
	}

	/** Completes the focused browser as cancellation without changing the pin. */
	public close(): void {
		const browser = this.activeBrowser;
		this.activeBrowser = undefined;
		browser?.close();
	}

	/** Creates the Pi custom component and reports its active lifecycle handle. */
	private promptForSelection(
		ctx: ExtensionContext,
		onOpen: (browser: ActiveSubagentBrowser) => void,
	): Promise<SubagentBrowserSelection> {
		return ctx.ui.custom<SubagentBrowserSelection>(
			(tui, theme, _keybindings, done) => {
				let completed = false;
				const finish = (result: SubagentBrowserSelection): void => {
					if (completed) {
						return;
					}
					completed = true;
					done(result);
				};
				const list = new SubagentBrowserList({
					state: this.state,
					theme,
					onSelect: (childSessionId) =>
						finish(
							childSessionId === undefined
								? { kind: "automatic" }
								: { kind: "session", childSessionId },
						),
					onCancel: () => finish({ kind: "cancel" }),
					requestRender: () => tui.requestRender(),
				});
				const active: ActiveSubagentBrowser = {
					list,
					close: () => finish({ kind: "cancel" }),
				};
				onOpen(active);
				return {
					render: (width) => list.render(width),
					invalidate: () => list.invalidate(),
					handleInput: (data) => list.handleInput(data),
					dispose: () => {
						if (this.activeBrowser === active) {
							this.activeBrowser = undefined;
						}
					},
				};
			},
		);
	}
}

/** Creates the browser lifecycle controller for one extension session. */
export function createSubagentBrowserController(
	state: SubagentWidgetState,
	lineBudget: number,
	onPinChange: (childSessionId: string | undefined) => void,
): SubagentBrowserController {
	return new SubagentBrowserControllerImpl(state, lineBudget, onPinChange);
}

/** Builds the stable flattened item list shown by the focused browser. */
export function createSubagentBrowserItems(
	state: SubagentWidgetState,
): SelectItem[] {
	const items: SelectItem[] = [
		{
			value: AUTOMATIC_SUBAGENT_VIEW,
			label: "Automatic view",
			description: "Prioritize failed, running, and completed work",
		},
	];
	for (const root of state.roots) {
		appendBrowserItems({ items, parent: undefined, depth: 0 }, root);
	}
	return items;
}

/** Carries branch ownership while flattening the logical-session tree. */
interface BrowserAppendContext {
	readonly items: SelectItem[];
	readonly parent: SubagentWidgetNode | undefined;
	readonly depth: number;
}

/** Appends one depth-first branch with a bounded root-relative level label. */
function appendBrowserItems(
	context: BrowserAppendContext,
	node: SubagentWidgetNode,
): void {
	const identity = formatSubagentWidgetIdentity(node);
	context.items.push({
		value: node.childSessionId,
		label: `${identity} · ${context.depth === 0 ? "Root" : `Depth ${context.depth}`}`,
		description: formatBrowserDescription(node, context.parent),
	});
	for (const child of node.children) {
		appendBrowserItems(
			{ ...context, parent: node, depth: context.depth + 1 },
			child,
		);
	}
}

/** Formats changing status details and bounded direct-parent ownership. */
function formatBrowserDescription(
	node: SubagentWidgetNode,
	parent: SubagentWidgetNode | undefined,
): string {
	const parts = [formatBrowserStatus(node), formatElapsedMs(node.elapsedMs)];
	if (parent !== undefined) {
		parts.push(
			`Parent: ${formatSubagentInvocationIdentity(parent.agentId, parent.sessionId, parent.taskName)}`,
		);
	}
	const projection = formatSubagentProjectionStatus(
		node.contextProjectionStatus,
	);
	const context = formatSubagentContextUsage(node.contextUsage);
	if (projection !== undefined) {
		parts.push(projection);
	}
	if (context !== undefined) {
		parts.push(context);
	}
	if (node.activity !== undefined) {
		parts.push(node.activity);
	}
	return parts.join(" · ");
}

/** Converts terminal states into concise browser descriptions. */
function formatBrowserStatus(node: SubagentWidgetNode): string {
	if (node.status === "succeeded") {
		return "done";
	}
	return node.status;
}

/** Owns SelectList recreation while retaining selection by child-session identity. */
export class SubagentBrowserList implements Component {
	private items: SelectItem[];
	private itemsFingerprint: string;
	private selectedValue: string;
	private selectList: SelectList;

	/** Creates the browser with the pinned session selected, or Automatic view by default. */
	public constructor(private readonly options: SubagentBrowserListOptions) {
		this.items = createSubagentBrowserItems(options.state);
		this.itemsFingerprint = fingerprintItems(this.items);
		this.selectedValue =
			options.state.pinnedChildSessionId ?? AUTOMATIC_SUBAGENT_VIEW;
		this.selectList = this.createSelectList(this.items);
		this.restoreSelection();
	}

	/** Refreshes live descriptions without changing the selected session. */
	public refresh(): void {
		const items = createSubagentBrowserItems(this.options.state);
		const fingerprint = fingerprintItems(items);
		if (fingerprint === this.itemsFingerprint) {
			return;
		}

		this.selectedValue =
			this.selectList.getSelectedItem()?.value ?? this.selectedValue;
		this.items = items;
		this.itemsFingerprint = fingerprint;
		this.selectList = this.createSelectList(items);
		this.restoreSelection();
		this.options.requestRender();
	}

	/** Renders the focused browser inside Pi's custom component area. */
	public render(width: number): string[] {
		const border = new DynamicBorder((text: string) =>
			this.options.theme.fg("accent", text),
		);
		return [
			...border.render(width),
			...new Text(
				this.options.theme.fg("accent", this.options.theme.bold("Subagents")),
				1,
				0,
			).render(width),
			...this.selectList.render(width),
			...new Text(
				this.options.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
				1,
				0,
			).render(width),
			...border.render(width),
		];
	}

	/** Clears child rendering caches after theme changes. */
	public invalidate(): void {
		this.selectList.invalidate();
	}

	/** Delegates supported keyboard input to the standard SelectList. */
	public handleInput(data: string): void {
		this.selectList.handleInput(data);
		this.options.requestRender();
	}

	/** Creates the standard list with callbacks bound to current browser state. */
	private createSelectList(items: SelectItem[]): SelectList {
		const selectList = new SelectList(
			items,
			Math.min(items.length, MAX_VISIBLE_SUBAGENT_ITEMS),
			{
				selectedPrefix: (text) => this.options.theme.fg("accent", text),
				selectedText: (text) => this.options.theme.fg("accent", text),
				description: (text) => this.options.theme.fg("muted", text),
				scrollInfo: (text) => this.options.theme.fg("dim", text),
				noMatch: (text) => this.options.theme.fg("warning", text),
			},
			{
				minPrimaryColumnWidth: MIN_PRIMARY_COLUMN_WIDTH,
				maxPrimaryColumnWidth: MAX_PRIMARY_COLUMN_WIDTH,
			},
		);
		selectList.onSelectionChange = (item) => {
			this.selectedValue = item.value;
		};
		selectList.onSelect = (item) => {
			this.options.onSelect(
				item.value === AUTOMATIC_SUBAGENT_VIEW ? undefined : item.value,
			);
		};
		selectList.onCancel = this.options.onCancel;
		return selectList;
	}

	/** Restores selection by child session and returns to Automatic view when it vanished. */
	private restoreSelection(): void {
		const selectedIndex = this.items.findIndex(
			(item) => item.value === this.selectedValue,
		);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
			return;
		}

		this.selectedValue = AUTOMATIC_SUBAGENT_VIEW;
		this.selectList.setSelectedIndex(0);
	}
}

/** Detects all label and description changes that require SelectList recreation. */
function fingerprintItems(items: readonly SelectItem[]): string {
	return JSON.stringify(items);
}
