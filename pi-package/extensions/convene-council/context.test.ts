import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildExternalCouncilContextPackage } from "./context";
import type { CouncilContext } from "./types";

/** Creates a session entry with one model-visible message. */
function messageEntry(
	id: string,
	message: AgentMessage,
	parentId: string | null,
): SessionEntry {
	return { type: "message", id, parentId, timestamp: "t", message };
}

/** Creates a user message for external context rendering tests. */
function userMessage(
	content: Extract<AgentMessage, { role: "user" }>["content"],
): AgentMessage {
	return { role: "user", content, timestamp: 1 };
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

/** Creates one bash execution message with coding-agent-only fields. */
function bashExecutionMessage(options: {
	readonly command: string;
	readonly output: string;
	readonly exitCode?: number;
	readonly cancelled?: boolean;
	readonly truncated?: boolean;
	readonly fullOutputPath?: string;
	readonly excludeFromContext?: boolean;
}): AgentMessage {
	return {
		role: "bashExecution",
		command: options.command,
		output: options.output,
		...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
		...(options.cancelled === undefined
			? {}
			: { cancelled: options.cancelled }),
		...(options.truncated === undefined
			? {}
			: { truncated: options.truncated }),
		...(options.fullOutputPath === undefined
			? {}
			: { fullOutputPath: options.fullOutputPath }),
		...(options.excludeFromContext === undefined
			? {}
			: { excludeFromContext: options.excludeFromContext }),
		timestamp: 4,
	} as unknown as AgentMessage;
}

/** Creates one custom message entry that participates in LLM context. */
function customMessageEntry(
	id: string,
	content: Extract<SessionEntry, { type: "custom_message" }>["content"],
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "t",
		customType: "test-custom-message",
		content,
		details: { hidden: true },
		display: true,
	};
}

/** Creates a context fake that exposes only active-branch data used by the renderer. */
function councilContext(entries: readonly SessionEntry[]): CouncilContext {
	return {
		cwd: "/tmp/project",
		model: undefined,
		sessionManager: {
			getBranch: () => [...entries],
		},
	} as unknown as CouncilContext;
}

