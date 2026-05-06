import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolCall } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type {
	CouncilContext,
	ParticipantId,
	ParticipantRunner,
	ParticipantRuntime,
	ParticipantState,
} from "./types";

interface AssistantContextChild {
	readonly kind: "text" | "thinking";
	readonly content: string;
}

type ContextBlock =
	| { readonly kind: "user"; readonly content: string }
	| { readonly kind: "custom"; readonly content: string }
	| {
			readonly kind: "assistant";
			readonly children: readonly AssistantContextChild[];
	  }
	| { readonly kind: "tool"; readonly content: string };

/** Renders raw active-branch evidence as the participant context-file body. */
export function renderExternalContextPackage(
	entries: readonly SessionEntry[],
	toolCallId: string,
): string {
	const toolCalls = collectVisibleToolCalls(entries, toolCallId);
	const blocks = mergeAdjacentBlocks(
		entries.flatMap((entry) =>
			renderContextEntry(entry, toolCallId, toolCalls),
		),
	).map(renderContextBlock);
	return ["<context>", ...blocks, "</context>"].join("\n");
}

/** Records visible tool-call arguments before later tool-result rendering. */
function collectVisibleToolCalls(
	entries: readonly SessionEntry[],
	filteredToolCallId: string,
): ReadonlyMap<string, ToolCall> {
	const toolCalls = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && block.id !== filteredToolCallId) {
				toolCalls.set(block.id, block);
			}
		}
	}
	return toolCalls;
}

/** Converts one active-branch entry into decision-context blocks. */
function renderContextEntry(
	entry: SessionEntry,
	filteredToolCallId: string,
	toolCalls: ReadonlyMap<string, ToolCall>,
): ContextBlock[] {
	switch (entry.type) {
		case "message":
			return renderContextMessage(entry.message, filteredToolCallId, toolCalls);
		case "custom_message": {
			const content = renderTextualContent(entry.content);
			return content.length === 0 ? [] : [{ kind: "custom", content }];
		}
		case "compaction":
		case "branch_summary":
		case "custom":
		case "label":
		case "session_info":
		case "model_change":
		case "thinking_level_change":
			return [];
	}
}

/** Converts one parent-session message into zero or more context evidence blocks. */
function renderContextMessage(
	message: AgentMessage,
	filteredToolCallId: string,
	toolCalls: ReadonlyMap<string, ToolCall>,
): ContextBlock[] {
	switch (message.role) {
		case "user": {
			const content = renderTextualContent(message.content);
			return content.length === 0 ? [] : [{ kind: "user", content }];
		}
		case "assistant": {
			const children = mergeAdjacentAssistantChildren(
				message.content.flatMap((block): AssistantContextChild[] => {
					if (block.type === "text") {
						return block.text.length === 0
							? []
							: [{ kind: "text", content: block.text }];
					}
					if (block.type === "thinking") {
						return block.thinking.length === 0
							? []
							: [{ kind: "thinking", content: block.thinking }];
					}
					return [];
				}),
			);
			return children.length === 0 ? [] : [{ kind: "assistant", children }];
		}
		case "toolResult":
			return message.toolCallId === filteredToolCallId
				? []
				: [
						{
							kind: "tool",
							content: renderToolResult(
								message,
								toolCalls.get(message.toolCallId),
							),
						},
					];
		case "custom":
			return [];
		case "branchSummary":
		case "compactionSummary":
			return [];
		case "bashExecution":
			return message.excludeFromContext === true
				? []
				: [{ kind: "tool", content: renderBashExecution(message) }];
	}
}

/** Extracts stored text while skipping image blocks without artificial markers. */
function renderTextualContent(
	content: Extract<AgentMessage, { role: "user" }>["content"],
): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** Merges adjacent same-kind actor blocks while preserving tool boundaries. */
function mergeAdjacentBlocks(blocks: readonly ContextBlock[]): ContextBlock[] {
	const merged: ContextBlock[] = [];
	for (const block of blocks) {
		const previous = merged.at(-1);
		if (previous === undefined || previous.kind !== block.kind) {
			merged.push(block);
			continue;
		}
		if (block.kind === "tool") {
			merged.push(block);
			continue;
		}
		if (previous.kind === "assistant" && block.kind === "assistant") {
			merged[merged.length - 1] = {
				kind: "assistant",
				children: mergeAdjacentAssistantChildren([
					...previous.children,
					...block.children,
				]),
			};
			continue;
		}
		if (previous.kind === "user" && block.kind === "user") {
			merged[merged.length - 1] = {
				kind: "user",
				content: mergeText(previous.content, block.content),
			};
			continue;
		}
		if (previous.kind === "custom" && block.kind === "custom") {
			merged[merged.length - 1] = {
				kind: "custom",
				content: mergeText(previous.content, block.content),
			};
		}
	}
	return merged;
}

