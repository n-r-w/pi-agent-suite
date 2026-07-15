import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import customCompaction from "../../../pi-package/extensions/custom-compaction/index";
import { HELPER_API_COST_CUSTOM_TYPE } from "../../../pi-package/shared/helper-api-cost";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
/** Matches Pi-compatible UUIDv7 provider session identifiers. */
const AUXILIARY_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const completeSimpleMock = mock();

mock.module("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}));

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

interface SessionContextFake {
	readonly ctx: {
		readonly hasUI?: boolean;
		readonly ui: {
			notify(message: string, type: string | undefined): void;
		};
		readonly sessionManager: {
			getLeafId(): string | null;
		};
		readonly model: Model<Api> | undefined;
		readonly modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined;
			getApiKeyAndHeaders(model: Model<Api>): Promise<
				| {
						readonly ok: true;
						readonly apiKey?: string;
						readonly headers?: Record<string, string>;
				  }
				| { readonly ok: false; readonly error: string }
			>;
		};
	};
	readonly notifications: Notification[];
	readonly requestedModels: Model<Api>[];
}

interface TestModel extends Model<Api> {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
	reasoning: boolean;
}

interface PromptFiles {
	readonly systemPromptFile: string;
	readonly historyPromptFile: string;
	readonly updatePromptFile: string;
	readonly turnPrefixPromptFile: string;
}

interface CompactEvent {
	readonly type: "session_before_compact";
	readonly preparation: {
		readonly firstKeptEntryId: string;
		readonly messagesToSummarize: unknown[];
		readonly turnPrefixMessages: unknown[];
		readonly isSplitTurn: boolean;
		readonly tokensBefore: number;
		readonly previousSummary?: string;
		readonly fileOps: {
			readonly read: Set<string>;
			readonly written: Set<string>;
			readonly edited: Set<string>;
		};
		readonly settings: {
			readonly enabled: boolean;
			readonly reserveTokens: number;
			readonly keepRecentTokens: number;
		};
	};
	readonly branchEntries: readonly unknown[];
	readonly signal: AbortSignal;
}

/** Creates the ExtensionAPI fake needed to observe compaction lifecycle hooks. */
function createExtensionApiFake(thinkingLevel = "high"): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];

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
			return thinkingLevel;
		},
	} as ExtensionApiFake;
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-custom-compaction-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousAgentSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Returns the registered session-before-compact handler from the extension fake. */
function getCompactionHandler(
	pi: ExtensionApiFake,
): (event: unknown, ctx: unknown) => Promise<unknown> | unknown {
	const handler = pi.handlers.find(
		(registeredHandler) =>
			registeredHandler.eventName === "session_before_compact",
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error("expected session_before_compact handler to be registered");
	}

	return handler as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown> | unknown;
}

/** Creates a fake model with the fields used by custom compaction. */
function createModel(
	provider: string,
	id: string,
	contextWindow = 100_000,
): TestModel {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8_192,
	};
}

/** Creates the session context fake needed to observe model resolution and warnings. */
function createSessionContextFake(options?: {
	readonly currentModel?: Model<Api>;
	readonly configuredModel?: Model<Api>;
	readonly thinkingLevel?: string;
	readonly authFailure?: string;
	readonly hasUI?: boolean;
	readonly leafId?: string | null;
}): SessionContextFake {
	const notifications: Notification[] = [];
	const requestedModels: Model<Api>[] = [];
	const currentModel = options?.currentModel ?? createModel("current", "model");
	const configuredModel = options?.configuredModel;

	return {
		ctx: {
			...(options?.hasUI !== undefined ? { hasUI: options.hasUI } : {}),
			ui: {
				notify(message: string, type: string | undefined): void {
					notifications.push({ message, type });
				},
			},
			sessionManager: {
				getLeafId(): string | null {
					return options?.leafId ?? null;
				},
			},
			model: currentModel,
			modelRegistry: {
				find(provider: string, modelId: string): Model<Api> | undefined {
					if (
						configuredModel?.provider === provider &&
						configuredModel.id === modelId
					) {
						return configuredModel;
					}

					return undefined;
				},
				async getApiKeyAndHeaders(model: Model<Api>) {
					requestedModels.push(model);
					if (options?.authFailure !== undefined) {
						return { ok: false as const, error: options.authFailure };
					}

					return {
						ok: true as const,
						apiKey: `api-key-for-${model.provider}-${model.id}`,
						headers: { "x-test-model": model.id },
					};
				},
			},
		},
		notifications,
		requestedModels,
	};
}

