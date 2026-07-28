import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
		});
		return box.render(width);
	}
}

/** Contains chronological public Pi components and tool expansion owners. */
interface ConversationComposition {
	readonly components: readonly Component[];
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
	const components: Component[] = [];
	const tools: ToolExecutionComponent[] = [];
	const expandables: ExpandableComponent[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	let latestAssistant: AssistantMessage | undefined;
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			const component = createCustomComponent(entry, options);
			components.push(component);
			expandables.push(component);
			continue;
		}
		const message = entry.message;
		switch (message.role) {
			case "user": {
				const component = createUserComponent(message, options);
				components.push(component);
				expandables.push(component);
				break;
			}
			case "assistant": {
				latestAssistant = message;
				components.push(
					new AssistantMessageComponent(
						message,
						false,
						options.markdownTheme,
						undefined,
						0,
					),
				);
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
					components.push(component);
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
	private expanded: boolean;
	private scrollTop = 0;
	private followBottom = true;
	private lastHeight = 1;
	private lastTotalRows = 0;
	private disposed = false;

	public constructor(private readonly options: ConversationCompositionOptions) {
		this.expanded = options.expanded;
		this.composition = composeConversation([], options);
	}

	/** Replaces the selected active branch and optionally follows its latest row. */
	public setEntries(
		entries: readonly ConversationProjectionEntry[],
		resetToBottom: boolean,
	): void {
		if (this.disposed) {
			return;
		}
		const wasFollowing = this.followBottom;
		this.composition = composeConversation(entries, {
			...this.options,
			expanded: this.expanded,
		});
		this.followBottom = resetToBottom || wasFollowing;
	}

	/** Toggles every tool and custom message through its public expanded state. */
	public setExpanded(expanded: boolean): void {
		if (this.disposed || expanded === this.expanded) {
			return;
		}
		this.expanded = expanded;
		for (const component of this.composition.expandables) {
			component.setExpanded(expanded);
		}
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
		const lines = this.composition.components.flatMap((component) =>
			component.render(width),
		);
		this.lastTotalRows = lines.length;
		const maximum = Math.max(0, lines.length - height);
		this.scrollTop = this.followBottom
			? maximum
			: Math.max(0, Math.min(this.scrollTop, maximum));
		this.followBottom = this.scrollTop === maximum;
		return lines.slice(this.scrollTop, this.scrollTop + height);
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
	}

	/** Invalidates public child components after a theme change. */
	public invalidate(): void {
		for (const component of this.composition.components) {
			component.invalidate();
		}
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
	const component = new CustomMessageComponent(
		message,
		entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE
			? renderSubagentFeedback
			: undefined,
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
