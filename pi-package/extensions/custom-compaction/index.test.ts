import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HELPER_API_COST_CUSTOM_TYPE } from "../../shared/helper-api-cost";
import customCompaction from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
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

interface TestModel extends Model<Api> {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
}

interface SessionFake {
	readonly ctx: Record<string, unknown>;
	readonly notifications: Notification[];
	readonly requestedModels: Model<Api>[];
}

interface PromptFiles {
	readonly systemPromptFile: string;
	readonly historyPromptFile: string;
	readonly updatePromptFile: string;
}

/** Runs one test with isolated extension configuration. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-custom-compaction-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		restoreEnv(AGENT_DIR_ENV, previousAgentDir);
		restoreEnv(AGENT_SUITE_DIR_ENV, previousSuiteDir);
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Restores one environment variable after an isolated test. */
function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

/** Creates a fake model with bounded context metadata. */
function createModel(
	provider = "current",
	id = "model",
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

/** Creates the ExtensionAPI fake used to capture lifecycle registration and costs. */
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
		getActiveTools(): string[] {
			return [];
		},
		getAllTools(): never[] {
			return [];
		},
	} as unknown as ExtensionApiFake;
}

/** Creates the Pi context fake used by the custom compaction shell. */
function createSessionFake(options?: {
	readonly currentModel?: Model<Api> | undefined;
	readonly configuredModel?: Model<Api>;
	readonly hasUI?: boolean;
	readonly authFailure?: string;
}): SessionFake {
	const notifications: Notification[] = [];
	const requestedModels: Model<Api>[] = [];
	const currentModel =
		"currentModel" in (options ?? {}) ? options?.currentModel : createModel();
	const configuredModel = options?.configuredModel;
	return {
		ctx: {
			cwd: "/tmp/project",
			...(options?.hasUI === undefined ? {} : { hasUI: options.hasUI }),
			ui: {
				notify(message: string, type: string | undefined): void {
					notifications.push({ message, type });
				},
			},
			model: currentModel,
			modelRegistry: {
				find(provider: string, modelId: string): Model<Api> | undefined {
					return configuredModel?.provider === provider &&
						configuredModel.id === modelId
						? configuredModel
						: undefined;
				},
				async getApiKeyAndHeaders(model: Model<Api>) {
					requestedModels.push(model);
					return options?.authFailure === undefined
						? {
								ok: true as const,
								apiKey: `key-${model.provider}-${model.id}`,
								headers: { "x-test-model": model.id },
							}
						: { ok: false as const, error: options.authFailure };
				},
			},
			getSystemPrompt(): string {
				return "main system prompt";
			},
		},
		notifications,
		requestedModels,
	};
}

/** Returns a branch entry containing one agent message. */
function messageEntry(
	id: string,
	parentId: string | null,
	message: unknown,
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	};
}

/** Creates a compaction event with a large replaceable prefix and fixed suffix. */
function createCompactionEvent(
	signal = new AbortController().signal,
): Record<string, unknown> {
	const oldUser = {
		role: "user",
		content: "old question ".repeat(500),
		timestamp: 1,
	};
	const oldAssistant = {
		role: "assistant",
		content: [{ type: "text", text: "old answer" }],
		timestamp: 2,
	};
	const turnPrefix = { role: "user", content: "split turn", timestamp: 3 };
	const retained = { role: "user", content: "retained task", timestamp: 4 };
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [oldUser, oldAssistant],
			turnPrefixMessages: [turnPrefix],
			isSplitTurn: true,
			tokensBefore: 1_234,
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
		branchEntries: [
			messageEntry("entry-old-user", null, oldUser),
			messageEntry("entry-old-assistant", "entry-old-user", oldAssistant),
			messageEntry("entry-prefix", "entry-old-assistant", turnPrefix),
			messageEntry("entry-keep", "entry-prefix", retained),
		],
		reason: "threshold",
		willRetry: false,
		signal,
	};
}

/** Returns the registered compaction handler. */
function getCompactionHandler(
	pi: ExtensionApiFake,
): (event: unknown, ctx: unknown) => Promise<unknown> | unknown {
	const handler = pi.handlers.find(
		(entry) => entry.eventName === "session_before_compact",
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error("expected session_before_compact handler");
	}
	return handler as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown> | unknown;
}

