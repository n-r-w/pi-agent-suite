import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	MessageRenderer,
	MessageRenderOptions,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	KNOWLEDGE_OUTCOME_CUSTOM_TYPE,
	renderKnowledgeOutcome,
} from "../../../shared/knowledge-outcome-renderer";
import { SUBAGENT_HISTORY_CUSTOM_TYPE } from "../persistence.ts";
import type { ConversationProjectionEntry } from "../projection";
import { renderPrompt } from "../semantic-layout.ts";
import { renderSubagentFeedback } from "../semantic-rendering.ts";
import type { ScrollMetrics } from "./scroll-indicator";

/** Resolves one tool to its public Pi presentation definition. */
interface ConversationToolPresentation {
	resolve(toolName: string): {
		readonly category: "builtin" | "package" | "unknown";
		readonly definition: ToolDefinition | undefined;
	};
}

/** Supplies public Pi components and presentation dependencies. */
interface ConversationCompositionOptions {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly markdownTheme: MarkdownTheme;
	readonly cwd: string;
	readonly tools: ConversationToolPresentation;
	readonly expanded: boolean;
}

type CustomMessageInput = ConstructorParameters<
	typeof CustomMessageComponent
>[0];

interface ExpandableComponent extends Component {
	setExpanded(expanded: boolean): void;
}

/** Couples one public Pi component with a stable projected-entry row identity. */
interface OwnedConversationComponent {
	readonly key: string;
	readonly component: Component;
}

/** Preserves the owning component and local row for viewport anchoring. */
interface RenderedConversationRow {
	readonly componentKey: string;
	readonly componentRow: number;
	readonly text: string;
}

/** Identifies one visible row independently from its changing absolute offset. */
interface ConversationRowAnchor {
	readonly componentKey: string;
	readonly componentRow: number;
}

/** Keeps the loading sentinel outside every persisted Pi entry identity. */
const EARLIER_HISTORY_COMPONENT_KEY = "management:earlier-history";

/** Identifies shell-history zones that are valid only in Pi's top-level transcript. */
const SHELL_INTEGRATION_ZONE_MARKERS = [
	"\u001b]133;A\u0007",
	"\u001b]133;B\u0007",
	"\u001b]133;C\u0007",
] as const;

/** Prevents nested transcript rows from changing the terminal's global shell history. */
function removeShellIntegrationZones(text: string): string {
	let result = text;
	// Remove only Pi's semantic shell zones while preserving styling and hyperlinks.
	for (const marker of SHELL_INTEGRATION_ZONE_MARKERS) {
		result = result.replaceAll(marker, "");
	}
	return result;
}

/** Renders one initial or steering prompt with the shared conversation expansion state. */
class PromptMessageComponent implements ExpandableComponent {
	private expanded: boolean;

	public constructor(
		private readonly text: string,
		private readonly theme: Theme,
		expanded: boolean,
	) {
		this.expanded = expanded;
	}

	/** Applies the screen-local expansion state to this prompt. */
	public setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	/** Invalidates no cached rows because each render derives text from current width. */
	public invalidate(): void {}

	/** Keeps previews bounded while preserving the standard user-message background. */
	public render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		const box = new Box(0, 1, (line) => this.theme.bg("userMessageBg", line));
		box.addChild({
			render: (innerWidth: number) => [
				...renderPrompt(this.text, innerWidth, this.theme, this.expanded),
			],
			invalidate: () => {},
		});
		return box.render(width);
	}
}

/** Contains chronological public Pi components and tool expansion owners. */
interface ConversationComposition {
	readonly components: readonly OwnedConversationComponent[];
	readonly tools: readonly ExpandableComponent[];
	readonly expandables: readonly ExpandableComponent[];
	readonly metadata: {
		readonly modelId?: string;
		readonly contextTokens?: number;
	};
}

/** Maps projected active-branch entries to public Pi presentation components. */
function composeConversation(
	entries: readonly ConversationProjectionEntry[],
	options: ConversationCompositionOptions,
): ConversationComposition {
	const components: OwnedConversationComponent[] = [];
	const tools: ToolExecutionComponent[] = [];
	const expandables: ExpandableComponent[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	let latestAssistant: AssistantMessage | undefined;
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			const component = createCustomComponent(entry, options);
			components.push({ key: `${entry.id}:custom`, component });
			expandables.push(component);
			continue;
		}
		const message = entry.message;
		switch (message.role) {
			case "user": {
				const component = createUserComponent(message, options);
				components.push({ key: `${entry.id}:user`, component });
				expandables.push(component);
				break;
			}
			case "assistant": {
				latestAssistant = message;
				components.push({
					key: `${entry.id}:assistant`,
					component: new AssistantMessageComponent(
						message,
						false,
						options.markdownTheme,
						undefined,
						0,
					),
				});
				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}
					const resolution = options.tools.resolve(content.name);
					const component = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{},
						resolution.definition,
						options.tui,
						options.cwd,
					);
					component.setArgsComplete();
					component.setExpanded(options.expanded);
					components.push({
						key: `${entry.id}:tool:${content.id}`,
						component,
					});
					tools.push(component);
					expandables.push(component);
					pendingTools.set(content.id, component);
				}
				break;
			}
			case "toolResult":
				attachToolResult(message, pendingTools);
				break;
		}
	}
	return {
		components,
		tools,
		expandables,
		metadata: assistantMetadata(latestAssistant),
	};
}

