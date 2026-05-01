import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { renderExternalContextPackage } from "./context";

/** Creates a user message for external context rendering tests. */
function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

/** Creates an assistant message with caller-controlled visible and hidden blocks. */
function assistantMessage(
	content: Extract<AgentMessage, { role: "assistant" }>["content"],
): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "fake-api",
		provider: "openai",
		model: "model",
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

/** Creates a tool result message for external context rendering tests. */
function toolResultMessage(options: {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly text: string;
	readonly isError?: boolean;
}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		content: [{ type: "text", text: options.text }],
		isError: options.isError ?? false,
		timestamp: 3,
	};
}

describe("convene-council external context package", () => {
	test("renders model-visible branch messages as compact context blocks", () => {
		// Purpose: parent conversation must become task evidence, not participant memory.
		// Input and expected output: user text, assistant visible text, a linked tool result, and a summary render as compact tags.
		// Edge case: assistant thinking and standalone tool-call blocks are omitted while linked tool arguments stay with the tool result.
		// Dependencies: pure renderer with no filesystem or model calls.
		const context = renderExternalContextPackage(
			[
				userMessage("Investigate council RPC"),
				assistantMessage([
					{ type: "text", text: "I will inspect the plan." },
					{ type: "thinking", thinking: "hidden reasoning" },
					{
						type: "toolCall",
						id: "call-read",
						name: "read",
						arguments: { path: "docs/ideas/convene-council-rpc-plan.md" },
					},
				]),
				toolResultMessage({
					toolCallId: "call-read",
					toolName: "read",
					text: "RPC plan text",
				}),
				{
					role: "branchSummary",
					fromId: "branch-a",
					summary: "Prior branch summary",
					timestamp: 4,
				} as AgentMessage,
			],
			"call-council-current",
		);

		expect(context).toBe(`<context>
<user>
Investigate council RPC
</user>
<assistant>
I will inspect the plan.
</assistant>
<tool name="read" status="ok">
<args>
{&quot;path&quot;:&quot;docs/ideas/convene-council-rpc-plan.md&quot;}
</args>
<result>
RPC plan text
</result>
</tool>
<summary>
Prior branch summary
</summary>
</context>`);
		expect(context).not.toContain("hidden reasoning");
		expect(context).not.toContain("tool_call");
	});

	test("filters only the current pending council call and matching result", () => {
		// Purpose: current tool mechanics must not appear as participant evidence, but previous council results remain useful evidence.
		// Input and expected output: previous completed council result is rendered; current pending call/result is removed.
		// Edge case: visible assistant text sharing the current tool-call message is preserved.
		// Dependencies: pure renderer with explicit tool call IDs.
		const context = renderExternalContextPackage(
			[
				assistantMessage([
					{
						type: "toolCall",
						id: "call-council-old",
						name: "convene_council",
						arguments: { question: "old question" },
					},
				]),
				toolResultMessage({
					toolCallId: "call-council-old",
					toolName: "convene_council",
					text: "old council answer",
				}),
				assistantMessage([
					{ type: "text", text: "Visible setup before current council." },
					{
						type: "toolCall",
						id: "call-council-current",
						name: "convene_council",
						arguments: { question: "current question" },
					},
				]),
				toolResultMessage({
					toolCallId: "call-council-current",
					toolName: "convene_council",
					text: "current pending result",
				}),
			],
			"call-council-current",
		);

		expect(context).toContain("old council answer");
		expect(context).toContain("Visible setup before current council.");
		expect(context).not.toContain("current question");
		expect(context).not.toContain("current pending result");
	});
});