/** Merges adjacent assistant text or thinking segments without crossing segment kinds. */
function mergeAdjacentAssistantChildren(
	children: readonly AssistantContextChild[],
): AssistantContextChild[] {
	const merged: AssistantContextChild[] = [];
	for (const child of children) {
		const previous = merged.at(-1);
		if (previous === undefined || previous.kind !== child.kind) {
			merged.push(child);
			continue;
		}
		merged[merged.length - 1] = {
			kind: previous.kind,
			content: mergeText(previous.content, child.content),
		};
	}
	return merged;
}

/** Adds one structural newline between merged evidence fragments for LLM readability. */
function mergeText(left: string, right: string): string {
	return `${left}\n${right}`;
}

/** Converts one merged context block into the XML-like reference document. */
function renderContextBlock(block: ContextBlock): string {
	switch (block.kind) {
		case "user":
			return renderTextBlock("user", block.content);
		case "custom":
			return renderTextBlock("custom", block.content);
		case "assistant":
			return [
				"<assistant>",
				...block.children.map((child) =>
					renderTextBlock(child.kind, child.content),
				),
				"</assistant>",
			].join("\n");
		case "tool":
			return block.content;
	}
}

/** Renders one text wrapper only when it carries participant-useful content. */
function renderTextBlock(tag: string, content: string): string {
	return `<${tag}>\n${escapeContextText(content)}\n</${tag}>`;
}

/** Escapes only fake section starts in readable text nodes. */
function escapeContextText(value: string): string {
	return value.replaceAll("<", "&lt;");
}

/** Escapes values that live inside XML-like attributes. */
function escapeContextAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");
}

/** Renders one tool result as evidence and attaches matching call arguments when available. */
function renderToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	toolCall: ToolCall | undefined,
): string {
	const lines = [
		`<tool name="${escapeContextAttribute(message.toolName)}" status="${message.isError ? "error" : "ok"}">`,
	];
	if (toolCall !== undefined) {
		lines.push(
			"<args>",
			escapeContextText(JSON.stringify(toolCall.arguments)),
			"</args>",
		);
	}
	lines.push(
		"<result>",
		escapeContextText(renderTextualContent(message.content)),
		"</result>",
		"</tool>",
	);
	return lines.join("\n");
}

/** Normalizes interactive shell entries into the same tool evidence shape as bash tool results. */
function renderBashExecution(
	message: Extract<AgentMessage, { role: "bashExecution" }>,
): string {
	const attributes = [
		'name="bash"',
		`status="${message.exitCode === 0 && message.cancelled !== true ? "ok" : "error"}"`,
		...(message.exitCode === undefined
			? []
			: [`exitCode="${escapeContextAttribute(String(message.exitCode))}"`]),
		...(message.cancelled === undefined
			? []
			: [`cancelled="${escapeContextAttribute(String(message.cancelled))}"`]),
		...(message.truncated === undefined
			? []
			: [`truncated="${escapeContextAttribute(String(message.truncated))}"`]),
	];
	return [
		`<tool ${attributes.join(" ")}>`,
		"<args>",
		escapeContextText(JSON.stringify({ command: message.command })),
		"</args>",
		"<result>",
		escapeContextText(message.output),
		"</result>",
		...(message.fullOutputPath === undefined
			? []
			: [
					"<fullOutputPath>",
					escapeContextText(message.fullOutputPath),
					"</fullOutputPath>",
				]),
		"</tool>",
	].join("\n");
}

/** Builds parent-session evidence for the first participant prompt. */
export async function buildExternalCouncilContextPackage(options: {
	readonly ctx: CouncilContext;
	readonly toolCallId: string;
}): Promise<string> {
	return renderExternalContextPackage(
		options.ctx.sessionManager.getBranch(),
		options.toolCallId,
	);
}

/** Creates the initial participant state with an isolated conversation history. */
export function createParticipantState(
	id: ParticipantId,
	runtime: ParticipantRuntime,
	runner: ParticipantRunner,
): ParticipantState {
	return {
		id,
		runtime,
		runner,
		history: [],
		reviewedOpponent: false,
	};
}