/** Owns conversation line scrolling and screen-local tool expansion. */
export class ConversationPane {
	private composition: ConversationComposition;
	private entries: readonly ConversationProjectionEntry[] = Object.freeze([]);
	private expanded: boolean;
	private scrollTop = 0;
	private followBottom = true;
	private lastHeight = 1;
	private lastTotalRows = 0;
	private lastRenderedRows: readonly RenderedConversationRow[] = [];
	private cachedWidth: number | undefined;
	private cachedRows: readonly RenderedConversationRow[] | undefined;
	private pendingAnchor: ConversationRowAnchor | undefined;
	private complete = true;
	private disposed = false;

	public constructor(private readonly options: ConversationCompositionOptions) {
		this.expanded = options.expanded;
		this.composition = composeConversation([], options);
	}

	/** Replaces the selected active branch and optionally follows its latest row. */
	public setEntries(
		entries: readonly ConversationProjectionEntry[],
		resetToBottom: boolean,
		complete: boolean,
	): void {
		if (this.disposed) {
			return;
		}
		if (entries === this.entries && complete === this.complete) {
			if (resetToBottom) {
				this.pendingAnchor = undefined;
				this.followBottom = true;
			}
			return;
		}
		const wasFollowing = this.followBottom;
		this.pendingAnchor =
			resetToBottom || wasFollowing ? undefined : this.currentRowAnchor();
		this.composition = composeConversation(entries, {
			...this.options,
			expanded: this.expanded,
		});
		this.entries = entries;
		this.complete = complete;
		this.followBottom = resetToBottom || wasFollowing;
		this.clearRenderedRows();
	}

	/** Toggles every tool and custom message through its public expanded state. */
	public setExpanded(expanded: boolean): void {
		if (this.disposed || expanded === this.expanded) {
			return;
		}
		this.pendingAnchor = this.followBottom
			? undefined
			: this.currentRowAnchor();
		this.expanded = expanded;
		for (const component of this.composition.expandables) {
			component.setExpanded(expanded);
		}
		this.clearRenderedRows();
	}

	/** Scrolls by visual rows without changing session selection. */
	public scrollLines(delta: number): boolean {
		if (this.disposed || delta === 0) {
			return false;
		}
		const maximum = Math.max(0, this.lastTotalRows - this.lastHeight);
		const next = Math.max(0, Math.min(maximum, this.scrollTop + delta));
		if (next === this.scrollTop) {
			return false;
		}
		this.scrollTop = next;
		this.followBottom = next === maximum;
		return true;
	}

	/** Scrolls by one current viewport page. */
	public scrollPage(delta: -1 | 1): boolean {
		return this.scrollLines(delta * Math.max(1, this.lastHeight));
	}

