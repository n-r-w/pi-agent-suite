import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/** Creates one session message entry. */
export function messageEntry(
	id: string,
	message: Message | AgentMessage,
	parentId: string | null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "t",
		message,
	} as SessionEntry;
}

/** Creates a user message fixture. */
export function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

/** Creates an assistant message that calls convene_council. */
export function councilToolCallMessage(): AssistantMessage {
	return toolCallMessage([
		{
			type: "toolCall",
			id: "call-council",
			name: "convene_council",
			arguments: { question: "question" },
		},
	]);
}

/** Creates an assistant message with arbitrary tool calls. */
export function toolCallMessage(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "fake-api",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** Creates a tool result message fixture with pairing metadata. */
export function toolResultMessage(
	toolCallId: string,
	text: string,
	toolName = "convene_council",
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
		timestamp: 3,
	};
}

/** Creates one extension-owned projection state entry. */
export function projectionStateEntry(
	id: string,
	projectedEntryId: string,
	placeholder: string,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "t",
		customType: "context-projection",
		data: { projectedEntries: [{ entryId: projectedEntryId, placeholder }] },
	} as SessionEntry;
}
