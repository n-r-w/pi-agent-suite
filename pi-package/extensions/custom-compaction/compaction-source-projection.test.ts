import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { collectMissingProjectionCandidates } from "./compaction-source-projection";

/** Creates one linked message entry. */
function messageEntry(
	id: string,
	parentId: string | null,
	message: AgentMessage,
): SessionEntry {
	return { type: "message", id, parentId, timestamp: "t", message };
}

/** Creates one assistant turn containing the named tool call. */
function assistantMessage(toolCallId: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} },
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

/** Creates one successful text tool result. */
function toolResultMessage(
	toolCallId: string,
	text: string,
): Extract<AgentMessage, { role: "toolResult" }> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

test("selects only effective edited candidates inside the discarded range", () => {
	const editedRaw = toolResultMessage("edited-call", "raw edited target");
	const omittedRaw = toolResultMessage("omitted-call", "omitted ".repeat(100));
	const branchEntries: SessionEntry[] = [
		messageEntry("assistant-edited", null, assistantMessage("edited-call")),
		messageEntry("result-edited", "assistant-edited", editedRaw),
		messageEntry(
			"assistant-omitted",
			"result-edited",
			assistantMessage("omitted-call"),
		),
		messageEntry("result-omitted", "assistant-omitted", omittedRaw),
		messageEntry(
			"assistant-small",
			"result-omitted",
			assistantMessage("small-call"),
		),
		messageEntry(
			"result-small",
			"assistant-small",
			toolResultMessage("small-call", "small"),
		),
		messageEntry(
			"assistant-retained",
			"result-small",
			assistantMessage("retained-call"),
		),
		messageEntry(
			"result-retained",
			"assistant-retained",
			toolResultMessage("retained-call", "retained ".repeat(100)),
		),
		{
			type: "context_edit",
			id: "omit",
			parentId: "result-retained",
			timestamp: "t",
			targetId: "result-omitted",
			replacement: null,
		},
		{
			type: "context_edit",
			id: "replace",
			parentId: "omit",
			timestamp: "t",
			targetId: "result-edited",
			replacement: { content: "edited ".repeat(100) },
		},
	];
	const event = {
		branchEntries,
		preparation: {
			messagesToSummarize: [
				assistantMessage("edited-call"),
				toolResultMessage("edited-call", "edited ".repeat(100)),
				assistantMessage("small-call"),
				toolResultMessage("small-call", "small"),
			],
			turnPrefixMessages: [],
		},
	} as unknown as SessionBeforeCompactEvent;

	const candidates = collectMissingProjectionCandidates(event, new Map(), 20);

	expect(
		candidates.map(({ id, message, text }) => ({
			id,
			toolCallId: message.toolCallId,
			contentKind: message.content[0]?.type,
			text,
		})),
	).toEqual([
		{
			id: "result-edited",
			toolCallId: "edited-call",
			contentKind: "text",
			text: "edited ".repeat(100),
		},
	]);
	expect(editedRaw.content).toEqual([
		{ type: "text", text: "raw edited target" },
	]);
	expect(omittedRaw.content).toEqual([
		{ type: "text", text: "omitted ".repeat(100) },
	]);
});