	/** Renders the current conversation viewport. */
	public render(width: number, height: number): string[] {
		if (this.disposed || width <= 0 || height <= 0) {
			return [];
		}
		this.lastHeight = height;
		const rows = this.renderRows(width);
		this.lastTotalRows = rows.length;
		const maximum = Math.max(0, rows.length - height);
		if (this.followBottom) {
			this.scrollTop = maximum;
		} else if (this.pendingAnchor !== undefined) {
			const anchoredOffset = rows.findIndex(
				(row) =>
					row.componentKey === this.pendingAnchor?.componentKey &&
					row.componentRow === this.pendingAnchor.componentRow,
			);
			this.scrollTop =
				anchoredOffset < 0
					? Math.max(0, Math.min(this.scrollTop, maximum))
					: Math.min(anchoredOffset, maximum);
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maximum));
		}
		this.pendingAnchor = undefined;
		this.followBottom = this.scrollTop === maximum;
		this.lastRenderedRows = rows;
		return rows
			.slice(this.scrollTop, this.scrollTop + height)
			.map((row) => row.text);
	}

	/** Measures public Pi component rows without changing the current viewport. */
	public getLoadedContentRows(width: number): number {
		if (this.disposed || width <= 0) {
			return 0;
		}
		return this.renderRows(width).length - (this.complete ? 0 : 1);
	}

	/** Exposes the last rendered viewport for border-only scroll presentation. */
	public getScrollMetrics(): ScrollMetrics {
		return {
			offset: this.scrollTop,
			total: this.lastTotalRows,
			viewport: this.lastHeight,
		};
	}

	/** Reports whether new content should continue following the latest row. */
	public isAtBottom(): boolean {
		return this.followBottom;
	}

	/** Returns metadata available from the selected active branch. */
	public getMetadata(): ConversationComposition["metadata"] {
		return this.composition.metadata;
	}

	/** Releases component references owned by this overlay instance. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.composition = {
			components: [],
			tools: [],
			expandables: [],
			metadata: {},
		};
		this.entries = Object.freeze([]);
		this.lastRenderedRows = [];
		this.clearRenderedRows();
		this.pendingAnchor = undefined;
	}

	/** Invalidates public child components after a theme change. */
	public invalidate(): void {
		for (const owned of this.composition.components) {
			owned.component.invalidate();
		}
		this.clearRenderedRows();
	}

	/** Renders stable row ownership once for each content revision and width. */
	private renderRows(width: number): readonly RenderedConversationRow[] {
		if (this.cachedWidth === width && this.cachedRows !== undefined) {
			return this.cachedRows;
		}
		const rows: RenderedConversationRow[] = [];
		if (!this.complete) {
			const label = "Loading earlier messages…";
			rows.push({
				componentKey: EARLIER_HISTORY_COMPONENT_KEY,
				componentRow: 0,
				text: this.options.theme.fg(
					"muted",
					label.slice(0, width).padEnd(width),
				),
			});
		}
		for (const owned of this.composition.components) {
			const componentRows = owned.component.render(width);
			for (const [componentRow, text] of componentRows.entries()) {
				rows.push({
					componentKey: owned.key,
					componentRow,
					text: removeShellIntegrationZones(text),
				});
			}
		}
		this.cachedWidth = width;
		this.cachedRows = rows;
		return rows;
	}

	/** Invalidates rows after content, expansion, theme, or width-sensitive state changes. */
	private clearRenderedRows(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
	}

	/** Captures the current top row before older components are prepended. */
	private currentRowAnchor(): ConversationRowAnchor | undefined {
		const row = this.lastRenderedRows[this.scrollTop];
		return row === undefined
			? undefined
			: {
					componentKey: row.componentKey,
					componentRow: row.componentRow,
				};
	}
}

/** Builds one public user component from visible text content. */
function createUserComponent(
	message: UserMessage,
	options: ConversationCompositionOptions,
): PromptMessageComponent {
	return new PromptMessageComponent(
		messageText(message.content),
		options.theme,
		options.expanded,
	);
}

/** Builds one public custom-message component without a private renderer lookup. */
function createCustomComponent(
	entry: Extract<ConversationProjectionEntry, { type: "custom_message" }>,
	options: ConversationCompositionOptions,
): CustomMessageComponent {
	const timestamp = Date.parse(entry.timestamp);
	const message: CustomMessageInput = {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
	};
	const renderer = resolveCustomMessageRenderer(entry.customType);
	const component = new CustomMessageComponent(
		message,
		renderer,
		options.markdownTheme,
		0,
	);
	component.setExpanded(options.expanded);
	return component;
}

/** Attaches a result to the matching tool call without adding a duplicate row. */
function attachToolResult(
	message: ToolResultMessage,
	pendingTools: ReadonlyMap<string, ToolExecutionComponent>,
): void {
	const component = pendingTools.get(message.toolCallId);
	if (component === undefined) {
		return;
	}
	component.updateResult(
		{
			content: message.content,
			details: message.details,
			isError: message.isError,
		},
		false,
	);
}

/** Returns the first persisted user prompt for the selected subagent session. */
export function readInitialPrompt(
	entries: readonly ConversationProjectionEntry[],
): string | undefined {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			return messageText(entry.message.content);
		}
	}
	return undefined;
}

/** Resolves the renderer for one custom-message entry type. */
function resolveCustomMessageRenderer(
	customType: string,
):
	| ((
			message: CustomMessageInput,
			options: MessageRenderOptions,
			theme: Theme,
	  ) => Component | undefined)
	| undefined {
	if (customType === SUBAGENT_HISTORY_CUSTOM_TYPE) {
		return renderSubagentFeedback;
	}
	if (customType === KNOWLEDGE_OUTCOME_CUSTOM_TYPE) {
		return renderKnowledgeOutcome;
	}
	return undefined;
}

/** Extracts visible text blocks while Pi's public user component owns wrapping. */
function messageText(content: UserMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

/** Returns model and context values reported by the latest assistant message. */
function assistantMetadata(
	message: AssistantMessage | undefined,
): ConversationComposition["metadata"] {
	if (message === undefined) {
		return {};
	}
	return {
		modelId: `${message.provider}/${message.model}`,
		contextTokens: message.usage.totalTokens,
	};
}
