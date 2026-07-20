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

interface RegisteredEntryRenderer {
	readonly customType: string;
	readonly renderer: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly entryRenderers: RegisteredEntryRenderer[];
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
	readonly reductionSystemPromptFile: string;
	readonly reductionPromptFile: string;
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
	const entryRenderers: RegisteredEntryRenderer[] = [];
	const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
	return {
		handlers,
		entryRenderers,
		appendEntryCalls,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		appendEntry(customType: string, data: unknown): void {
			appendEntryCalls.push({ customType, data });
		},
		registerEntryRenderer(customType: string, renderer: unknown): void {
			entryRenderers.push({ customType, renderer });
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
	readonly onNotify?: (notification: Notification) => void;
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
					const notification = { message, type };
					notifications.push(notification);
					options?.onNotify?.(notification);
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

/** Creates a compaction event whose discarded range contains one large tool result. */
function createProjectionCompactionEvent(
	signal = new AbortController().signal,
): Record<string, unknown> {
	const user = {
		role: "user",
		content: "inspect the large result",
		timestamp: 1,
	};
	const assistant = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "large-call",
				name: "bash",
				arguments: { command: "large-output" },
			},
		],
		provider: "current",
		model: "model",
		api: "fake-api",
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
	const toolResult = {
		role: "toolResult",
		toolCallId: "large-call",
		toolName: "bash",
		content: [
			{
				type: "text",
				text: `${"large raw output ".repeat(400)}RAW_RESULT_TAIL`,
			},
		],
		isError: false,
		timestamp: 3,
	};
	const retained = { role: "user", content: "retained task", timestamp: 4 };
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [user, assistant, toolResult],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 20_000,
			fileOps: {
				read: new Set<string>(),
				written: new Set<string>(),
				edited: new Set<string>(),
			},
			settings: {
				enabled: true,
				reserveTokens: 1_000,
				keepRecentTokens: 2_000,
			},
		},
		branchEntries: [
			messageEntry("entry-user", null, user),
			messageEntry("entry-assistant", "entry-user", assistant),
			messageEntry("entry-result", "entry-assistant", toolResult),
			messageEntry("entry-keep", "entry-result", retained),
		],
		reason: "threshold",
		willRetry: false,
		signal,
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

/** Renders one persisted outcome through the registered entry renderer. */
function renderOutcomeEntry(pi: ExtensionApiFake, data: unknown): string {
	const renderer = pi.entryRenderers.find(
		(entry) => entry.customType === "custom-compaction-outcome",
	)?.renderer;
	if (typeof renderer !== "function") {
		throw new Error("expected custom-compaction outcome renderer");
	}
	const component: unknown = renderer(
		{ customType: "custom-compaction-outcome", data },
		{ expanded: false },
		{ fg: (_color: string, text: string) => text },
	);
	if (
		typeof component !== "object" ||
		component === null ||
		!("render" in component) ||
		typeof component.render !== "function"
	) {
		throw new Error("expected renderable outcome component");
	}
	return component.render(100).join("\n");
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

/** Writes context-projection configuration in the isolated suite directory. */
async function writeProjectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(agentDir, "agent-suite", "context-projection");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

/** Writes every configurable compaction prompt with distinct routing markers. */
async function writePromptFiles(dir: string): Promise<PromptFiles> {
	await mkdir(dir, { recursive: true });
	const files = {
		systemPromptFile: join(dir, "system.md"),
		historyPromptFile: join(dir, "history.md"),
		updatePromptFile: join(dir, "update.md"),
		reductionSystemPromptFile: join(dir, "reduction-system.md"),
		reductionPromptFile: join(dir, "reduction.md"),
	};
	await writeFile(files.systemPromptFile, "custom system prompt");
	await writeFile(files.historyPromptFile, "custom history prompt");
	await writeFile(files.updatePromptFile, "custom update prompt");
	await writeFile(
		files.reductionSystemPromptFile,
		"custom reduction system prompt",
	);
	await writeFile(files.reductionPromptFile, "custom reduction prompt");
	return files;
}

afterEach(() => {
	completeSimpleMock.mockReset();
});

describe("custom-compaction", () => {
	test("projects every eligible unprojected tool result in the compaction source", async () => {
		// Purpose: recent or newly added results in Pi's discarded range must not fall back to arbitrary prefix truncation.
		// Input and expected output: enabled forced projection summarizes one large result before the direct compaction request.
		// Edge case: the generated projection summary exceeds Pi's 2,000-character result cap and must remain complete.
		// Dependencies: isolated projection config, fake session, and ordered completion responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				minToolResultTokensL3: 1,
				projectCompactionSource: true,
				summary: {
					enabled: true,
					maxConcurrency: 1,
					retryCount: 0,
					retryDelayMs: 0,
				},
			});
			const projectionTail = "FORCED_PROJECTION_TAIL";
			completeSimpleMock
				.mockResolvedValueOnce(
					createAssistantResponse(
						`${"projected result ".repeat(300)}${projectionTail}`,
					),
				)
				.mockResolvedValueOnce(createAssistantResponse("adaptive summary"));
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createProjectionCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "adaptive summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const [, compactionContext] = completeSimpleMock.mock.calls[1] ?? [];
			const compactionText = requestText(compactionContext);
			expect(compactionText).toContain(projectionTail);
			expect(compactionText).not.toContain("RAW_RESULT_TAIL");
			expect(pi.appendEntryCalls).toContainEqual({
				customType: "custom-compaction-outcome",
				data: {
					kind: "success",
					message:
						"compaction completed: direct summary, 1/1 tool results projected, 2 model requests",
				},
			});
		});
	});

	test("uses Pi truncation when compaction-source projection is disabled", async () => {
		// Purpose: the opt-out must preserve the previously agreed Pi fallback behavior.
		// Input and expected output: explicit false skips helper projection and runs only direct compaction.
		// Edge case: the result remains larger than the L3 threshold.
		// Dependencies: isolated projection config and completion request capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				minToolResultTokensL3: 1,
				projectCompactionSource: false,
				summary: { enabled: true },
			});
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("adaptive summary"),
			);
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createProjectionCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "adaptive summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			const [, compactionContext] = completeSimpleMock.mock.calls[0] ?? [];
			expect(requestText(compactionContext)).not.toContain("RAW_RESULT_TAIL");
		});
	});

	test("falls back to Pi truncation when forced projection fails", async () => {
		// Purpose: one failed helper summary must not block durable compaction.
		// Input and expected output: an output-limit response is rejected, then direct compaction succeeds with Pi serialization.
		// Edge case: projection retry count is zero.
		// Dependencies: isolated projection config and ordered completion responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				minToolResultTokensL3: 1,
				projectCompactionSource: true,
				summary: {
					enabled: true,
					maxConcurrency: 1,
					retryCount: 0,
					retryDelayMs: 0,
				},
			});
			completeSimpleMock
				.mockResolvedValueOnce(
					createAssistantResponse("incomplete", { stopReason: "length" }),
				)
				.mockResolvedValueOnce(createAssistantResponse("adaptive summary"));
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createProjectionCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: "adaptive summary" },
			});
			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
			const [, compactionContext] = completeSimpleMock.mock.calls[1] ?? [];
			expect(requestText(compactionContext)).not.toContain("RAW_RESULT_TAIL");
		});
	});

	test("stops before final compaction when forced projection is cancelled", async () => {
		// Purpose: cancellation during forced projection must not start the durable summary request.
		// Input and expected output: the helper response arrives after abort and the compaction handler returns no custom result.
		// Edge case: the helper provider itself returns a successful response after cancellation.
		// Dependencies: isolated projection config and one controlled abort signal.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				minToolResultTokensL3: 1,
				projectCompactionSource: true,
				summary: {
					enabled: true,
					maxConcurrency: 1,
					retryCount: 0,
					retryDelayMs: 0,
				},
			});
			const controller = new AbortController();
			completeSimpleMock.mockImplementationOnce(async () => {
				controller.abort();
				return createAssistantResponse("projection summary");
			});
			const pi = createExtensionApiFake();
			const session = createSessionFake();
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createProjectionCompactionEvent(controller.signal),
				session.ctx,
			);

			expect(result).toBeUndefined();
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		});
	});

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
					summary:
						"adaptive summary\n\n<previously_read_files>\na.ts\n</previously_read_files>\n\n<previously_modified_files>\nb.ts\n</previously_modified_files>",
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
				{
					customType: "custom-compaction-outcome",
					data: {
						kind: "success",
						message: "compaction completed: direct summary, 1 model request",
					},
				},
			]);
			expect(pi.entryRenderers).toHaveLength(1);
			expect(pi.entryRenderers[0]?.customType).toBe(
				"custom-compaction-outcome",
			);
			expect(session.notifications).toEqual([
				{
					message: "[custom-compaction] adaptive compaction started",
					type: "info",
				},
				{
					message: "[custom-compaction] creating final summary...",
					type: "info",
				},
				{
					message:
						"[custom-compaction] compaction completed: direct summary, 1 model request",
					type: "info",
				},
			]);
		});
	});

	test("renders persisted outcomes without adding model context", async () => {
		// Purpose: terminal custom-compaction outcomes must survive transcript redraw as TUI-only entries.
		// Input and expected output: one persisted success entry renders its exact user-visible message.
		// Edge case: rendering occurs after a fresh extension instance registers the renderer.
		// Dependencies: in-memory ExtensionAPI fake and Pi Text component contract.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake();
			customCompaction(pi);

			const rendered = renderOutcomeEntry(pi, {
				kind: "success",
				message: "compaction completed: direct summary, 1 model request",
			});

			expect(rendered).toContain(
				"[custom-compaction] compaction completed: direct summary, 1 model request",
			);
		});
	});

	test("yields one macrotask after publishing start progress", async () => {
		// Purpose: Pi must receive the start message before synchronous adaptive planning can occupy the event loop.
		// Input and expected output: a timer queued by the start notification runs before the first model completion.
		// Edge case: the direct path otherwise reaches completion without an asynchronous planning boundary.
		// Dependencies: fake Pi UI notification, one deterministic timer gate, and mocked completion.
		await withIsolatedAgentDir(async () => {
			let macrotaskYielded = false;
			let yieldedBeforeCompletion = false;
			completeSimpleMock.mockImplementation(async () => {
				yieldedBeforeCompletion = macrotaskYielded;
				return createAssistantResponse("yielded summary");
			});
			const pi = createExtensionApiFake();
			const session = createSessionFake({
				onNotify: (notification) => {
					if (
						notification.message ===
						"[custom-compaction] adaptive compaction started"
					) {
						setTimeout(() => {
							macrotaskYielded = true;
						}, 0);
					}
				},
			});
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: expect.stringContaining("yielded summary") },
			});
			expect(yieldedBeforeCompletion).toBeTrue();
		});
	});

	test("yields one macrotask after publishing the outcome", async () => {
		// Purpose: Pi must render the informative outcome before its standard compaction completion replaces custom notifications.
		// Input and expected output: a timer queued by the completion notification runs before the handler resolves.
		// Edge case: the direct model request completes immediately.
		// Dependencies: fake Pi UI notification, one deterministic timer marker, and mocked completion.
		await withIsolatedAgentDir(async () => {
			let outcomeRendered = false;
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("outcome summary"),
			);
			const pi = createExtensionApiFake();
			const session = createSessionFake({
				onNotify: (notification) => {
					if (notification.message.includes("compaction completed:")) {
						setTimeout(() => {
							outcomeRendered = true;
						}, 0);
					}
				},
			});
			customCompaction(pi);

			await getCompactionHandler(pi)(createCompactionEvent(), session.ctx);

			expect(outcomeRendered).toBeTrue();
		});
	});

	test("emits no adaptive progress without Pi UI", async () => {
		// Purpose: headless compaction must not emit informational progress notifications.
		// Input and expected output: successful direct compaction with hasUI false returns a result and no notifications.
		// Edge case: model completion still runs normally without UI.
		// Dependencies: isolated config, fake headless Pi context, and mocked completion.
		await withIsolatedAgentDir(async () => {
			completeSimpleMock.mockResolvedValue(
				createAssistantResponse("headless summary"),
			);
			const pi = createExtensionApiFake();
			const session = createSessionFake({ hasUI: false });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toMatchObject({
				compaction: { summary: expect.stringContaining("headless summary") },
			});
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
				compaction: {
					summary: expect.stringContaining(
						"configured summary\n\n<previously_read_files>\na.ts\n</previously_read_files>",
					),
				},
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

	test("routes configured reduction prompts only to intermediate requests", async () => {
		// Purpose: final and intermediate requests must use independently configurable prompt pairs.
		// Input and expected output: a constrained model triggers reduction with custom reduction prompts before a custom final request.
		// Edge case: the configured final system prompt must not leak into intermediate requests.
		// Dependencies: isolated prompt files, fake constrained model, and mocked completion.
		await withIsolatedAgentDir(async (agentDir) => {
			const prompts = await writePromptFiles(join(agentDir, "prompts"));
			await writeConfig(agentDir, {
				enabled: true,
				...prompts,
				model: "configured/reducer",
			});
			completeSimpleMock.mockImplementation(async (_model, context) =>
				createAssistantResponse(
					requestText(context).includes("custom reduction prompt")
						? "reduced checkpoint"
						: "configured final summary",
				),
			);
			const configuredModel = {
				...createModel("configured", "reducer", 1_500),
				maxTokens: 96,
			};
			const pi = createExtensionApiFake();
			const session = createSessionFake({ configuredModel });
			customCompaction(pi);

			const result = await getCompactionHandler(pi)(
				createCompactionEvent(),
				session.ctx,
			);

			expect(result).toBeDefined();
			const contexts = completeSimpleMock.mock.calls.map(
				([, context]) => context,
			);
			const reductionContexts = contexts.filter((context) =>
				requestText(context).includes("custom reduction prompt"),
			);
			expect(reductionContexts.length).toBeGreaterThan(0);
			for (const context of reductionContexts) {
				expect(context).toMatchObject({
					systemPrompt: "custom reduction system prompt",
				});
			}
			const finalContext = contexts.at(-1);
			expect(finalContext).toMatchObject({
				systemPrompt: "custom system prompt",
			});
			expect(requestText(finalContext)).toContain("custom update prompt");
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
			"reductionSystemPromptFile",
			"reductionPromptFile",
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

			expect(session.notifications).toEqual([
				{
					message: "[custom-compaction] adaptive compaction started",
					type: "info",
				},
				{
					message: "[custom-compaction] creating final summary...",
					type: "info",
				},
				{
					message: "[custom-compaction] retrying final summary: attempt 2/2",
					type: "info",
				},
				{
					message:
						"[custom-compaction] compaction completed: direct summary, 1 model request, 1 retry",
					type: "info",
				},
			]);
			expect(result).toMatchObject({
				compaction: {
					summary: expect.stringContaining(
						"retried summary\n\n<previously_read_files>\na.ts\n</previously_read_files>",
					),
				},
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
					message: "[custom-compaction] adaptive compaction started",
					type: "info",
				},
				{
					message: "[custom-compaction] creating final summary...",
					type: "info",
				},
				{
					message: "[custom-compaction] retrying final summary: attempt 2/2",
					type: "info",
				},
				{
					message:
						"[custom-compaction] adaptive compaction failed after 1 model request and 1 retry: final response reached its output limit; using standard compaction",
					type: "warning",
				},
			]);
			expect(pi.appendEntryCalls).toContainEqual({
				customType: "custom-compaction-outcome",
				data: {
					kind: "fallback",
					message:
						"adaptive compaction failed after 1 model request and 1 retry: final response reached its output limit; using standard compaction",
				},
			});
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
