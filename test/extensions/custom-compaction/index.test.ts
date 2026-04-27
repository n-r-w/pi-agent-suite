import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import customCompaction from "../../../pi-package/extensions/custom-compaction/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const HOME_ENV = "HOME";

const completeSimpleMock = mock();

mock.module("@mariozechner/pi-ai", () => ({
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
}

interface SessionContextFake {
	readonly ctx: {
		readonly hasUI?: boolean;
		readonly ui: {
			notify(message: string, type: string | undefined): void;
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

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
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
	const agentDir = await mkdtemp(join(tmpdir(), "pi-custom-compaction-"));

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
function createModel(provider: string, id: string): TestModel {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
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
function createAssistantResponse(text: string): AssistantMessage {
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
		// Input and expected output: no custom-compaction.json returns a custom compaction using bundled prompts, current model, and current thinking.
		// Edge case: the config directory itself is absent, so all defaults come from the extension and active Pi runtime.
		// Dependencies: this test uses mocked completeSimple, an in-memory ExtensionAPI fake, and a temp agent directory.
		await withIsolatedAgentDir(async () => {
			completeSimpleMock
				.mockResolvedValueOnce(
					createAssistantResponse("default history summary"),
				)
				.mockResolvedValueOnce(createAssistantResponse("default turn summary"));
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
				systemPrompt: expect.stringContaining(
					"context summarization assistant",
				),
			});
			expect(turnContext).toMatchObject({
				systemPrompt: historyContext?.systemPrompt,
			});
			expect(getSummaryRequestText(historyContext)).toContain("<conversation>");
			expect(getSummaryRequestText(historyContext)).toContain(
				"<previous-summary>",
			);
			expect(getSummaryRequestText(historyContext)).toContain(
				"Update the existing structured summary",
			);
			expect(getSummaryRequestText(turnContext)).toContain(
				"Summarize the prefix",
			);
			expect(historyOptions).toMatchObject({ reasoning: "medium" });
			expect(turnOptions).toMatchObject({ reasoning: "medium" });
		});
	});

	test("reads all prompt files and returns custom compaction with the current model and thinking level", async () => {
		// Purpose: valid config must replace built-in compaction through a fake model call.
		// Input and expected output: custom prompt files and current model produce a compaction result with the model summary.
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
			expect(session.notifications).toEqual([]);
		});
	});

	test("resolves absolute, home, and config-relative prompt paths", async () => {
		// Purpose: all supported prompt path forms must point to the intended files.
		// Input and expected output: absolute, ~/ and relative paths are read and sent to the fake model context.
		// Edge case: supported path forms are mixed in one config file.
		// Dependencies: this test writes only temp files and temporarily sets HOME for ~/ resolution.
		await withIsolatedAgentDir(async (agentDir) => {
			const previousHome = process.env[HOME_ENV];
			const homeDir = await mkdtemp(
				join(tmpdir(), "pi-custom-compaction-home-"),
			);
			process.env[HOME_ENV] = homeDir;
			try {
				const configDir = join(agentDir, "config");
				const absoluteSystemPrompt = join(agentDir, "absolute-system.md");
				const absolutePrompt = join(agentDir, "absolute-history.md");
				const homePrompt = join(homeDir, "home-update.md");
				const relativePrompt = "relative-turn-prefix.md";
				await mkdir(configDir, { recursive: true });
				await writeFile(absoluteSystemPrompt, "absolute system prompt");
				await writeFile(absolutePrompt, "absolute history prompt");
				await writeFile(homePrompt, "home update prompt");
				await writeFile(
					join(configDir, relativePrompt),
					"relative turn prompt",
				);
				await writeConfig(agentDir, {
					enabled: true,
					systemPromptFile: absoluteSystemPrompt,
					historyPromptFile: absolutePrompt,
					updatePromptFile: "~/home-update.md",
					turnPrefixPromptFile: relativePrompt,
				});
				completeSimpleMock
					.mockResolvedValueOnce(createAssistantResponse("history summary"))
					.mockResolvedValueOnce(createAssistantResponse("turn summary"));
				const pi = createExtensionApiFake();
				const session = createSessionContextFake();
				customCompaction(pi);

				await getCompactionHandler(pi)(createCompactionEvent(), session.ctx);

				const [, context] = completeSimpleMock.mock.calls[0] ?? [];
				const [, turnContext] = completeSimpleMock.mock.calls[1] ?? [];
				expect(context).toMatchObject({
					systemPrompt: "absolute system prompt",
				});
				expect(turnContext).toMatchObject({
					systemPrompt: "absolute system prompt",
				});
				expect(getSummaryRequestText(context)).toContain("home update prompt");
				expect(getSummaryRequestText(turnContext)).toContain(
					"relative turn prompt",
				);
			} finally {
				if (previousHome === undefined) {
					delete process.env[HOME_ENV];
				} else {
					process.env[HOME_ENV] = previousHome;
				}
				await rm(homeDir, { recursive: true, force: true });
			}
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
});