/** Creates one provider response for summary requests. */
function createAssistantResponse(
	text: string,
	options?: { readonly cost?: number; readonly stopReason?: "stop" | "length" },
): AssistantMessage {
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
				output: options?.cost ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: options?.cost ?? 0,
			},
		},
		stopReason: options?.stopReason ?? "stop",
		timestamp: 1,
	};
}

/** Extracts the single user text sent in one summary request. */
function requestText(context: unknown): string {
	if (!isContext(context)) {
		return "";
	}
	return context.messages
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text),
		)
		.join("\n");
}

/** Narrows unknown completion input to the Context shape used by tests. */
function isContext(value: unknown): value is Context {
	return (
		typeof value === "object" &&
		value !== null &&
		"messages" in value &&
		Array.isArray(value.messages)
	);
}

/** Writes extension config in the isolated suite directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	const configDir = join(agentDir, "agent-suite", "custom-compaction");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

/** Writes the three configurable compaction prompts. */
async function writePromptFiles(dir: string): Promise<PromptFiles> {
	await mkdir(dir, { recursive: true });
	const files = {
		systemPromptFile: join(dir, "system.md"),
		historyPromptFile: join(dir, "history.md"),
		updatePromptFile: join(dir, "update.md"),
	};
	await writeFile(files.systemPromptFile, "custom system prompt");
	await writeFile(files.historyPromptFile, "custom history prompt");
	await writeFile(files.updatePromptFile, "custom update prompt");
	return files;
}

afterEach(() => {
	completeSimpleMock.mockReset();
});

