import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	Api,
	Context,
	AssistantMessage as LlmAssistantMessage,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import contextProjection from "../../../pi-package/extensions/context-projection/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const CUSTOM_TYPE = "context-projection";
const PLACEHOLDER = "[old tool result projected]";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface AppendEntryCall {
	readonly customType: string;
	readonly data: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly appendEntryCalls: AppendEntryCall[];
}

interface ContextUsageFake {
	readonly tokens: number | null;
	readonly contextWindow: number;
}

interface UiCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

interface CompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

interface CompletionFake {
	readonly calls: CompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<LlmAssistantMessage>;
}

interface ContextFake {
	readonly uiCalls: readonly UiCall[];
	readonly ctx: {
		readonly cwd: string;
		readonly hasUI: true;
		readonly ui: Record<string, unknown>;
		readonly model: Model<Api>;
		readonly modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined;
			getApiKeyAndHeaders(model: Model<Api>): Promise<{
				readonly ok: true;
				readonly apiKey?: string;
				readonly headers?: Record<string, string>;
			}>;
		};
		readonly sessionManager: {
			getBranch(): SessionEntry[];
			getEntries(): SessionEntry[];
			getLeafId(): string | null;
		};
		readonly signal: AbortSignal;
		getContextUsage(): ContextUsageFake | undefined;
	};
}

/** Creates the ExtensionAPI fake needed to observe hook registration and custom state writes. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const appendEntryCalls: AppendEntryCall[] = [];

	return {
		handlers,
		appendEntryCalls,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		appendEntry(customType: string, data: unknown): void {
			appendEntryCalls.push({ customType, data });
		},
		getThinkingLevel(): string {
			return "high";
		},
	} as ExtensionApiFake;
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-context-projection-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes context projection config into the project-owned config file. */
async function writeCustomConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "context-projection.json"),
		JSON.stringify(config),
	);
}

/** Writes the retired shared custom config file to prove this extension ignores it. */
async function writeLegacyCustomConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "custom.json"), JSON.stringify(config));
}

/** Creates valid projection config for tests that need the extension active. */
function createValidConfig(overrides?: Record<string, unknown>): unknown {
	return {
		enabled: true,
		projectionRemainingTokens: 100,
		keepRecentTurns: 1,
		keepRecentTurnsPercent: 0,
		minToolResultChars: 20,
		placeholder: PLACEHOLDER,
		projectionIgnoredTools: [],
		...overrides,
	};
}

/** Installs the extension and returns observable event handlers. */
function installContextProjectionTestHarness(dependencies?: {
	readonly completeSimple?: CompletionFake["completeSimple"];
}): {
	readonly pi: ExtensionApiFake;
	readonly sessionStartHandler: (event: unknown, ctx: unknown) => unknown;
	readonly beforeAgentStartHandler: (event: unknown, ctx: unknown) => unknown;
	readonly contextHandler: (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown> | unknown;
} {
	const pi = createExtensionApiFake();
	contextProjection(pi, dependencies);

	const sessionStartHandler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === "session_start",
	)?.handler;
	if (typeof sessionStartHandler !== "function") {
		throw new Error("expected session_start handler to be registered");
	}

	const beforeAgentStartHandler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === "before_agent_start",
	)?.handler;

	const contextHandler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === "context",
	)?.handler;
	if (typeof contextHandler !== "function") {
		throw new Error("expected context handler to be registered");
	}

	return {
		pi,
		sessionStartHandler: sessionStartHandler as (
			event: unknown,
			ctx: unknown,
		) => unknown,
		beforeAgentStartHandler:
			typeof beforeAgentStartHandler === "function"
				? (beforeAgentStartHandler as (event: unknown, ctx: unknown) => unknown)
				: () => undefined,
		contextHandler: contextHandler as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown> | unknown,
	};
}

/** Creates a context fake with branch entries, known usage, and UI call recording. */
function createContextFake(
	branchEntries: SessionEntry[],
	usage: ContextUsageFake | undefined = { tokens: 900, contextWindow: 1_000 },
	cwd = process.cwd(),
): ContextFake {
	const uiCalls: UiCall[] = [];
	const recordUiCall =
		(method: string) =>
		(...args: unknown[]): void => {
			uiCalls.push({ method, args });
		};

	const currentModel = createModel("openai", "current-model");

	return {
		uiCalls,
		ctx: {
			cwd,
			hasUI: true,
			model: currentModel,
			modelRegistry: {
				find(provider: string, modelId: string): Model<Api> | undefined {
					return createModel(provider, modelId);
				},
				async getApiKeyAndHeaders(): Promise<{
					readonly ok: true;
					readonly apiKey: string;
					readonly headers: Record<string, string>;
				}> {
					return {
						ok: true,
						apiKey: "summary-api-key",
						headers: { "x-summary": "enabled" },
					};
				},
			},
			ui: {
				theme: {
					fg(color: string, value: string): string {
						return `<${color}>${value}</${color}>`;
					},
				},
				notify: recordUiCall("notify"),
				setStatus: recordUiCall("setStatus"),
				setWidget: recordUiCall("setWidget"),
				setFooter: recordUiCall("setFooter"),
				setTitle: recordUiCall("setTitle"),
				setEditorText: recordUiCall("setEditorText"),
				custom: recordUiCall("custom"),
			},
			sessionManager: {
				getBranch(): SessionEntry[] {
					return branchEntries;
				},
				getEntries(): SessionEntry[] {
					return branchEntries;
				},
				getLeafId(): string | null {
					return branchEntries.at(-1)?.id ?? null;
				},
			},
			signal: new AbortController().signal,
			getContextUsage(): ContextUsageFake | undefined {
				return usage;
			},
		},
	};
}

/** Creates a model fixture for summary runtime tests. */
function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 4096,
		reasoning: true,
	} as Model<Api>;
}

/** Creates a completion fake that records summary requests and returns one text block. */
function createCompletionFake(
	text = "Summary: important projected result.",
): CompletionFake {
	const calls: CompletionCall[] = [];

	return {
		calls,
		async completeSimple<TApi extends Api>(
			model: Model<TApi>,
			context: Context,
			options?: SimpleStreamOptions,
		): Promise<LlmAssistantMessage> {
			calls.push({ model: model as Model<Api>, context, options });
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-responses",
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 1,
			};
		},
	};
}

