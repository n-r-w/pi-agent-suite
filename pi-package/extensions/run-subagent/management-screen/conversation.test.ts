import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
	getMarkdownTheme,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ConversationProjectionEntry } from "../projection";
import { createToolPresentationRegistry } from "../tool-rendering";
import { ConversationPane } from "./conversation";

/** Creates a public Pi session entry around one standard message. */
function messageEntry(
	id: string,
	parentId: string | null,
	message: UserMessage | AssistantMessage | ToolResultMessage,
): Extract<SessionEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

/** Creates one public user message with deterministic text. */
function userMessage(
	text: string,
	timestamp: number,
	withImage = false,
): UserMessage {
	return {
		role: "user",
		content: withImage
			? [
					{ type: "text", text },
					{ type: "image", data: "image-data", mimeType: "image/png" },
				]
			: text,
		timestamp,
	};
}

/** Creates one assistant message with built-in, package, and unknown tool calls. */
function assistantWithTools(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect each tool category." },
			{
				type: "toolCall",
				id: "tool-builtin",
				name: "read",
				arguments: { path: "one.ts" },
			},
			{
				type: "toolCall",
				id: "tool-package",
				name: "subagent_wait",
				arguments: { sessionIds: [1], timeoutMs: 1000 },
			},
			{
				type: "toolCall",
				id: "tool-unknown",
				name: "third_party_tool",
				arguments: { value: "unknown" },
			},
		],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: {
			input: 30_000,
			output: 4000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 34_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** Creates one public tool-result message for a prior assistant call. */
function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
	details?: unknown,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
		...(details === undefined ? {} : { details }),
	};
}

/** Creates one standard custom-message entry shown by Pi. */
function customEntry(
	parentId: string,
): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: "custom-1",
		parentId,
		timestamp: new Date(4).toISOString(),
		customType: "package-note",
		content: "Custom package note",
		display: true,
		details: { source: "test" },
	};
}

/** Creates one reopened durable feedback message with authoritative presentation details. */
function feedbackEntry(): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: "feedback-1",
		parentId: null,
		timestamp: new Date(5).toISOString(),
		customType: "subagents-v2-feedback",
		content: "Subagent 1 completed successfully:\nRendered semantic output.",
		display: true,
		details: {
			feedbackId: "feedback-1",
			invocationId: "invocation-1",
			sessionKey: {
				ownerPiSessionId: "owner-1",
				ownerLocalSessionId: 1,
			},
			status: "success",
			output: "Rendered semantic output.",
			presentation: {
				agentId: "SubAgentCoder",
				taskName: "Trace semantic rendering",
				invocationMetadata: {
					startedAtMs: 1_700_000_000_000,
					elapsedMs: 2_400,
					modelId: "openai/test-model",
					thinking: "high",
					contextWindow: 128_000,
					contextTokens: 58_000,
					projectionSavedTokens: 20_000,
				},
			},
		},
	};
}

/** Builds public presentation dependencies without a terminal process. */
function options(): ConstructorParameters<typeof ConversationPane>[0] {
	initTheme(undefined, false);
	const tui = { requestRender(): void {} } as TUI;
	const owner = SessionManager.inMemory("/tmp/subagents-v2-conversation");
	const tools = createToolPresentationRegistry("/tmp", owner);
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	return {
		tui,
		theme,
		markdownTheme: getMarkdownTheme(),
		cwd: "/tmp",
		tools,
		expanded: false,
	};
}