describe("custom-compaction", () => {
	test("returns one adaptive result with Pi's fixed boundary and file details", async () => {
		// Purpose: the entry shell must use one direct final request and preserve Pi lifecycle state.
		// Input and expected output: default config plus one small response returns the original boundary, file details, and chronological source.
		// Edge case: previous summary and split-turn prefix are both present.
		// Dependencies: isolated config, fake Pi context, and mocked completion.
		await withIsolatedAgentDir(async () => {
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("adaptive summary", { cost: 0.6 }),
			);
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toEqual({
				compaction: {
					summary: "adaptive summary",
					firstKeptEntryId: "entry-keep",
					tokensBefore: 1_234,
					details: {
						readFiles: ["a.ts"],
						modifiedFiles: ["b.ts"],
					},
				},
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			const [, context, options] = completeSimpleMock.mock.calls[0] ?? [];
			const text = requestText(context);
			expect(text.indexOf("previous summary")).toBeLessThan(
				text.indexOf("old question"),
			);
			expect(text.indexOf("old question")).toBeLessThan(
				text.indexOf("split turn"),
			);
			expect(options).toMatchObject({
				reasoning: "high",
				sessionId: expect.stringMatching(AUXILIARY_SESSION_ID_PATTERN),
			});
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: HELPER_API_COST_CUSTOM_TYPE,
					data: { source: "custom-compaction", cost: 0.6 },
				},
			]);
			expect(session.notifications).toEqual([]);
		});
	});

	test("uses configured prompts, model, and reasoning", async () => {
		// Purpose: public runtime selection and prompt overrides must remain effective for the adaptive final request.
		// Input and expected output: absolute prompts and provider/model/variant select the configured model and update prompt.
		// Edge case: the model ID contains additional slashes after the provider.
		// Dependencies: isolated prompt files, fake registry auth, and mocked completion.
		await withIsolatedAgentDir(async (agentDir) => {
			const prompts = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...prompts,
				model: "configured/model/variant",
				reasoning: "medium",
			});
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("configured summary"),
			);
			const configuredModel = createModel("configured", "model/variant");
			const pi = createExtensionApiFake();
			const session = createSessionFake({ configuredModel });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "configured summary" },
			});
			expect(session.requestedModels).toEqual([configuredModel]);
			const [model, context, options] = completeSimpleMock.mock.calls[0] ?? [];
			expect(model).toBe(configuredModel);
			expect(context).toMatchObject({ systemPrompt: "custom system prompt" });
			expect(requestText(context)).toContain("custom update prompt");
			expect(options).toMatchObject({
				reasoning: "medium",
				apiKey: "key-configured-model/variant",
				headers: { "x-test-model": "model/variant" },
			});
		});
	});

	test("rejects relative configurable prompt paths during startup", async () => {
		// Purpose: configured prompt loading must not depend on process working directory or home expansion.
		// Input and expected output: every configurable prompt field rejects relative and tilde-prefixed paths.
		// Edge case: fields are checked independently while the extension is enabled.
		// Dependencies: isolated config and in-memory ExtensionAPI fake.
		for (const key of [
			"systemPromptFile",
			"historyPromptFile",
			"updatePromptFile",
		] as const) {
			for (const path of [`${key}.md`, `~/${key}.md`]) {
				await withIsolatedAgentDir(async (agentDir) => {
					await writeConfig(agentDir, { enabled: true, [key]: path });
					expect(() => customCompaction(createExtensionApiFake())).toThrow(
						`[custom-compaction] ${key} must be an absolute path`,
					);
				});
			}
		}
	});

	test("reports invalid config only when Pi UI is available", async () => {
		// Purpose: invalid config must return control to Pi and provide one exact interactive warning.
		// Input and expected output: unsupported config produces a warning with UI and remains silent without UI.
		// Edge case: neither path calls the summarization model.
		// Dependencies: isolated config and fake UI modes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: true, unsupported: true });
			for (const hasUI of [true, false]) {
				const pi = createExtensionApiFake();
				const session = createSessionFake({ hasUI });
				customCompaction(pi);

				const result = await getCompactionHandler(pi)(
					createCompactionEvent(),
					session.ctx,
				);

				expect(result).toBeUndefined();
				expect(session.notifications).toEqual(
					hasUI
						? [
								{
									message: expect.stringContaining(
										'unsupported key "unsupported"',
									),
									type: "warning",
								},
							]
						: [],
				);
			}
			expect(completeSimpleMock).not.toHaveBeenCalled();
		});
	});

	test("retries transient failures with one stable request ID", async () => {
		// Purpose: model transport failures must use configured retries without changing logical request identity.
		// Input and expected output: one retryable rejection followed by success returns compaction after two calls.
		// Edge case: zero retry delay keeps the test deterministic.
		// Dependencies: isolated retry config and mocked completion.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			let attempts = 0;
			completeSimpleMock.mockImplementation(async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("network error");
				}
				return createAssistantResponse("retried summary");
			});
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(session.notifications).toEqual([]);
			expect(result).toMatchObject({
				compaction: { summary: "retried summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const firstOptions = completeSimpleMock.mock.calls[0]?.[2];
			const secondOptions = completeSimpleMock.mock.calls[1]?.[2];
			expect(firstOptions?.sessionId).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(secondOptions?.sessionId).toBe(firstOptions?.sessionId);
		});
	});

	test("reports exhausted response failure and returns native fallback", async () => {
		// Purpose: an accepted custom attempt must not persist partial output after configured retries fail.
		// Input and expected output: two output-limit responses produce one exact warning and no custom result.
		// Edge case: the model returns text, but stopReason length makes both responses invalid.
		// Dependencies: isolated retry config, fake UI, and mocked completion.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("partial", { stopReason: "length" }),
			);
			const pi = createExtensionApiFake();
			const session = createSessionFake({ hasUI: true });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toBeUndefined();
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			expect(session.notifications).toEqual([
				{
					message:
						"[custom-compaction] final response reached its output limit",
					type: "warning",
				},
			]);
		});
	});

	test("returns native fallback when model or authentication is unavailable", async () => {
		// Purpose: missing runtime dependencies must not call a model or produce partial compaction.
		// Input and expected output: unavailable main model and failed summarizer auth each return no custom result with a warning.
		// Edge case: failures occur before adaptive requests and therefore have no helper cost entries.
		// Dependencies: fake model registry and UI only.
		await withIsolatedAgentDir(async () => {
			const cases = [
				createSessionFake({ currentModel: undefined }),
				createSessionFake({ authFailure: "missing token" }),
			];
			for (const session of cases) {
				const pi = createExtensionApiFake();
				customCompaction(pi);
				const result = await getCompactionHandler(pi)(
					createCompactionEvent(),
					session.ctx,
				);
				expect(result).toBeUndefined();
				expect(session.notifications).toHaveLength(1);
				expect(session.notifications[0]?.type).toBe("warning");
			}
			expect(completeSimpleMock).not.toHaveBeenCalled();
		});
	});
});