/** Creates a message session entry and links it to the previous fixture entry. */
function messageEntry(
	id: string,
	message: AgentMessage,
	parentId: string | null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-01-01T00:00:${id}.000Z`,
		message,
	} as SessionEntry;
}

/** Creates an extension-owned custom entry that stores projected tool result IDs and their placeholders. */
function projectionStateEntry(
	id: string,
	projectedEntries: Array<{
		readonly entryId: string;
		readonly placeholder: string;
	}>,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: `2026-01-01T00:01:${id}.000Z`,
		customType: CUSTOM_TYPE,
		data: { projectedEntries },
	} as SessionEntry;
}

/** Creates a text user message fixture. */
function userMessage(text = "user prompt"): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

/** Creates an assistant message fixture that starts one bash tool-use turn. */
function assistantMessage(toolCallId: string): AssistantMessage {
	return assistantMessageWithContent([
		{
			type: "toolCall",
			id: toolCallId,
			name: "bash",
			arguments: { command: "echo test" },
		},
	]);
}

/** Creates an assistant message fixture that starts one read tool-use turn. */
function readAssistantMessage(
	toolCallId: string,
	path: string,
): AssistantMessage {
	return assistantMessageWithContent([
		{
			type: "toolCall",
			id: toolCallId,
			name: "read",
			arguments: { path },
		},
	]);
}

/** Creates an assistant message fixture without tool calls. */
function assistantTextMessage(text: string): AssistantMessage {
	return assistantMessageWithContent([{ type: "text", text }]);
}

/** Creates an assistant message fixture with shared provider metadata. */
function assistantMessageWithContent(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** Creates a tool result message fixture with all pairing and metadata fields. */
function toolResultMessage(
	toolCallId: string,
	text: string,
	overrides?: Partial<ToolResultMessage>,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { exitCode: 0, preserved: true },
		isError: false,
		timestamp: 3,
		...overrides,
	};
}

/** Builds the active message context from message entries in the fixture branch. */
function messagesFromBranch(
	branchEntries: readonly SessionEntry[],
): AgentMessage[] {
	return branchEntries.flatMap((entry) =>
		entry.type === "message" ? [entry.message] : [],
	);
}

describe("context-projection", () => {
	test("stays disabled when the context projection config file is missing", async () => {
		// Purpose: missing config must be the default disabled state and must not create projection errors or state writes.
		// Input and expected output: no config/context-projection.json file returns undefined and appends no custom entry.
		// Edge case: the tool result would be eligible if a valid enabled config existed.
		// Dependencies: this test uses an isolated pi agent directory and in-memory fakes.
		await withIsolatedAgentDir(async () => {
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry(
					"03",
					toolResultMessage("call-old", "old output ".repeat(5)),
					"02",
				),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toBeUndefined();
			expect(pi.appendEntryCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("publishes projection footer status for disabled, invalid, ready, and projected states", async () => {
		// Purpose: context-projection owns projection state and must publish compact footer text with approximate token savings.
		// Input and expected output: invalid uses error CP!, enabled ready uses plain ~0, projected entries use warning ~N, and disabled clears stale status.
		// Edge case: savings subtract the placeholder text that remains in provider context.
		// Dependencies: this test uses isolated config, a fake theme, and the context hook.
		await withIsolatedAgentDir(async (agentDir) => {
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const user = userMessage();
			const assistant = assistantMessage("call-old");
			const toolResult = toolResultMessage("call-old", "old output ".repeat(5));
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", assistant, "01"),
				messageEntry("03", toolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			await writeCustomConfig(agentDir, {
				enabled: true,
				projectionRemainingTokens: "invalid",
			});
			let result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);
			expect(result).toBeUndefined();
			expect(context.uiCalls.at(-1)).toEqual({
				method: "setStatus",
				args: ["context-projection", "<error>CP!</error>"],
			});

			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 1 }),
			);
			result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);
			expect(result).toBeUndefined();
			expect(context.uiCalls.at(-1)).toEqual({
				method: "setStatus",
				args: ["context-projection", "~0"],
			});

			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);
			expect(result).toEqual({
				messages: [
					user,
					assistant,
					{
						...toolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(context.uiCalls.at(-2)).toEqual({
				method: "setStatus",
				args: ["context-projection", "<warning>~5</warning>"],
			});
			expect(context.uiCalls.at(-1)).toEqual({
				method: "notify",
				args: ["Context projected: ~5 saved", "info"],
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [{ entryId: "03", placeholder: PLACEHOLDER }],
					},
				},
			]);

			await writeCustomConfig(agentDir, createValidConfig({ enabled: false }));
			result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);
			expect(result).toBeUndefined();
			expect(context.uiCalls.at(-1)).toEqual({
				method: "setStatus",
				args: ["context-projection", undefined],
			});
		});
	});

	test("publishes tokenizer-based reconstructed projection savings on session start", async () => {
		// Purpose: after reload, footer status must reflect branch-local persisted projection state instead of showing ready state.
		// Input and expected output: a stored projected entry with dense CJK text reports tokenizer savings instead of chars/4 savings.
		// Edge case: status is published before a new context hook runs.
		// Dependencies: isolated projection config, fake theme, and session_start handler.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const { sessionStartHandler } = installContextProjectionTestHarness();
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry(
					"03",
					toolResultMessage("call-old", "界".repeat(100)),
					"02",
				),
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: PLACEHOLDER }],
					"03",
				),
			];
			const context = createContextFake(branchEntries);

			await sessionStartHandler({ type: "session_start" }, context.ctx);

			expect(context.uiCalls.at(-1)).toEqual({
				method: "setStatus",
				args: ["context-projection", "<warning>~94</warning>"],
			});
		});
	});

	test("returns no context changes when remaining tokens are above the configured threshold", async () => {
		// Purpose: high free context space must preserve pi's provider context without state writes.
		// Input and expected output: remainingTokens 101 with threshold 100 returns undefined and appends no custom entry.
		// Edge case: all config fields are valid, so the no-op is caused only by the threshold check.
		// Dependencies: this test uses isolated config, in-memory ExtensionAPI fake, and session context fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry("03", toolResultMessage("call-old", "x".repeat(40)), "02"),
			];
			const context = createContextFake(branchEntries, {
				tokens: 899,
				contextWindow: 1_000,
			});

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toBeUndefined();
			expect(pi.appendEntryCalls).toEqual([]);
			expect(context.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "~0"],
				},
			]);
		});
	});

	test("projects only eligible old successful text tool results and preserves tool result shape", async () => {
		// Purpose: low remaining context must replace only old large successful text-only tool result content.
		// Input and expected output: first tool result is projected, second recent tool result is kept unchanged, and one custom state entry is appended.
		// Edge case: keepRecentTurns 1 protects the latest assistant tool-use turn.
		// Dependencies: this test observes provider-context copies and verifies stored session messages are unchanged.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const user = userMessage();
			const oldAssistant = assistantMessage("call-old");
			const oldToolResult = toolResultMessage(
				"call-old",
				"old output ".repeat(5),
			);
			const recentAssistant = assistantMessage("call-recent");
			const recentToolResult = toolResultMessage(
				"call-recent",
				"recent output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", oldAssistant, "01"),
				messageEntry("03", oldToolResult, "02"),
				messageEntry("04", recentAssistant, "03"),
				messageEntry("05", recentToolResult, "04"),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					oldAssistant,
					{
						...oldToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
					recentAssistant,
					recentToolResult,
				],
			});
			expect(messagesFromBranch(branchEntries)[2]).toBe(oldToolResult);
			expect(oldToolResult.content).toEqual([
				{ type: "text", text: "old output ".repeat(5) },
			]);
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [{ entryId: "03", placeholder: PLACEHOLDER }],
					},
				},
			]);
			expect(context.uiCalls).toEqual([
				{
					method: "notify",
					args: ["Projecting context: 0/1 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Projecting context: 1/1 tool results processed", "info"],
				},
				{
					method: "setStatus",
					args: ["context-projection", "<warning>~5</warning>"],
				},
				{
					method: "notify",
					args: ["Context projected: ~5 saved", "info"],
				},
			]);
		});
	});

	test("shows total saved tokens in footer and latest additional saved tokens in chat status", async () => {
		// Purpose: footer and chat status must not use the same metric after a session already has projected entries.
		// Input and expected output: one persisted projection plus one new projection makes footer show total savings and chat status show only the new savings.
		// Edge case: persisted projection is replayed while a new eligible tool result is discovered in the same context event.
		// Dependencies: isolated config, reconstructed projection state, context hook, and UI call recording.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const { pi, sessionStartHandler, contextHandler } =
				installContextProjectionTestHarness();
			const user = userMessage();
			const firstAssistant = assistantMessage("call-first");
			const firstToolResult = toolResultMessage(
				"call-first",
				"old output ".repeat(5),
			);
			const secondAssistant = assistantMessage("call-second");
			const secondToolResult = toolResultMessage(
				"call-second",
				"old output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", firstAssistant, "01"),
				messageEntry("03", firstToolResult, "02"),
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: PLACEHOLDER }],
					"03",
				),
				messageEntry("05", secondAssistant, "04"),
				messageEntry("06", secondToolResult, "05"),
			];
			const context = createContextFake(branchEntries);

			await sessionStartHandler({ type: "session_start" }, context.ctx);
			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					firstAssistant,
					{
						...firstToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
					secondAssistant,
					{
						...secondToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [{ entryId: "06", placeholder: PLACEHOLDER }],
					},
				},
			]);
			expect(context.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "<warning>~5</warning>"],
				},
				{
					method: "notify",
					args: ["Projecting context: 0/1 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Projecting context: 1/1 tool results processed", "info"],
				},
				{
					method: "setStatus",
					args: ["context-projection", "<warning>~10</warning>"],
				},
				{
					method: "notify",
					args: ["Context projected: ~5 saved", "info"],
				},
			]);
		});
	});

	test("uses a generated summary as the projection replacement for large projected tool results", async () => {
		// Purpose: summary-enabled projection should preserve a short factual result summary instead of a blind placeholder.
		// Input and expected output: one eligible tool result above the summary token threshold is replaced with the summary text and persisted with that replacement.
		// Edge case: summary uses separate system and user prompts, with the user instruction placed after the tool result data.
		// Dependencies: isolated config, custom prompt files, fake completion function, fake model registry, and context hook.
		await withIsolatedAgentDir(async (agentDir) => {
			const systemPromptFile = join(agentDir, "config", "summary-system.md");
			const userPromptFile = join(agentDir, "config", "summary-user.md");
			await mkdir(join(agentDir, "config"), { recursive: true });
			await writeFile(
				systemPromptFile,
				"You are responsible for summarizing tool results.",
			);
			await writeFile(
				userPromptFile,
				"<task>\nSummarize the tool result now.\n</task>",
			);
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					summary: {
						enabled: true,
						model: null,
						thinking: null,
						minToolResultTokens: 1,
						maxConcurrency: 1,
						systemPromptFile,
						userPromptFile,
					},
				}),
			);
			const completion = createCompletionFake(
				"Summary: command output proves the projection summary path.",
			);
			const { pi, contextHandler } = installContextProjectionTestHarness({
				completeSimple: completion.completeSimple,
			});
			const user = userMessage();
			const assistant = assistantMessage("call-old");
			const toolResult = toolResultMessage(
				"call-old",
				"important projected result ".repeat(200),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", assistant, "01"),
				messageEntry("03", toolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					assistant,
					{
						...toolResult,
						content: [
							{
								type: "text",
								text: '<tool_result full_result="omitted" content="summary">\nSummary: command output proves the projection summary path.\n</tool_result>',
							},
						],
					},
				],
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [
							{
								entryId: "03",
								placeholder:
									'<tool_result full_result="omitted" content="summary">\nSummary: command output proves the projection summary path.\n</tool_result>',
							},
						],
					},
				},
			]);
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.model.id).toBe("current-model");
			expect(completion.calls[0]?.context.systemPrompt).toBe(
				"You are responsible for summarizing tool results.",
			);
			const summaryUserMessage = JSON.stringify(
				completion.calls[0]?.context.messages,
			);
			expect(summaryUserMessage).toContain("<tool_call>");
			expect(summaryUserMessage).toContain("echo test");
			expect(summaryUserMessage).toContain("</tool_call>");
			expect(summaryUserMessage).toContain("<tool_result>");
			expect(summaryUserMessage).toContain("</tool_result>");
			expect(summaryUserMessage).toContain("<task>");
			expect(summaryUserMessage).toContain("Summarize the tool result now.");
			expect(summaryUserMessage.indexOf("<tool_call>")).toBeLessThan(
				summaryUserMessage.indexOf("<tool_result>"),
			);
			expect(summaryUserMessage.indexOf("<tool_result>")).toBeLessThan(
				summaryUserMessage.indexOf("<task>"),
			);
			expect(completion.calls[0]?.options).toMatchObject({
				apiKey: "summary-api-key",
				headers: { "x-summary": "enabled" },
				reasoning: "high",
			});
		});
	});

	test("falls back to placeholder when generated summary replacement is not smaller than the original tool result", async () => {
		// Purpose: summary mode must not persist replacements that increase or fail to reduce provider context size.
		// Input and expected output: one short eligible tool result receives a longer generated summary, so placeholder is persisted instead.
		// Edge case: summary call succeeds but wrapped summary replacement has zero token savings.
		// Dependencies: isolated config, fake completion function, and tokenizer-based projection savings.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					summary: {
						enabled: true,
						minToolResultTokens: 1,
						maxConcurrency: 1,
					},
				}),
			);
			const completion = createCompletionFake("long summary ".repeat(200));
			const { pi, contextHandler } = installContextProjectionTestHarness({
				completeSimple: completion.completeSimple,
			});
			const user = userMessage();
			const assistant = assistantMessage("call-old");
			const toolResult = toolResultMessage(
				"call-old",
				"small result ".repeat(3),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", assistant, "01"),
				messageEntry("03", toolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					assistant,
					{
						...toolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(completion.calls).toHaveLength(1);
			expect(pi.appendEntryCalls[0]?.data).toEqual({
				projectedEntries: [{ entryId: "03", placeholder: PLACEHOLDER }],
			});
		});
	});

	test("retries failed summary requests before falling back to placeholder", async () => {
		// Purpose: transient provider failures must not immediately lose summary value when retries are configured.
		// Input and expected output: first summary call throws, retry succeeds, and the generated summary is persisted.
		// Edge case: retry delay is configured to zero so the behavior is deterministic and fast.
		// Dependencies: isolated config, fake completion function, and summary retry loop.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					summary: {
						enabled: true,
						minToolResultTokens: 1,
						maxConcurrency: 1,
						retryCount: 1,
						retryDelayMs: 0,
					},
				}),
			);
			const completion = createCompletionFake("Recovered summary");
			let callCount = 0;
			const completeSimple: CompletionFake["completeSimple"] = async (
				model,
				context,
				options,
			) => {
				callCount += 1;
				if (callCount === 1) {
					throw new Error("temporary provider failure");
				}

				return completion.completeSimple(model, context, options);
			};
			const { pi, contextHandler } = installContextProjectionTestHarness({
				completeSimple,
			});
			const user = userMessage();
			const assistant = assistantMessage("call-old");
			const toolResult = toolResultMessage(
				"call-old",
				"large old result ".repeat(200),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", assistant, "01"),
				messageEntry("03", toolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(callCount).toBe(2);
			expect(pi.appendEntryCalls[0]?.data).toEqual({
				projectedEntries: [
					{
						entryId: "03",
						placeholder:
							'<tool_result full_result="omitted" content="summary">\nRecovered summary\n</tool_result>',
					},
				],
			});
		});
	});

	test("limits concurrent projection summary requests and keeps projected entries in branch order", async () => {
		// Purpose: summary generation must use bounded concurrency so projection does not start all provider calls at once.
		// Input and expected output: three projected tool results with maxConcurrency 2 produce three summaries and never exceed two active calls.
		// Edge case: state persistence stays in branch order even though summary calls complete independently.
		// Dependencies: fake completion function with async delay and context hook projection discovery.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					summary: {
						enabled: true,
						minToolResultTokens: 1,
						maxConcurrency: 2,
					},
				}),
			);
			let activeCalls = 0;
			let maxActiveCalls = 0;
			let nextSummary = 0;
			const completion: CompletionFake = {
				calls: [],
				async completeSimple<TApi extends Api>(
					model: Model<TApi>,
					context: Context,
					options?: SimpleStreamOptions,
				): Promise<LlmAssistantMessage> {
					completion.calls.push({
						model: model as Model<Api>,
						context,
						options,
					});
					activeCalls += 1;
					maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
					await new Promise((resolve) => setTimeout(resolve, 5));
					activeCalls -= 1;
					nextSummary += 1;
					return {
						role: "assistant",
						content: [{ type: "text", text: `Summary ${nextSummary}` }],
						api: "openai-responses",
						provider: model.provider,
						model: model.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: 1,
					};
				},
			};
			const { pi, contextHandler } = installContextProjectionTestHarness({
				completeSimple: completion.completeSimple,
			});
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-1"), "01"),
				messageEntry(
					"03",
					toolResultMessage("call-1", "one ".repeat(200)),
					"02",
				),
				messageEntry("04", assistantMessage("call-2"), "03"),
				messageEntry(
					"05",
					toolResultMessage("call-2", "two ".repeat(200)),
					"04",
				),
				messageEntry("06", assistantMessage("call-3"), "05"),
				messageEntry(
					"07",
					toolResultMessage("call-3", "three ".repeat(200)),
					"06",
				),
			];
			const context = createContextFake(branchEntries);

			await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(maxActiveCalls).toBe(2);
			expect(completion.calls).toHaveLength(3);
			expect(pi.appendEntryCalls[0]?.data).toEqual({
				projectedEntries: [
					{
						entryId: "03",
						placeholder:
							'<tool_result full_result="omitted" content="summary">\nSummary 1\n</tool_result>',
					},
					{
						entryId: "05",
						placeholder:
							'<tool_result full_result="omitted" content="summary">\nSummary 2\n</tool_result>',
					},
					{
						entryId: "07",
						placeholder:
							'<tool_result full_result="omitted" content="summary">\nSummary 3\n</tool_result>',
					},
				],
			});
			expect(
				context.uiCalls.filter((call) => call.method === "notify"),
			).toEqual([
				{
					method: "notify",
					args: ["Projecting context: 0/3 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Projecting context: 1/3 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Projecting context: 2/3 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Projecting context: 3/3 tool results processed", "info"],
				},
				{
					method: "notify",
					args: ["Context projected: ~540 saved", "info"],
				},
			]);
		});
	});

	test("keeps consult_advisor and configured ignored tool results visible during projection", async () => {
		// Purpose: projection must preserve advisor output and user-configured tool results while still projecting other eligible results.
		// Input and expected output: consult_advisor and run_subagent outputs remain unchanged, while bash output is replaced with the placeholder.
		// Edge case: consult_advisor is preserved even when projectionIgnoredTools omits it.
		// Dependencies: this test observes provider-context copies and verifies stored session messages are unchanged.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					projectionIgnoredTools: ["run_subagent"],
				}),
			);
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const user = userMessage();
			const advisorAssistant = assistantMessage("call-advisor");
			const advisorToolResult = toolResultMessage(
				"call-advisor",
				"advisor output ".repeat(5),
				{ toolName: "consult_advisor" },
			);
			const subagentAssistant = assistantMessage("call-subagent");
			const subagentToolResult = toolResultMessage(
				"call-subagent",
				"subagent output ".repeat(5),
				{ toolName: "run_subagent" },
			);
			const bashAssistant = assistantMessage("call-bash");
			const bashToolResult = toolResultMessage(
				"call-bash",
				"bash output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", advisorAssistant, "01"),
				messageEntry("03", advisorToolResult, "02"),
				messageEntry("04", subagentAssistant, "03"),
				messageEntry("05", subagentToolResult, "04"),
				messageEntry("06", bashAssistant, "05"),
				messageEntry("07", bashToolResult, "06"),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					advisorAssistant,
					advisorToolResult,
					subagentAssistant,
					subagentToolResult,
					bashAssistant,
					{
						...bashToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(messagesFromBranch(branchEntries)[2]).toBe(advisorToolResult);
			expect(messagesFromBranch(branchEntries)[4]).toBe(subagentToolResult);
			expect(messagesFromBranch(branchEntries)[6]).toBe(bashToolResult);
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [{ entryId: "07", placeholder: PLACEHOLDER }],
					},
				},
			]);
		});
	});

	test("ignores the retired shared custom config path", async () => {
		// Purpose: the extension must use its project-owned config file under config/context-projection.json.
		// Input and expected output: valid settings in custom.json alone do not enable projection or state writes.
		// Edge case: the retired config shape still contains valid projection values under contextProjection.
		// Dependencies: this test writes only isolated temporary config files and uses fixture context branches.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeLegacyCustomConfig(agentDir, {
				contextProjection: createValidConfig({ keepRecentTurns: 0 }),
			});
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry(
					"03",
					toolResultMessage("call-old", "old output ".repeat(5)),
					"02",
				),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toBeUndefined();
			expect(pi.appendEntryCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("returns provider-context copies instead of session-owned message objects", async () => {
		// Purpose: later context handlers are allowed to mutate event.messages, so returned messages must not expose session-owned objects.
		// Input and expected output: mutating an unprojected returned message leaves the stored branch message unchanged.
		// Edge case: an eligible old tool result is projected while a recent tool result remains unprojected.
		// Dependencies: this test uses structuredClone to mimic pi runner context-event copies.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { contextHandler } = installContextProjectionTestHarness();
			const oldToolResult = toolResultMessage(
				"call-old",
				"old output ".repeat(5),
			);
			const recentToolResult = toolResultMessage(
				"call-recent",
				"recent output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry("03", oldToolResult, "02"),
				messageEntry("04", assistantMessage("call-recent"), "03"),
				messageEntry("05", recentToolResult, "04"),
			];
			const context = createContextFake(branchEntries);
			const eventMessages = structuredClone(messagesFromBranch(branchEntries));

			const result = (await contextHandler(
				{ type: "context", messages: eventMessages },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;
			const returnedRecentToolResult = result?.messages?.[4];
			if (returnedRecentToolResult?.role !== "toolResult") {
				throw new Error("expected returned recent tool result");
			}
			returnedRecentToolResult.content = [
				{ type: "text", text: "downstream mutation" },
			];

			expect(recentToolResult.content).toEqual([
				{ type: "text", text: "recent output ".repeat(5) },
			]);
		});
	});

	test("keeps the first projection placeholder after config changes", async () => {
		// Purpose: monotonic projection requires the same projected representation for an entry after first projection.
		// Input and expected output: changing config.placeholder affects only future new projections, not the already projected entry.
		// Edge case: the second request reconstructs state from the branch-local custom entry.
		// Dependencies: this test rewrites only an isolated temporary config file.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					placeholder: "first placeholder",
				}),
			);
			const { pi, contextHandler, sessionStartHandler } =
				installContextProjectionTestHarness();
			const projectedToolResult = toolResultMessage(
				"call-old",
				"old output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry("03", projectedToolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			const firstResult = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;
			expect(firstResult?.messages?.[2]).toEqual({
				...projectedToolResult,
				content: [{ type: "text", text: "first placeholder" }],
			});

			branchEntries.push(
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: "first placeholder" }],
					"03",
				),
			);
			await writeCustomConfig(
				agentDir,
				createValidConfig({
					keepRecentTurns: 0,
					placeholder: "second placeholder",
				}),
			);
			await sessionStartHandler({ type: "session_start" }, context.ctx);
			const secondResult = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			expect(secondResult?.messages?.[2]).toEqual({
				...projectedToolResult,
				content: [{ type: "text", text: "first placeholder" }],
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [
							{ entryId: "03", placeholder: "first placeholder" },
						],
					},
				},
			]);
		});
	});

	test("keeps projecting reconstructed branch-local state even when the entry is no longer newly eligible", async () => {
		// Purpose: projected entry IDs stored on the active branch must make later provider contexts monotonic.
		// Input and expected output: a recent tool result with reconstructed projected ID is projected despite keepRecentTurns 1.
		// Edge case: an inactive branch state entry is ignored after session_start reconstruction.
		// Dependencies: this test drives only session_start and context handlers with branch fixtures.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { contextHandler, sessionStartHandler } =
				installContextProjectionTestHarness();
			const user = userMessage();
			const recentAssistant = assistantMessage("call-recent");
			const projectedToolResult = toolResultMessage(
				"call-recent",
				"recent output ".repeat(5),
			);
			const activeBranchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", recentAssistant, "01"),
				messageEntry("03", projectedToolResult, "02"),
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: PLACEHOLDER }],
					"03",
				),
			];
			const activeContext = createContextFake(activeBranchEntries);

			await sessionStartHandler({ type: "session_start" }, activeContext.ctx);
			const activeResult = await contextHandler(
				{ type: "context", messages: messagesFromBranch(activeBranchEntries) },
				activeContext.ctx,
			);

			expect(activeResult).toEqual({
				messages: [
					user,
					recentAssistant,
					{
						...projectedToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(activeContext.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "<warning>~5</warning>"],
				},
			]);

			const inactiveBranchEntries = [
				messageEntry("11", userMessage("other branch"), null),
				messageEntry("12", assistantMessage("call-other"), "11"),
				messageEntry(
					"13",
					toolResultMessage("call-other", "other output ".repeat(5)),
					"12",
				),
			];
			const inactiveContext = createContextFake(inactiveBranchEntries);
			await sessionStartHandler({ type: "session_start" }, inactiveContext.ctx);
			const inactiveResult = await contextHandler(
				{
					type: "context",
					messages: messagesFromBranch(inactiveBranchEntries),
				},
				inactiveContext.ctx,
			);

			expect(inactiveResult).toBeUndefined();
			expect(inactiveContext.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "~0"],
				},
			]);
		});
	});

	test("applies reconstructed projected entries even when usage is below the projection threshold", async () => {
		// Purpose: stored projection state must keep provider context monotonic after a previous projection lowered usage.
		// Input and expected output: threshold is not exceeded, but the reconstructed entry is still replaced with its placeholder.
		// Edge case: the stored tool result is smaller than minToolResultChars, so only branch-local projection state can make it projected.
		// Dependencies: this test drives session_start and context handlers with an isolated config and in-memory branch fixtures.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { contextHandler, sessionStartHandler } =
				installContextProjectionTestHarness();
			const user = userMessage();
			const assistant = assistantMessage("call-stored");
			const storedToolResult = toolResultMessage("call-stored", "short output");
			const branchEntries = [
				messageEntry("01", user, null),
				messageEntry("02", assistant, "01"),
				messageEntry("03", storedToolResult, "02"),
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: PLACEHOLDER }],
					"03",
				),
			];
			const context = createContextFake(branchEntries, {
				tokens: 100,
				contextWindow: 1_000,
			});

			await sessionStartHandler({ type: "session_start" }, context.ctx);
			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					user,
					assistant,
					{
						...storedToolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
			expect(context.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "~0"],
				},
			]);
		});
	});

	test("does not project read results for files under loaded skill roots", async () => {
		// Purpose: loaded skill files are instruction context, so projection must not hide their read results.
		// Input and expected output: a read result under a loaded skill root stays intact while a non-skill read result is projected.
		// Edge case: the protected path is a referenced file under the skill root, not the SKILL.md file itself.
		// Dependencies: this test drives before_agent_start to provide loaded skill roots and uses isolated config files.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const { pi, beforeAgentStartHandler, contextHandler } =
				installContextProjectionTestHarness();
			const skillRoot = join(agentDir, "skills", "review");
			const skillOwnedPath = join(skillRoot, "references", "rules.md");
			const nonSkillPath = join(agentDir, "workspace", "file.ts");
			const skillToolResult = toolResultMessage(
				"call-skill",
				"skill instructions ".repeat(5),
				{ toolName: "read" },
			);
			const nonSkillToolResult = toolResultMessage(
				"call-file",
				"ordinary file output ".repeat(5),
				{ toolName: "read" },
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry(
					"02",
					readAssistantMessage("call-skill", skillOwnedPath),
					"01",
				),
				messageEntry("03", skillToolResult, "02"),
				messageEntry(
					"04",
					readAssistantMessage("call-file", nonSkillPath),
					"03",
				),
				messageEntry("05", nonSkillToolResult, "04"),
			];
			const context = createContextFake(branchEntries);

			await beforeAgentStartHandler(
				{
					type: "before_agent_start",
					prompt: "work",
					systemPrompt: "system",
					systemPromptOptions: {
						cwd: agentDir,
						skills: [
							{
								name: "review",
								description: "Review rules.",
								filePath: join(skillRoot, "SKILL.md"),
								baseDir: skillRoot,
								sourceInfo: {
									path: join(skillRoot, "SKILL.md"),
									source: "test",
									scope: "temporary",
									origin: "top-level",
								},
								disableModelInvocation: false,
							},
						],
					},
				},
				context.ctx,
			);
			const result = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			expect(result?.messages?.[2]).toBe(skillToolResult);
			expect(result?.messages?.[4]).toEqual({
				...nonSkillToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: CUSTOM_TYPE,
					data: {
						projectedEntries: [{ entryId: "05", placeholder: PLACEHOLDER }],
					},
				},
			]);
		});
	});

	test("classifies loaded skill read paths across supported path forms", async () => {
		// Purpose: skill-owned read protection must match pi read path resolution for absolute, relative, home, and @ forms.
		// Input and expected output: inside or equal skill paths stay unprojected; a sibling-boundary path remains projectable.
		// Edge case: single-file skills protect their containing baseDir, and sibling prefixes must not match by string prefix alone.
		// Dependencies: each case uses isolated config, in-memory context, and before_agent_start skill-root discovery.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const cases: Array<{
				readonly name: string;
				readonly skillRoot: string;
				readonly readPath: string;
				readonly shouldProject: boolean;
			}> = [
				{
					name: "relative descendant path",
					skillRoot: join(agentDir, "skills", "relative"),
					readPath: "skills/relative/references/rules.md",
					shouldProject: false,
				},
				{
					name: "at-prefixed absolute descendant path",
					skillRoot: join(agentDir, "skills", "at-prefixed"),
					readPath: `@${join(agentDir, "skills", "at-prefixed", "assets", "template.md")}`,
					shouldProject: false,
				},
				{
					name: "home descendant path",
					skillRoot: join(homedir(), "pi-test-skills", "home-skill"),
					readPath: "~/pi-test-skills/home-skill/SKILL.md",
					shouldProject: false,
				},
				{
					name: "root path itself",
					skillRoot: join(agentDir, "skills", "root-equal"),
					readPath: join(agentDir, "skills", "root-equal"),
					shouldProject: false,
				},
				{
					name: "absolute SKILL.md path",
					skillRoot: join(agentDir, "skills", "skill-md"),
					readPath: join(agentDir, "skills", "skill-md", "SKILL.md"),
					shouldProject: false,
				},
				{
					name: "single-file skill baseDir descendant",
					skillRoot: join(agentDir, "single-file-skills"),
					readPath: join(agentDir, "single-file-skills", "helper.md"),
					shouldProject: false,
				},
				{
					name: "sibling path with shared prefix",
					skillRoot: join(agentDir, "skills", "review"),
					readPath: join(agentDir, "skills", "review-other", "SKILL.md"),
					shouldProject: true,
				},
			];

			for (const testCase of cases) {
				const { beforeAgentStartHandler, contextHandler } =
					installContextProjectionTestHarness();
				const toolResult = toolResultMessage(
					`call-${testCase.name}`,
					`${testCase.name} output `.repeat(5),
					{ toolName: "read" },
				);
				const branchEntries = [
					messageEntry(`u-${testCase.name}`, userMessage(), null),
					messageEntry(
						`a-${testCase.name}`,
						readAssistantMessage(`call-${testCase.name}`, testCase.readPath),
						`u-${testCase.name}`,
					),
					messageEntry(`r-${testCase.name}`, toolResult, `a-${testCase.name}`),
				];
				const context = createContextFake(
					branchEntries,
					{ tokens: 900, contextWindow: 1_000 },
					agentDir,
				);

				await beforeAgentStartHandler(
					{
						type: "before_agent_start",
						prompt: "work",
						systemPrompt: "system",
						systemPromptOptions: {
							cwd: agentDir,
							skills: [
								{
									name: `skill-${testCase.name}`,
									description: "Skill rules.",
									filePath: join(testCase.skillRoot, "SKILL.md"),
									baseDir: testCase.skillRoot,
									sourceInfo: {
										path: join(testCase.skillRoot, "SKILL.md"),
										source: "test",
										scope: "temporary",
										origin: "top-level",
									},
									disableModelInvocation: false,
								},
							],
						},
					},
					context.ctx,
				);
				const result = (await contextHandler(
					{ type: "context", messages: messagesFromBranch(branchEntries) },
					context.ctx,
				)) as { readonly messages?: AgentMessage[] } | undefined;

				if (testCase.shouldProject) {
					expect(result?.messages?.[2]).toEqual({
						...toolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					});
				} else {
					expect(result, testCase.name).toBeUndefined();
				}
			}
		});
	});

	test("does not let stored projection state override loaded skill root protection", async () => {
		// Purpose: persisted projection state must not hide a tool result after it is classified as loaded skill context.
		// Input and expected output: a stored projected entry under a loaded skill root remains unprojected and no new state is written.
		// Edge case: the critical result was projected by older state before this protection existed.
		// Dependencies: this test uses session_start reconstruction plus before_agent_start skill-root discovery.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const {
				pi,
				sessionStartHandler,
				beforeAgentStartHandler,
				contextHandler,
			} = installContextProjectionTestHarness();
			const skillRoot = join(agentDir, "skills", "templates");
			const skillOwnedPath = join(skillRoot, "assets", "ticket.md");
			const skillToolResult = toolResultMessage(
				"call-skill-asset",
				"skill template ".repeat(5),
				{ toolName: "read" },
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry(
					"02",
					readAssistantMessage("call-skill-asset", skillOwnedPath),
					"01",
				),
				messageEntry("03", skillToolResult, "02"),
				projectionStateEntry(
					"04",
					[{ entryId: "03", placeholder: PLACEHOLDER }],
					"03",
				),
			];
			const context = createContextFake(branchEntries);

			await sessionStartHandler({ type: "session_start" }, context.ctx);
			await beforeAgentStartHandler(
				{
					type: "before_agent_start",
					prompt: "work",
					systemPrompt: "system",
					systemPromptOptions: {
						cwd: agentDir,
						skills: [
							{
								name: "templates",
								description: "Template rules.",
								filePath: join(skillRoot, "SKILL.md"),
								baseDir: skillRoot,
								sourceInfo: {
									path: join(skillRoot, "SKILL.md"),
									source: "test",
									scope: "temporary",
									origin: "top-level",
								},
								disableModelInvocation: false,
							},
						],
					},
				},
				context.ctx,
			);
			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toBeUndefined();
			expect(pi.appendEntryCalls).toEqual([]);
			expect(context.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "<warning>~5</warning>"],
				},
				{
					method: "setStatus",
					args: ["context-projection", "~0"],
				},
			]);
		});
	});

	test("skips projection when context messages do not exactly map to active branch messages", async () => {
		// Purpose: mapping ambiguity must prefer a no-op over changing provider context.
		// Input and expected output: event message content differs from session history, so no messages are returned and no state is stored.
		// Edge case: usage is below threshold and the tool result would otherwise be eligible.
		// Dependencies: this test mutates only the copied context event fixture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 0 }),
			);
			const { pi, contextHandler } = installContextProjectionTestHarness();
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry(
					"03",
					toolResultMessage("call-old", "old output ".repeat(5)),
					"02",
				),
			];
			const ambiguousMessages = messagesFromBranch(branchEntries).map(
				(message) =>
					message.role === "user"
						? {
								...message,
								content: [{ type: "text" as const, text: "changed" }],
							}
						: message,
			);
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: ambiguousMessages },
				context.ctx,
			);

			expect(result).toBeUndefined();
			expect(pi.appendEntryCalls).toEqual([]);
			expect(context.uiCalls).toEqual([
				{
					method: "setStatus",
					args: ["context-projection", "~0"],
				},
			]);
		});
	});

	test("does not protect tool results separated from the tool-call turn by an intervening user message", async () => {
		// Purpose: recent-turn protection must apply only to direct tool results that still belong to the assistant tool-call turn.
		// Input and expected output: a user message between assistant tool call and tool result breaks the turn, so the tool result is projected.
		// Edge case: keepRecentTurns would protect the latest tool-use turn if the tool result were directly attached.
		// Dependencies: isolated config, context hook, and branch/message mapping.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 1 }),
			);
			const { contextHandler } = installContextProjectionTestHarness();
			const assistant = assistantMessage("call-old");
			const interveningUser = userMessage("new user message");
			const toolResult = toolResultMessage("call-old", "old output ".repeat(5));
			const branchEntries = [
				messageEntry("01", assistant, null),
				messageEntry("02", interveningUser, "01"),
				messageEntry("03", toolResult, "02"),
			];
			const context = createContextFake(branchEntries);

			const result = await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			);

			expect(result).toEqual({
				messages: [
					assistant,
					interveningUser,
					{
						...toolResult,
						content: [{ type: "text", text: PLACEHOLDER }],
					},
				],
			});
		});
	});

	test("uses the larger value from absolute and percent-based recent turn protection", async () => {
		// Purpose: hybrid protection must preserve more recent tool-use turns when percent exceeds the fixed minimum.
		// Input and expected output: 5 tool-use turns with 40 percent preserve the last 2 turns and project the older 3 turns.
		// Edge case: keepRecentTurns 1 would preserve only one turn without percent-based expansion.
		// Dependencies: this test uses isolated config, in-memory ExtensionAPI fake, and session context fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 1, keepRecentTurnsPercent: 0.4 }),
			);
			const { contextHandler } = installContextProjectionTestHarness();
			const branchEntries = [messageEntry("01", userMessage(), null)];
			const toolResults: ToolResultMessage[] = [];
			let parentId = "01";
			for (let turn = 1; turn <= 5; turn += 1) {
				const assistantEntryId = `${turn * 2}`.padStart(2, "0");
				const toolResultEntryId = `${turn * 2 + 1}`.padStart(2, "0");
				const toolCallId = `call-${turn}`;
				const toolResult = toolResultMessage(
					toolCallId,
					`output ${turn} `.repeat(5),
				);
				toolResults.push(toolResult);
				branchEntries.push(
					messageEntry(
						assistantEntryId,
						assistantMessage(toolCallId),
						parentId,
					),
					messageEntry(toolResultEntryId, toolResult, assistantEntryId),
				);
				parentId = toolResultEntryId;
			}
			const context = createContextFake(branchEntries);

			const result = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			const [
				firstToolResult,
				secondToolResult,
				thirdToolResult,
				fourthToolResult,
				fifthToolResult,
			] = toolResults;
			if (
				firstToolResult === undefined ||
				secondToolResult === undefined ||
				thirdToolResult === undefined ||
				fourthToolResult === undefined ||
				fifthToolResult === undefined
			) {
				throw new Error("expected five tool result fixtures");
			}
			expect(result?.messages?.[2]).toEqual({
				...firstToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[4]).toEqual({
				...secondToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[6]).toEqual({
				...thirdToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[8]).toBe(fourthToolResult);
			expect(result?.messages?.[10]).toBe(fifthToolResult);
		});
	});

	test("uses the absolute recent turn minimum when percent is smaller", async () => {
		// Purpose: short sessions must not become too aggressive because the percent result rounds down to a small number.
		// Input and expected output: 4 tool-use turns with 10 percent and minimum 3 preserve the last 3 turns.
		// Edge case: only the oldest tool result is projected.
		// Dependencies: this test uses isolated config, in-memory ExtensionAPI fake, and session context fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(
				agentDir,
				createValidConfig({ keepRecentTurns: 3, keepRecentTurnsPercent: 0.1 }),
			);
			const { contextHandler } = installContextProjectionTestHarness();
			const firstToolResult = toolResultMessage(
				"call-1",
				"output 1 ".repeat(5),
			);
			const secondToolResult = toolResultMessage(
				"call-2",
				"output 2 ".repeat(5),
			);
			const thirdToolResult = toolResultMessage(
				"call-3",
				"output 3 ".repeat(5),
			);
			const fourthToolResult = toolResultMessage(
				"call-4",
				"output 4 ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-1"), "01"),
				messageEntry("03", firstToolResult, "02"),
				messageEntry("04", assistantMessage("call-2"), "03"),
				messageEntry("05", secondToolResult, "04"),
				messageEntry("06", assistantMessage("call-3"), "05"),
				messageEntry("07", thirdToolResult, "06"),
				messageEntry("08", assistantMessage("call-4"), "07"),
				messageEntry("09", fourthToolResult, "08"),
			];
			const context = createContextFake(branchEntries);

			const result = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			expect(result?.messages?.[2]).toEqual({
				...firstToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[4]).toBe(secondToolResult);
			expect(result?.messages?.[6]).toBe(thirdToolResult);
			expect(result?.messages?.[8]).toBe(fourthToolResult);
		});
	});

	test("counts only assistant messages with tool calls as tool-use turns", async () => {
		// Purpose: text-only assistant messages must not make old tool results appear newer than they are.
		// Input and expected output: one text-only assistant message between two tool-use turns does not protect the old tool result.
		// Edge case: keepRecentTurns 1 protects only the latest real tool-use turn.
		// Dependencies: this test uses isolated config, in-memory ExtensionAPI fake, and session context fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { contextHandler } = installContextProjectionTestHarness();
			const oldToolResult = toolResultMessage(
				"call-old",
				"old output ".repeat(5),
			);
			const recentToolResult = toolResultMessage(
				"call-recent",
				"recent output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry("03", oldToolResult, "02"),
				messageEntry(
					"04",
					assistantTextMessage("I will inspect another file."),
					"03",
				),
				messageEntry("05", assistantMessage("call-recent"), "04"),
				messageEntry("06", recentToolResult, "05"),
			];
			const context = createContextFake(branchEntries);

			const result = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			expect(result?.messages?.[2]).toEqual({
				...oldToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[5]).toBe(recentToolResult);
		});
	});

	test("projects unattached tool results because they are outside recent tool-use turns", async () => {
		// Purpose: recent-turn protection must apply only to tool results attached to counted tool-use turns.
		// Input and expected output: an eligible tool result after a text-only assistant message is projected while the latest real tool-use result is kept.
		// Edge case: keepRecentTurns 1 is positive, but the unattached result is not part of any counted tool-use turn.
		// Dependencies: this test uses isolated config, in-memory ExtensionAPI fake, and session context fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeCustomConfig(agentDir, createValidConfig());
			const { contextHandler } = installContextProjectionTestHarness();
			const unattachedToolResult = toolResultMessage(
				"call-unattached",
				"unattached output ".repeat(5),
			);
			const recentToolResult = toolResultMessage(
				"call-recent",
				"recent output ".repeat(5),
			);
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantTextMessage("No tool call here."), "01"),
				messageEntry("03", unattachedToolResult, "02"),
				messageEntry("04", assistantMessage("call-recent"), "03"),
				messageEntry("05", recentToolResult, "04"),
			];
			const context = createContextFake(branchEntries);

			const result = (await contextHandler(
				{ type: "context", messages: messagesFromBranch(branchEntries) },
				context.ctx,
			)) as { readonly messages?: AgentMessage[] } | undefined;

			expect(result?.messages?.[2]).toEqual({
				...unattachedToolResult,
				content: [{ type: "text", text: PLACEHOLDER }],
			});
			expect(result?.messages?.[4]).toBe(recentToolResult);
		});
	});

	test("rejects invalid percent-based recent turn config", async () => {
		// Purpose: runtime config validation must fail closed for malformed percent values.
		// Input and expected output: missing, negative, above-one, and non-number percent values return undefined and append no custom entry.
		// Edge case: all other config fields are valid and usage is below the projection threshold.
		// Dependencies: this test writes only isolated config files and uses fixture context branches.
		const invalidPercentValues: unknown[] = [undefined, -0.1, 1.1, "0.1"];

		for (const keepRecentTurnsPercent of invalidPercentValues) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeCustomConfig(
					agentDir,
					createValidConfig({ keepRecentTurnsPercent }),
				);
				const { pi, contextHandler } = installContextProjectionTestHarness();
				const branchEntries = [
					messageEntry("01", userMessage(), null),
					messageEntry("02", assistantMessage("call-old"), "01"),
					messageEntry(
						"03",
						toolResultMessage("call-old", "old output ".repeat(5)),
						"02",
					),
				];
				const context = createContextFake(branchEntries);

				const result = await contextHandler(
					{ type: "context", messages: messagesFromBranch(branchEntries) },
					context.ctx,
				);

				expect(result).toBeUndefined();
				expect(pi.appendEntryCalls).toEqual([]);
			});
		}
	});

	test("does not project failed, non-text, small, disabled, or invalidly configured tool results", async () => {
		// Purpose: projection must fail closed for disallowed result types and configuration states.
		// Input and expected output: each case returns undefined and appends no custom entry.
		// Edge case: invalid field type disables projection even when usage is below threshold.
		// Dependencies: this test writes only isolated custom config files and uses fixture context branches.
		const nonProjectedMessages: AgentMessage[] = [
			toolResultMessage("call-failed", "failed output ".repeat(5), {
				isError: true,
			}),
			toolResultMessage("call-image", "", {
				content: [{ type: "image", data: "base64", mimeType: "image/png" }],
			}),
			toolResultMessage("call-small", "small"),
		];

		for (const [index, message] of nonProjectedMessages.entries()) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeCustomConfig(
					agentDir,
					createValidConfig({ keepRecentTurns: 0 }),
				);
				const { pi, contextHandler } = installContextProjectionTestHarness();
				const branchEntries = [
					messageEntry("01", userMessage(), null),
					messageEntry("02", assistantMessage(`call-${index}`), "01"),
					messageEntry("03", message, "02"),
				];
				const context = createContextFake(branchEntries);

				const result = await contextHandler(
					{ type: "context", messages: messagesFromBranch(branchEntries) },
					context.ctx,
				);

				expect(result).toBeUndefined();
				expect(pi.appendEntryCalls).toEqual([]);
				expect(context.uiCalls).toEqual([
					{
						method: "setStatus",
						args: ["context-projection", "~0"],
					},
				]);
			});
		}

		const configs = [
			{
				config: createValidConfig({ enabled: false, keepRecentTurns: 0 }),
				expectedUiCalls: [],
			},
			{
				config: createValidConfig({
					projectionRemainingTokens: "100",
					keepRecentTurns: 0,
				}),
				expectedUiCalls: [
					{
						method: "setStatus",
						args: ["context-projection", "<error>CP!</error>"],
					},
				],
			},
			{
				config: createValidConfig({ keepRecentTurns: 0, placeholder: "" }),
				expectedUiCalls: [
					{
						method: "setStatus",
						args: ["context-projection", "<error>CP!</error>"],
					},
				],
			},
			{
				config: createValidConfig({ keepRecentTurns: 0, placeholder: "   " }),
				expectedUiCalls: [
					{
						method: "setStatus",
						args: ["context-projection", "<error>CP!</error>"],
					},
				],
			},
			{
				config: createValidConfig({
					keepRecentTurns: 0,
					projectionIgnoredTools: ["run_subagent", "run_subagent"],
				}),
				expectedUiCalls: [
					{
						method: "setStatus",
						args: ["context-projection", "<error>CP!</error>"],
					},
				],
			},
		] as const;
		for (const { config, expectedUiCalls } of configs) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeCustomConfig(agentDir, config);
				const { pi, contextHandler } = installContextProjectionTestHarness();
				const branchEntries = [
					messageEntry("01", userMessage(), null),
					messageEntry("02", assistantMessage("call-old"), "01"),
					messageEntry(
						"03",
						toolResultMessage("call-old", "old output ".repeat(5)),
						"02",
					),
				];
				const context = createContextFake(branchEntries);

				const result = await contextHandler(
					{ type: "context", messages: messagesFromBranch(branchEntries) },
					context.ctx,
				);

				expect(result).toBeUndefined();
				expect(pi.appendEntryCalls).toEqual([]);
				expect(context.uiCalls).toEqual(expectedUiCalls);
			});
		}
	});
});