describe("management conversation", () => {
	test("renders the selected active branch through public Pi components", () => {
		// Purpose: selected conversation entries must reuse Pi's user, assistant, tool, and custom-message components.
		// Inputs and expected output: one active branch includes all three tool presentation categories and one custom message in chronological order.
		// Edge case: tool results attach by call ID while the package and unknown tools retain their presentation definitions.
		// Dependencies: package tool presentation registry and public Pi message components.
		// ARRANGE: build one chronological branch with tool calls followed by their results.
		const assistant = assistantWithTools();
		const entries: ConversationProjectionEntry[] = [
			messageEntry("user-1", null, userMessage("Inspect tools", 1, true)),
			messageEntry("assistant-1", "user-1", assistant),
			messageEntry(
				"result-1",
				"assistant-1",
				toolResult("tool-builtin", "read", "builtin result"),
			),
			messageEntry(
				"result-2",
				"result-1",
				toolResult(
					"tool-package",
					"subagent_wait",
					'{"outcome":"timeout"}',
					false,
					{ outcome: "timeout" },
				),
			),
			messageEntry(
				"result-3",
				"result-2",
				toolResult("tool-unknown", "third_party_tool", "unknown result"),
			),
			customEntry("result-3"),
		];

		// ACT: update the public conversation pane and render its chronological output.
		const pane = new ConversationPane(options());
		pane.setEntries(entries, true, true);
		const rendered = pane.render(60, 1_000).join("\n");
		const metadata = pane.getMetadata();

		// ASSERT: standard messages, all tool categories, custom content, and assistant metadata are preserved.
		expect({
			modelId: metadata.modelId,
			contextTokens: metadata.contextTokens,
			userText: rendered.includes("Inspect tools"),
			assistantText: rendered.includes("I will inspect each tool category."),
			builtinCall: rendered.includes("one.ts"),
			packageResult: rendered.includes("timeout"),
			unknownResult: rendered.includes("unknown result"),
			customText: rendered.includes("Custom package note"),
		}).toEqual({
			modelId: "openai-codex/gpt-5.6-sol",
			contextTokens: 34_000,
			userText: true,
			assistantText: true,
			builtinCall: true,
			packageResult: true,
			unknownResult: true,
			customText: true,
		});
		pane.dispose();
	});

	test("collapses and expands every initial or steering prompt", () => {
		// Purpose: initial prompts and later steering messages must share the configured conversation expansion state.
		// Inputs and expected output: collapsed user content uses a bounded normalized preview and expanded content restores the full formatted prompt.
		// Edge case: the final line remains absent from the collapsed viewport but visible after expansion.
		// Dependencies: projected user messages and the shared V1-style prompt renderer.
		const prompt = [
			...Array.from(
				{ length: 30 },
				(_, index) => `Prompt line ${index + 1} with enough text to wrap.`,
			),
			"FINAL_PROMPT_TAIL",
		].join("\n");
		const entry = messageEntry("prompt-1", null, userMessage(prompt, 1));
		const pane = new ConversationPane(options());

		pane.setEntries([entry], true, true);
		const collapsed = pane.render(40, 100).join("\n");
		pane.setExpanded(true);
		const expanded = pane.render(40, 100).join("\n");

		expect({
			collapsedHint: collapsed.includes("more lines"),
			collapsedTail: collapsed.includes("FINAL_PROMPT_TAIL"),
			expandedSection: expanded.includes("--- Prompt ---"),
			expandedTail: expanded.includes("FINAL_PROMPT_TAIL"),
		}).toEqual({
			collapsedHint: true,
			collapsedTail: false,
			expandedSection: true,
			expandedTail: true,
		});
		pane.dispose();
	});

	test("replays durable feedback through the shared semantic renderer", () => {
		// Purpose: reopened management history must use the same semantic feedback layout as normal owner history.
		// Inputs and expected output: one durable feedback snapshot renders source identity, runtime, context, duration, logical name, and output.
		// Edge case: the model-visible custom-message content is not rendered as a duplicate raw history block.
		// Dependencies: public CustomMessageComponent and the Subagents V2 feedback renderer reference.
		const pane = new ConversationPane(options());
		pane.setEntries([feedbackEntry()], true, true);
		const rendered = pane.render(100, 1_000).join("\n");
		const plainRendered = stripVTControlCharacters(rendered);

		expect(plainRendered).toContain(
			"subagent feedback #1 · SubAgentCoder · openai/test-model/high · 2s · ~20k/58k/128k",
		);
		expect(rendered).toContain("Trace semantic rendering");
		expect(rendered).toContain("Rendered semantic output.");
		expect(rendered).not.toContain("[subagents-v2-feedback]");
		expect(rendered.split("Rendered semantic output.")).toHaveLength(2);
		pane.dispose();
	});

	test("keeps a scrolled viewport fixed while following new content at bottom", () => {
		// Purpose: live conversation updates must follow latest content only while the user remains at the bottom.
		// Inputs and expected output: an update after scrolling up preserves old visible rows, while the same update from the bottom reveals the new message.
		// Edge case: page and line scrolling operate on Pi-rendered visual rows rather than message counts.
		// Dependencies: public UserMessageComponent wrapping and a fixed-width viewport.
		// ARRANGE: render enough user messages to overflow a three-row viewport.
		const pane = new ConversationPane(options());
		const initial = ["one", "two", "three", "four", "five"].map((text, index) =>
			messageEntry(
				`user-${index}`,
				index === 0 ? null : `user-${index - 1}`,
				userMessage(text, index),
			),
		);
		pane.setEntries(initial, true, true);
		pane.render(30, 3);

		// ACT: update once while scrolled away, then once while returned to the bottom.
		pane.scrollLines(-2);
		const awayBefore = pane.render(30, 3);
		pane.setEntries(
			[...initial, messageEntry("user-5", "user-4", userMessage("six", 6))],
			false,
			true,
		);
		const awayAfter = pane.render(30, 3);
		pane.scrollLines(1000);
		pane.setEntries(
			[
				...initial,
				messageEntry("user-5", "user-4", userMessage("six", 6)),
				messageEntry("user-6", "user-5", userMessage("seven", 7)),
			],
			false,
			true,
		);
		const bottomAfter = pane.render(30, 3);

		// ASSERT: away rows stay fixed and bottom-follow reveals the latest content without a percentage label.
		expect({
			awayFixed: awayAfter.join("\n") === awayBefore.join("\n"),
			latestVisible: bottomAfter.some((line) => line.includes("seven")),
			atBottom: pane.isAtBottom(),
			percentageHidden: bottomAfter.every((line) => !line.includes("%")),
		}).toEqual({
			awayFixed: true,
			latestVisible: true,
			atBottom: true,
			percentageHidden: true,
		});
	});

	test("keeps the visible row anchored when older entries are prepended", () => {
		// Purpose: background hydration must add earlier history without moving text the user is reading.
		// Inputs and expected output: a scrolled recent suffix gains two older entries while the three visible rows remain identical.
		// Edge case: numeric scroll offsets change after prepending, so identity and component-row anchoring must own stability.
		// Dependencies: public user-message rendering and the production conversation viewport.
		const pane = new ConversationPane(options());
		const recent = ["three", "four", "five", "six", "seven"].map(
			(text, index) =>
				messageEntry(
					`recent-${index}`,
					index === 0 ? null : `recent-${index - 1}`,
					userMessage(text, index + 3),
				),
		);
		pane.setEntries(recent, true, false);
		pane.render(30, 3);
		pane.scrollLines(-2);
		const before = pane.render(30, 3);
		const older = [
			messageEntry("older-1", null, userMessage("one", 1)),
			messageEntry("older-2", "older-1", userMessage("two", 2)),
		];

		pane.setEntries([...older, ...recent], false, true);
		const after = pane.render(30, 3);

		expect(after).toEqual(before);
		pane.dispose();
	});

	test("reuses rendered conversation rows at an unchanged width", () => {
		// Purpose: unrelated hierarchy renders must not recompute every persisted conversation component.
		// Inputs and expected output: two renders at one width call the user-message background once, while a width change recomputes rows.
		// Edge case: the cached rows remain reusable when only the viewport height changes.
		// Dependencies: the production ConversationPane and one public user-message component.
		const base = options();
		let backgroundCalls = 0;
		const pane = new ConversationPane({
			...base,
			theme: {
				...base.theme,
				bg: (_color: string, text: string) => {
					backgroundCalls += 1;
					return text;
				},
			} as Theme,
		});
		const entry = messageEntry("cached", null, userMessage("cached", 1));
		const entries = [entry];
		pane.setEntries(entries, true, true);

		pane.render(50, 10);
		const firstRenderCalls = backgroundCalls;
		pane.setEntries(entries, false, true);
		pane.render(50, 5);
		expect(backgroundCalls).toBe(firstRenderCalls);
		pane.render(40, 5);
		expect(backgroundCalls).toBeGreaterThan(firstRenderCalls);
		pane.dispose();
	});

	test("shows an earlier-history sentinel only for incomplete previews", () => {
		// Purpose: users at the loaded upper boundary must see that more history is still loading.
		// Inputs and expected output: an incomplete suffix prepends one loading row, while the same complete branch removes it.
		// Edge case: the loading row is presentation state and must not become a session entry or Pi message component.
		// Dependencies: the production conversation viewport and theme text styling.
		const pane = new ConversationPane(options());
		const entry = messageEntry("latest", null, userMessage("latest", 1));

		pane.setEntries([entry], true, false);
		const loading = pane.render(50, 100).join("\n");
		pane.setEntries([entry], false, true);
		const complete = pane.render(50, 100).join("\n");

		expect(loading).toContain("Loading earlier messages");
		expect(complete).not.toContain("Loading earlier messages");
		pane.dispose();
	});
});