describe("convene-council external context package", () => {
	test("includes applicable knowledge in the shared participant package", async () => {
		// Purpose: every participant must receive the same applicable knowledge through the external context file.
		// Input and expected output: one knowledge block is inserted inside the shared context package.
		// Edge case: the block remains separate from active-branch user content.
		// Dependencies: both participant runners read the same package returned by this builder.
		const context = await buildExternalCouncilContextPackage({
			ctx: councilContext([
				messageEntry("u1", userMessage("question context"), null),
			]),
			toolCallId: "call-current",
			knowledgeBlock: "<knowledge>council knowledge</knowledge>",
		});

		expect(context).toContain("<knowledge>council knowledge</knowledge>");
		expect(context.match(/<knowledge>/gu)).toHaveLength(1);
		expect(context.startsWith("<context>\n")).toBe(true);
		expect(context.endsWith("\n</context>")).toBe(true);
	});
	test("renders raw active-branch decision evidence without projection summaries or metadata", async () => {
		// Purpose: participant evidence must come from raw active-branch entries, not projection or summary substitution.
		// Input and expected output: adjacent user/custom text is merged, assistant thinking is included, and metadata-only entries are omitted.
		// Edge case: image blocks are skipped without markers while image paths in text remain visible, and projection-created custom messages are ignored.
		// Dependencies: pure renderer with a fake session manager branch.
		const context = await buildExternalCouncilContextPackage({
			ctx: councilContext([
				messageEntry("u1", userMessage('first user <line> & "quote"'), null),
				messageEntry("u2", userMessage("second user /tmp/image.png"), "u1"),
				messageEntry(
					"a1",
					assistantMessage([
						{ type: "text", text: "visible A" },
						{ type: "text", text: "visible B" },
						{ type: "thinking", thinking: "thinking A" },
						{ type: "thinking", thinking: "thinking B" },
						{ type: "text", text: "visible C" },
					]),
					"u2",
				),
				customMessageEntry(
					"c1",
					[
						{ type: "text", text: "custom text" },
						{ type: "image", data: "base64", mimeType: "image/png" },
					],
					"a1",
				),
				{
					type: "branch_summary",
					id: "s1",
					parentId: "c1",
					timestamp: "t",
					fromId: "u1",
					summary: "must not render",
				} as SessionEntry,
				{
					type: "custom",
					id: "state1",
					parentId: "s1",
					timestamp: "t",
					customType: "context-projection",
					data: { projectedEntries: [] },
				} as SessionEntry,
				messageEntry(
					"projected-custom-message",
					{
						role: "custom",
						customType: "projection-created",
						content: "projected custom role",
						display: true,
						timestamp: 5,
					} as unknown as AgentMessage,
					"state1",
				),
			]),
			toolCallId: "call-current",
		});

		expect(context).toBe(`<context>
<user>
first user &lt;line> & "quote"
second user /tmp/image.png
</user>
<assistant>
<text>
visible A
visible B
</text>
<thinking>
thinking A
thinking B
</thinking>
<text>
visible C
</text>
</assistant>
<custom>
custom text
</custom>
</context>`);
		expect(context).not.toContain("must not render");
		expect(context).not.toContain("context-projection");
		expect(context).not.toContain("projected custom role");
		expect(context).not.toContain("image/png");
		expect(context).not.toContain("base64");
	});

	test("renders tool results with matching arguments and filters the current council call", async () => {
		// Purpose: tool outputs must remain tied to the arguments that produced them while current council mechanics stay hidden.
		// Input and expected output: previous tool result keeps args; current convene_council call and result are absent.
		// Edge case: visible assistant text sharing the current tool-call message is preserved.
		// Dependencies: pure renderer with explicit tool call IDs.
		const context = await buildExternalCouncilContextPackage({
			ctx: councilContext([
				messageEntry(
					"a1",
					assistantMessage([
						{
							type: "toolCall",
							id: "call-read",
							name: "read",
							arguments: { path: "docs/plan.md" },
						},
					]),
					null,
				),
				messageEntry(
					"r1",
					toolResultMessage({
						toolCallId: "call-read",
						toolName: "read",
						text: "read result",
					}),
					"a1",
				),
				messageEntry(
					"a2",
					assistantMessage([
						{ type: "text", text: "visible setup before council" },
						{
							type: "toolCall",
							id: "call-current",
							name: "convene_council",
							arguments: { question: "current question" },
						},
					]),
					"r1",
				),
				messageEntry(
					"r2",
					toolResultMessage({
						toolCallId: "call-current",
						toolName: "convene_council",
						text: "current pending result",
					}),
					"a2",
				),
			]),
			toolCallId: "call-current",
		});

		expect(context).toContain(`<tool name="read" status="ok">
<args>
{"path":"docs/plan.md"}
</args>
<result>
read result
</result>
</tool>`);
		expect(context).toContain("visible setup before council");
		expect(context).not.toContain("current question");
		expect(context).not.toContain("current pending result");
		expect(context).not.toContain("convene_council");
	});

	test("escapes text tags lightly and keeps dangerous attribute values contained", async () => {
		// Purpose: context text must stay readable while fake section tags and attribute breakers remain contained.
		// Input and expected output: text keeps quotes and ampersands, fake tags escape only '<', and attribute quotes are escaped.
		// Edge case: tool names are attribute values, so they use stricter escaping than text nodes.
		// Dependencies: pure renderer with explicit tool names and text payloads.
		const context = await buildExternalCouncilContextPackage({
			ctx: councilContext([
				messageEntry(
					"a1",
					assistantMessage([
						{
							type: "toolCall",
							id: "call-dangerous",
							name: 'bad"&<tool>',
							arguments: { text: 'keep "quotes" & escape <fake>' },
						},
					]),
					null,
				),
				messageEntry(
					"r1",
					toolResultMessage({
						toolCallId: "call-dangerous",
						toolName: 'bad"&<tool>',
						text: 'raw & quote " ok </tool>',
					}),
					"a1",
				),
			]),
			toolCallId: "call-current",
		});

		expect(context).toContain(
			`<tool name="bad&quot;&amp;&lt;tool>" status="ok">`,
		);
		expect(context).toContain(
			`{"text":"keep \\"quotes\\" & escape &lt;fake>"}`,
		);
		expect(context).toContain(`raw & quote " ok &lt;/tool>`);
		expect(context).not.toContain("&quot;quotes&quot;");
	});

	test("renders bash execution status attributes and skips excluded bash context", async () => {
		// Purpose: bash entries must expose command status without leaking commands explicitly excluded from LLM context.
		// Input and expected output: visible bash output gets status attributes and full output path; excluded bash output is absent.
		// Edge case: cancelled non-zero commands are errors and fullOutputPath is rendered as result evidence.
		// Dependencies: pure renderer with coding-agent-only bash messages.
		const context = await buildExternalCouncilContextPackage({
			ctx: councilContext([
				messageEntry(
					"b1",
					bashExecutionMessage({
						command: "bun test",
						output: "failed output",
						exitCode: 1,
						cancelled: false,
						truncated: true,
						fullOutputPath: "/tmp/full-output.txt",
					}),
					null,
				),
				messageEntry(
					"b2",
					bashExecutionMessage({
						command: "secret command",
						output: "secret output",
						exitCode: 0,
						excludeFromContext: true,
					}),
					"b1",
				),
			]),
			toolCallId: "call-current",
		});

		expect(context).toContain(
			`<tool name="bash" status="error" exitCode="1" cancelled="false" truncated="true">`,
		);
		expect(context).toContain("bun test");
		expect(context).toContain("failed output");
		expect(context).toContain(
			"<fullOutputPath>\n/tmp/full-output.txt\n</fullOutputPath>",
		);
		expect(context).not.toContain("secret command");
		expect(context).not.toContain("secret output");
	});
});
