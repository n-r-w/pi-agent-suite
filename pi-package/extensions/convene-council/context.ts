import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolCall } from "@mariozechner/pi-ai";
import { escapeUTF8 } from "entities";
import { replayContextProjection } from "../../shared/context-projection";
import type {
	CouncilContext,
	ParticipantId,
	ParticipantRunner,
	ParticipantRuntime,
	ParticipantState,
} from "./types";

/** Renders parent-session evidence as first-turn participant task context. */
export function renderExternalContextPackage(
	messages: readonly AgentMessage[],
	toolCallId: string,
): string {
	const toolCalls = collectVisibleToolCalls(messages, toolCallId);
	const blocks = messages.flatMap((message) =>
		renderContextMessage(message, toolCallId, toolCalls),
	);
	return ["<context>", ...blocks, "</context>"].join("\n");
}

/** Records tool-call arguments that can explain later tool results. */
function collectVisibleToolCalls(
	messages: readonly AgentMessage[],
	filteredToolCallId: string,
): ReadonlyMap<string, ToolCall> {
	const toolCalls = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "toolCall" && block.id !== filteredToolCallId) {
				toolCalls.set(block.id, block);
			}
		}
	}
	return toolCalls;
}

/** Converts one parent-session message into zero or more context evidence blocks. */
function renderContextMessage(
	message: AgentMessage,
	filteredToolCallId: string,
	toolCalls: ReadonlyMap<string, ToolCall>,
): string[] {
	switch (message.role) {
		case "user":
			return renderTextBlock("user", renderContent(message.content));
		case "assistant":
			return renderTextBlock("assistant", renderAssistantText(message));
		case "toolResult":
			return message.toolCallId === filteredToolCallId
				? []
				: [renderToolResult(message, toolCalls.get(message.toolCallId))];
		case "branchSummary":
		case "compactionSummary":
			return renderTextBlock("summary", message.summary);
		case "custom":
			return renderTextBlock("user", renderContent(message.content));
		case "bashExecution":
			return message.excludeFromContext === true
				? []
				: [renderBashExecution(message)];
	}
}

/** Renders a text wrapper only when it carries participant-useful content. */
function renderTextBlock(tag: string, content: string): string[] {
	const trimmedContent = content.trim();
	return trimmedContent.length === 0
		? []
		: [`<${tag}>\n${escapeUTF8(trimmedContent)}\n</${tag}>`];
}

/** Renders user-like content as text plus media markers. */
function renderContent(
	content: Extract<AgentMessage, { role: "user" }>["content"],
): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) =>
			block.type === "text" ? block.text : `[image: ${block.mimeType}]`,
		)
		.join("\n");
}

/** Renders assistant visible text while omitting thinking and standalone tool calls. */
function renderAssistantText(
	message: Extract<AgentMessage, { role: "assistant" }>,
): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** Renders one tool result as evidence and attaches matching call arguments when available. */
function renderToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	toolCall: ToolCall | undefined,
): string {
	const lines = [
		`<tool name="${escapeUTF8(message.toolName)}" status="${message.isError ? "error" : "ok"}">`,
	];
	if (toolCall !== undefined) {
		lines.push(
			"<args>",
			escapeUTF8(JSON.stringify(toolCall.arguments)),
			"</args>",
		);
	}
	lines.push(
		"<result>",
		escapeUTF8(renderContent(message.content)),
		"</result>",
		"</tool>",
	);
	return lines.join("\n");
}

/** Normalizes interactive shell entries into the same tool evidence shape as bash tool results. */
function renderBashExecution(
	message: Extract<AgentMessage, { role: "bashExecution" }>,
): string {
	return [
		`<tool name="bash" status="${message.exitCode === 0 ? "ok" : "error"}">`,
		"<args>",
		escapeUTF8(JSON.stringify({ command: message.command })),
		"</args>",
		"<result>",
		escapeUTF8(message.output),
		"</result>",
		"</tool>",
	].join("\n");
}

/** Builds parent-session evidence for the first participant prompt. */
export async function buildExternalCouncilContextPackage(options: {
	readonly ctx: CouncilContext;
	readonly toolCallId: string;
	readonly loadedSkillRoots: readonly string[];
}): Promise<string> {
	const projectedMessages = await replayContextProjection({
		branchEntries: options.ctx.sessionManager.getBranch(),
		cwd: options.ctx.cwd,
		loadedSkillRoots: options.loadedSkillRoots,
	});
	return renderExternalContextPackage(projectedMessages, options.toolCallId);
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