/** Creates the compaction event fixture used by behavior tests. */
function createCompactionEvent(
	signal = new AbortController().signal,
): CompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [
				{ role: "user", content: "old question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					timestamp: 2,
				},
			],
			turnPrefixMessages: [
				{ role: "user", content: "split turn", timestamp: 3 },
			],
			isSplitTurn: true,
			tokensBefore: 1234,
			previousSummary: "previous summary",
			fileOps: {
				read: new Set(["a.ts"]),
				written: new Set(["b.ts"]),
				edited: new Set<string>(),
			},
			settings: {
				enabled: true,
				reserveTokens: 1_000,
				keepRecentTokens: 2_000,
			},
		},
		branchEntries: [],
		signal,
	};
}

/** Creates a non-split compaction event for tests that only cover history summarization. */
function createHistoryCompactionEvent(): CompactEvent {
	const event = createCompactionEvent();

	return {
		...event,
		preparation: {
			...event.preparation,
			turnPrefixMessages: [],
			isSplitTurn: false,
		},
	};
}

/** Extracts the synthetic summary request text sent to the fake model. */
function getSummaryRequestText(context: unknown): string {
	if (
		typeof context !== "object" ||
		context === null ||
		!("messages" in context) ||
		!Array.isArray(context.messages)
	) {
		return "";
	}
	const [message] = context.messages;
	if (
		typeof message !== "object" ||
		message === null ||
		!("content" in message)
	) {
		return "";
	}
	const { content } = message;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/** Writes prompt files and returns their absolute paths. */
async function writePromptFiles(
	dir: string,
	content = "prompt text",
): Promise<PromptFiles> {
	await mkdir(dir, { recursive: true });
	const files = {
		systemPromptFile: join(dir, "system.md"),
		historyPromptFile: join(dir, "history.md"),
		updatePromptFile: join(dir, "update.md"),
		turnPrefixPromptFile: join(dir, "turn-prefix.md"),
	};

	await writeFile(files.systemPromptFile, `${content} system`);
	await writeFile(files.historyPromptFile, `${content} history`);
	await writeFile(files.updatePromptFile, `${content} update`);
	await writeFile(files.turnPrefixPromptFile, `${content} turn prefix`);

	return files;
}

/** Writes custom-compaction config under the isolated agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "custom-compaction.json"),
		JSON.stringify(config),
	);
}

/** Creates the assistant response returned by the fake model layer. */
function createAssistantResponse(text: string, cost = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake-api",
		provider: "fake-provider",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: cost,
				cacheRead: 0,
				cacheWrite: 0,
				total: cost,
			},
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

afterEach(() => {
	completeSimpleMock.mockReset();
});

describe("custom-compaction", () => {
	test("uses default prompts, current model, and current thinking when config file is missing", async () => {
		// Purpose: custom-compaction is enabled by default and must use Pi's active runtime by default.
		// Input and expected output: no custom-compaction.json returns a custom compaction using bundled prompts, current model, current thinking, and recorded helper costs.
		// Edge case: the config directory itself is absent, so all defaults come from the extension and active Pi runtime.
		// Dependencies: this test uses mocked completeSimple, an in-memory ExtensionAPI fake, helper cost entries, and a temp agent directory.
		await withIsolatedAgentDir(async () => {
			completeSimpleMock
				.mockResolvedValueOnce(
					createAssistantResponse("default history summary", 0.6),
				)
				.mockResolvedValueOnce(
					createAssistantResponse("default turn summary", 0.7),
				);
			const pi = createExtensionApiFake("high");
			const currentModel = createModel("current", "model");
			const session = createSessionContextFake({ currentModel });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: {
					summary:
						"default history summary\n\n---\n\n**Turn Context (split turn):**\n\ndefault turn summary",
				},
			});
			expect(session.requestedModels).toEqual([currentModel]);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const [, , options] = completeSimpleMock.mock.calls[0] ?? [];
			expect(options).toMatchObject({ reasoning: "high" });
			expect(pi.appendEntryCalls).toHaveLength(2);
			expect(pi.appendEntryCalls).toContainEqual({
				customType: HELPER_API_COST_CUSTOM_TYPE,
				data: { source: "custom-compaction", cost: 0.6 },
			});
			expect(pi.appendEntryCalls).toContainEqual({
				customType: HELPER_API_COST_CUSTOM_TYPE,
				data: { source: "custom-compaction", cost: 0.7 },
			});
			expect(session.notifications).toEqual([]);
		});
	});

	test("uses bundled default prompt files when config omits custom prompt paths", async () => {
		// Purpose: custom prompt paths must be optional when the extension bundles default prompt files.
		// Input and expected output: config with only model options reads extension-local prompts and returns model compaction.
		// Edge case: all prompt path fields are omitted together.
		// Dependencies: extension-local prompt files, fake model registry auth, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: true, reasoning: "medium" });
			completeSimpleMock
				.mockResolvedValueOnce(
					createAssistantResponse("default history summary"),
				)
				.mockResolvedValueOnce(createAssistantResponse("default turn summary"));
			const pi = createExtensionApiFake();
			const session = createSessionContextFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: {
					summary:
						"default history summary\n\n---\n\n**Turn Context (split turn):**\n\ndefault turn summary",
				},
			});
			expect(session.notifications).toEqual([]);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const [, historyContext, historyOptions] =
				completeSimpleMock.mock.calls[0] ?? [];
			const [, turnContext, turnOptions] =
				completeSimpleMock.mock.calls[1] ?? [];
			expect(historyContext).toMatchObject({
				systemPrompt: expect.any(String),
			});
			expect(historyContext?.systemPrompt).not.toBe("");
			expect(turnContext).toMatchObject({
				systemPrompt: historyContext?.systemPrompt,
			});
			expect(getSummaryRequestText(historyContext)).toContain("<conversation>");
			expect(getSummaryRequestText(historyContext)).toContain(
				"<previous-summary>",
			);
			expect(historyOptions).toMatchObject({ reasoning: "medium" });
			expect(turnOptions).toMatchObject({ reasoning: "medium" });
		});
	});

	test("reads all prompt files and returns custom compaction with the current model and thinking level", async () => {
		// Purpose: valid config must replace built-in compaction through isolated history and turn-prefix sessions.
		// Input and expected output: two summary branches return one compaction and use distinct UUIDv7 session IDs.
		// Edge case: model and reasoning are omitted, so current session values are used.
		// Dependencies: this test uses temp config/prompt files, fake model registry auth, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, { enabled: true, ...promptFiles });
			completeSimpleMock
				.mockResolvedValueOnce(createAssistantResponse("new history summary"))
				.mockResolvedValueOnce(createAssistantResponse("new turn summary"));
			const pi = createExtensionApiFake();
			const currentModel = createModel("current", "model");
			const session = createSessionContextFake({
				currentModel,
				thinkingLevel: "high",
			});
			const event = createCompactionEvent();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(event, session.ctx);

			expect(result).toEqual({
				compaction: {
					summary:
						"new history summary\n\n---\n\n**Turn Context (split turn):**\n\nnew turn summary",
					firstKeptEntryId: "entry-keep",
					tokensBefore: 1234,
					details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
				},
			});
			expect(session.requestedModels).toEqual([currentModel]);
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const [model, context, options] = completeSimpleMock.mock.calls[0] ?? [];
			const [, turnContext, turnOptions] =
				completeSimpleMock.mock.calls[1] ?? [];
			expect(model).toBe(currentModel);
			expect(context).toMatchObject({ systemPrompt: "prompt text system" });
			expect(turnContext).toMatchObject({ systemPrompt: "prompt text system" });
			expect(getSummaryRequestText(context)).toContain("previous summary");
			expect(getSummaryRequestText(context)).toContain("prompt text update");
			expect(getSummaryRequestText(context)).toContain("old question");
			expect(getSummaryRequestText(turnContext)).toContain(
				"prompt text turn prefix",
			);
			expect(options).toMatchObject({
				apiKey: "api-key-for-current-model",
				headers: { "x-test-model": "model" },
				reasoning: "high",
				signal: event.signal,
			});
			expect(turnOptions).toMatchObject({
				apiKey: "api-key-for-current-model",
				headers: { "x-test-model": "model" },
				reasoning: "high",
				signal: event.signal,
			});
			expect(options?.sessionId).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(turnOptions?.sessionId).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(turnOptions?.sessionId).not.toBe(options?.sessionId);
			expect(session.notifications).toEqual([]);
		});
	});

	test("summarizes large tool results before oversized compaction summary requests", async () => {
		// Purpose: custom compaction must isolate tool-result compression from the final compaction provider session.
		// Input and expected output: the helper retry keeps one session ID while the final summary uses a different ID.
		// Edge case: helper summary retries preserve matching tool-call context and separate safe diagnostics.
		// Dependencies: mocked completeSimple, temp agent directory, fake model registry, and tokenizer-based input estimation.
		await withIsolatedAgentDir(async (agentDir) => {
			completeSimpleMock
				.mockImplementationOnce(async () => {
					throw new Error("WebSocket closed");
				})
				.mockResolvedValueOnce(createAssistantResponse("large tool summary"))
				.mockResolvedValueOnce(
					createAssistantResponse("final compact summary"),
				);
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				summary: {
					enabled: true,
					model: "helper/summary",
					thinking: "low",
					maxConcurrency: 1,
					retryCount: 1,
					retryDelayMs: 0,
				},
			});
			const currentModel = createModel("current", "small", 500);
			const helperModel = createModel("helper", "summary", 100_000);
			const pi = createExtensionApiFake("high");
			const session = createSessionContextFake({
				currentModel,
				configuredModel: helperModel,
			});
			const rawMarker = "UNIQUE_RAW_TOOL_RESULT_MARKER";
			const largeToolResult = `${rawMarker} ${"large output ".repeat(5_000)}`;
			const baseEvent = createHistoryCompactionEvent();
			const event = {
				...baseEvent,
				preparation: {
					...baseEvent.preparation,
					messagesToSummarize: [
						{ role: "user", content: "inspect repository", timestamp: 1 },
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "tool-call-large",
									name: "bash",
									arguments: { command: "printf large-output" },
								},
							],
							timestamp: 2,
						},
						{
							role: "toolResult",
							toolCallId: "tool-call-large",
							toolName: "bash",
							content: [{ type: "text", text: largeToolResult }],
							isError: false,
							timestamp: 3,
						},
					],
				},
			} as CompactEvent;
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(event, session.ctx);

			expect(result).toMatchObject({
				compaction: { summary: "final compact summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(3);
			const requestSessionIds = completeSimpleMock.mock.calls.map(
				(call) => call[2]?.sessionId,
			);
			expect(requestSessionIds[0]).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(requestSessionIds[1]).toBe(requestSessionIds[0]);
			expect(requestSessionIds[2]).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(requestSessionIds[2]).not.toBe(requestSessionIds[0]);
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: "tool-result-summary-diagnostic",
					data: {
						source: "custom-compaction",
						provider: "helper",
						model: "summary",
						candidateId: "history:2",
						toolName: "bash",
						attempt: 1,
						totalAttempts: 2,
						failureKind: "exception",
						errorName: "Error",
						errorMessage: "WebSocket closed",
					},
				},
			]);
			const [helperModelArg, helperContext, helperOptions] =
				completeSimpleMock.mock.calls[1] ?? [];
			expect(helperModelArg).toBe(helperModel);
			expect(helperOptions).toMatchObject({ reasoning: "low" });
			expect(getSummaryRequestText(helperContext)).toContain(
				"printf large-output",
			);
			expect(getSummaryRequestText(helperContext)).toContain(rawMarker);
			const [finalModelArg, finalContext] =
				completeSimpleMock.mock.calls[2] ?? [];
			expect(finalModelArg).toBe(currentModel);
			expect(getSummaryRequestText(finalContext)).toContain(
				"large tool summary",
			);
			expect(getSummaryRequestText(finalContext)).not.toContain(rawMarker);
			expect(session.notifications).toEqual([
				{
					message:
						"[custom-compaction] compressing large tool results before compaction: 0/1",
					type: "info",
				},
				{
					message:
						"[custom-compaction] compressing bash tool result before compaction: 1/1",
					type: "info",
				},
				{
					message: "[custom-compaction] retrying tool result summary 2/2",
					type: "info",
				},
				{
					message:
						"[custom-compaction] compressed 1/1 large tool results before compaction",
					type: "info",
				},
			]);
			expect(session.requestedModels).toEqual([currentModel, helperModel]);
		});
	});

	test("moves overflow retry boundary after a retained assistant error", async () => {
		// Purpose: overflow retry must not restore a context whose last message is an assistant error.
		// Input and expected output: retained context ends with assistant error, so custom compaction summarizes that retained tail and keeps from a new non-message boundary.
		// Edge case: the final provider overflow assistant message has empty content after an earlier retry text.
		// Dependencies: mocked completeSimple, temp agent directory, fake ExtensionAPI appendEntry, and fake session leaf ID.
		await withIsolatedAgentDir(async () => {
			completeSimpleMock.mockResolvedValueOnce(
				createAssistantResponse("overflow recovery summary"),
			);
			const pi = createExtensionApiFake();
			const session = createSessionContextFake({
				leafId: "retry-boundary-entry",
			});
			const event = {
				...createHistoryCompactionEvent(),
				reason: "overflow",
				willRetry: true,
				branchEntries: [
					{
						type: "message",
						id: "entry-keep",
						parentId: "before-keep",
						timestamp: "2026-07-08T16:25:00.000Z",
						message: {
							role: "user",
							content: [{ type: "text", text: "recent user request" }],
							timestamp: 10,
						},
					},
					{
						type: "message",
						id: "websocket-error",
						parentId: "entry-keep",
						timestamp: "2026-07-08T16:25:15.000Z",
						message: {
							role: "assistant",
							content: [
								{
									type: "text",
									text: "Repeat search by separate paths.",
								},
							],
							provider: "openai-codex",
							model: "gpt-5.5",
							stopReason: "error",
							errorMessage: "WebSocket closed 1012",
							timestamp: 11,
						},
					},
					{
						type: "message",
						id: "overflow-error",
						parentId: "websocket-error",
						timestamp: "2026-07-08T16:25:21.000Z",
						message: {
							role: "assistant",
							content: [],
							provider: "openai-codex",
							model: "gpt-5.5",
							stopReason: "error",
							errorMessage:
								"Codex error: Your input exceeds the context window of this model.",
							timestamp: 12,
						},
					},
				],
			} as CompactEvent;
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(event, session.ctx);

			expect(result).toMatchObject({
				compaction: {
					summary: "overflow recovery summary",
					firstKeptEntryId: "retry-boundary-entry",
				},
			});
			expect(pi.appendEntryCalls).toContainEqual({
				customType: "custom-compaction-overflow-retry-boundary",
				data: { reason: "overflow-retry-after-assistant-error" },
			});
			const [, context] = completeSimpleMock.mock.calls[0] ?? [];
			expect(getSummaryRequestText(context)).toContain("recent user request");
			expect(getSummaryRequestText(context)).toContain(
				"Repeat search by separate paths.",
			);
		});
	});

	test("fails startup when a configured prompt file path is not absolute", async () => {
		// Purpose: configured custom-compaction prompt files must use absolute paths so startup cannot depend on config-relative or home expansion.
		// Input and expected output: each non-absolute prompt path causes extension loading to throw.
		// Edge case: every prompt field is validated independently.
		// Dependencies: isolated config file, prompt files, and in-memory ExtensionAPI fake.
		const fields: Array<keyof PromptFiles> = [
			"systemPromptFile",
			"historyPromptFile",
			"updatePromptFile",
			"turnPrefixPromptFile",
		];
		for (const field of fields) {
			for (const invalidPath of [`${field}.md`, `~/${field}.md`]) {
				await withIsolatedAgentDir(async (agentDir) => {
					const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
					await writeConfig(agentDir, {
						enabled: true,
						...promptFiles,
						[field]: invalidPath,
					});
					const pi = createExtensionApiFake();

					expect(() => customCompaction(pi)).toThrow(
						`[custom-compaction] ${field} must be an absolute path`,
					);
				});
			}
		}
	});

	test("reads configured absolute prompt paths", async () => {
		// Purpose: configured custom-compaction prompt files must be read only from absolute paths.
		// Input and expected output: four absolute prompt paths are read and sent to the fake model context.
		// Edge case: the optional turn-prefix prompt path uses the same absolute-path rule as required prompts.
		// Dependencies: this test writes only temp prompt files and uses mocked model completion.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, { enabled: true, ...promptFiles });
			completeSimpleMock
				.mockResolvedValueOnce(createAssistantResponse("history summary"))
				.mockResolvedValueOnce(createAssistantResponse("turn summary"));
			const pi = createExtensionApiFake();
			const session = createSessionContextFake();
			customCompaction(pi);

			await getCompactionHandler(pi)(createCompactionEvent(), session.ctx);

			const [, context] = completeSimpleMock.mock.calls[0] ?? [];
			const [, turnContext] = completeSimpleMock.mock.calls[1] ?? [];
			expect(context).toMatchObject({ systemPrompt: "prompt text system" });
			expect(turnContext).toMatchObject({
				systemPrompt: "prompt text system",
			});
			expect(getSummaryRequestText(context)).toContain("prompt text update");
			expect(getSummaryRequestText(turnContext)).toContain(
				"prompt text turn prefix",
			);
		});
	});

	test("disables custom compaction and reports only custom-compaction issues for invalid config", async () => {
		// Purpose: invalid config must fail closed without calling the model.
		// Input and expected output: unsupported key, invalid reasoning, empty model, and empty prompt file produce warnings and no replacement.
		// Edge cases: validation errors and empty prompt content are both covered.
		// Dependencies: this test uses temp config/prompt files and an in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			const emptyPromptFile = join(agentDir, "prompts", "empty.md");
			await writeFile(emptyPromptFile, "");
			const invalidConfigs = [
				{ enabled: true, ...promptFiles, extra: true },
				{ enabled: true, ...promptFiles, reasoning: "extreme" },
				{ enabled: true, ...promptFiles, model: "" },
				{ enabled: true, ...promptFiles, historyPromptFile: emptyPromptFile },
			];

			for (const invalidConfig of invalidConfigs) {
				await writeConfig(agentDir, invalidConfig);
				completeSimpleMock.mockReset();
				const pi = createExtensionApiFake();
				const session = createSessionContextFake();
				customCompaction(pi);

				const result = await getCompactionHandler(pi)(
					createCompactionEvent(),
					session.ctx,
				);

				expect(result).toBeUndefined();
				expect(completeSimpleMock).not.toHaveBeenCalled();
				expect(session.notifications).toHaveLength(1);
				expect(session.notifications[0]?.message).toStartWith(
					"[custom-compaction]",
				);
				expect(session.notifications[0]?.type).toBe("warning");
			}
		});
	});

	test("does not notify invalid config when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive custom-compaction warning notifications.
		// Input and expected output: unsupported config key with hasUI false returns no compaction and no notification.
		// Edge case: the UI object still has notify, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses temp config/prompt files and an in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				extra: true,
			});
			completeSimpleMock.mockReset();
			const pi = createExtensionApiFake();
			const session = createSessionContextFake({ hasUI: false });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toBeUndefined();
			expect(completeSimpleMock).not.toHaveBeenCalled();
			expect(session.notifications).toEqual([]);
		});
	});

	test("converts coding-agent-only compaction messages before model call", async () => {
		// Purpose: real compaction preparation can contain coding-agent-only roles that model providers do not accept directly.
		// Input and expected output: a bashExecution message is converted into a user message before completeSimple receives context.
		// Edge case: the original bashExecution role must not reach the fake model layer.
		// Dependencies: this test uses temp config/prompt files, fake model registry auth, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, { enabled: true, ...promptFiles });
			completeSimpleMock
				.mockResolvedValueOnce(createAssistantResponse("converted history"))
				.mockResolvedValueOnce(createAssistantResponse("converted turn"));
			const pi = createExtensionApiFake();
			const session = createSessionContextFake();
			const event = createCompactionEvent();
			event.preparation.messagesToSummarize.push({
				role: "bashExecution",
				command: "npm test",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 4,
			});
			customCompaction(pi);

			await getCompactionHandler(pi)(event, session.ctx);

			const [, context] = completeSimpleMock.mock.calls[0] ?? [];
			expect(context).toHaveProperty("messages");
			expect(getSummaryRequestText(context)).toContain("<conversation>");
			expect(getSummaryRequestText(context)).toContain("npm test");
			expect(getSummaryRequestText(context)).not.toContain("bashExecution");
		});
	});

	test("uses configured model IDs that contain slashes after the provider", async () => {
		// Purpose: custom-compaction model config must match pi model IDs where only the first slash separates provider from model ID.
		// Input and expected output: openrouter/ai21/jamba-large-1.7 resolves to provider openrouter and model ID ai21/jamba-large-1.7.
		// Edge case: model IDs with provider-owned slash segments must not be rejected as malformed config.
		// Dependencies: this test uses temp config/prompt files, fake model registry, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				model: "openrouter/ai21/jamba-large-1.7",
			});
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("configured summary"),
			);
			const configuredModel = createModel("openrouter", "ai21/jamba-large-1.7");
			const pi = createExtensionApiFake();
			const session = createSessionContextFake({ configuredModel });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createHistoryCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "configured summary" },
			});
			expect(session.requestedModels).toEqual([configuredModel]);
			const [model] = completeSimpleMock.mock.calls[0] ?? [];
			expect(model).toBe(configuredModel);
		});
	});

	test("uses configured model and reasoning when present", async () => {
		// Purpose: explicit model and reasoning config must override current session values.
		// Input and expected output: provider/model plus medium reasoning call the configured fake model with medium reasoning.
		// Edge case: current model is different from configured model.
		// Dependencies: this test uses temp config/prompt files, fake model registry, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				model: "configured/model",
				reasoning: "medium",
			});
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("configured summary"),
			);
			const configuredModel = createModel("configured", "model");
			const currentModel = createModel("current", "model");
			const pi = createExtensionApiFake();
			const session = createSessionContextFake({
				configuredModel,
				currentModel,
			});
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createHistoryCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "configured summary" },
			});
			expect(session.requestedModels).toEqual([configuredModel]);
			const [model, , options] = completeSimpleMock.mock.calls[0] ?? [];
			expect(model).toBe(configuredModel);
			expect(options).toMatchObject({ reasoning: "medium" });
		});
	});

	test("retries transient compaction model failures through extension retry config", async () => {
		// Purpose: custom-compaction must retry transient provider failures without relying on a custom retry loop.
		// Input and expected output: one WebSocket failure followed by a valid response returns a custom compaction.
		// Edge case: baseDelayMs is zero so retry behavior is deterministic and fast.
		// Dependencies: this test uses temp config/prompt files, fake model registry auth, and mocked completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				retry: { maxRetries: 1, baseDelayMs: 0 },
			});
			completeSimpleMock
				.mockImplementationOnce(async () => {
					throw new Error("WebSocket closed");
				})
				.mockResolvedValueOnce(createAssistantResponse("retried summary"));
			const pi = createExtensionApiFake();
			const session = createSessionContextFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createHistoryCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "retried summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			expect(session.notifications).toEqual([]);
		});
	});

	test("rejects invalid custom-compaction retry config", async () => {
		// Purpose: custom-compaction owns its retry config validation before provider calls can start.
		// Input and expected output: invalid retry.maxRetries reports a custom-compaction warning and returns no compaction.
		// Edge case: prompt files are otherwise valid, so retry validation is the only failing boundary.
		// Dependencies: this test uses temp config/prompt files and an in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFiles = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...promptFiles,
				retry: { maxRetries: -1 },
			});
			const pi = createExtensionApiFake();
			const session = createSessionContextFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createHistoryCompactionEvent(),
				session.ctx,
			);

			expect(result).toBeUndefined();
			expect(completeSimpleMock).not.toHaveBeenCalled();
			expect(session.notifications).toEqual([
				{
					message:
						"[custom-compaction] retry.maxRetries must be a non-negative integer",
					type: "warning",
				},
			]);
		});
	});
});
