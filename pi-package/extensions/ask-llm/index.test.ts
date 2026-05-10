import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import askLlm from "./index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const USER_QUESTION_OPEN_TAG = "<user_question>";
const USER_QUESTION_CLOSE_TAG = "</user_question>";
const CONTEXT_PROJECTION_CUSTOM_TYPE = "context-projection";

initTheme("dark");

interface RegisteredCommandFake {
	readonly name: string;
	readonly handler: (
		args: string,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
}

type BeforeAgentStartHandler = (event: {
	readonly systemPromptOptions?: {
		readonly contextFiles?: readonly {
			readonly path: string;
			readonly content: string;
		}[];
		readonly skills?: readonly { readonly baseDir: string }[];
	};
}) => void;

interface ExtensionApiFake extends ExtensionAPI {
	readonly commands: RegisteredCommandFake[];
	readonly sessionWriteCalls: string[];
	readonly beforeAgentStartHandlers: BeforeAgentStartHandler[];
}

interface CompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

interface CompletionResponseOutcome {
	readonly kind: "response";
	readonly content: AssistantMessage["content"];
	readonly stopReason?: AssistantMessage["stopReason"];
	readonly errorMessage?: string;
}

interface CompletionThrowOutcome {
	readonly kind: "throw";
	readonly error: Error;
}

type CompletionOutcome = CompletionResponseOutcome | CompletionThrowOutcome;

type AuthResult =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly headers?: Record<string, string>;
	  }
	| { readonly ok: false; readonly error: string };

interface AnswerComponentFake {
	readonly render?: (width: number) => string[];
	readonly handleInput?: (data: string) => void | Promise<void>;
	readonly dispose?: () => void;
}

interface AskLlmContextFake extends ExtensionCommandContext {
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}>;
	readonly renderedCustomOutputs: string[];
	readonly editorPrompts: string[];
	readonly answerComponents: AnswerComponentFake[];
}

/** Runs one test with isolated pi storage so extension config never touches user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-ask-llm-"));

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

/** Writes ask-llm config under the suite-owned extension directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	const configDir = join(agentDir, "agent-suite", "ask-llm");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

/** Writes a legacy ask-llm config file that new ask-llm must ignore. */
async function writeLegacyConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(agentDir, "config");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "ask-llm.json"), JSON.stringify(config));
}

/** Writes context-projection config under the suite-owned extension directory. */
async function writeProjectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(agentDir, "agent-suite", "context-projection");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

/** Creates the ExtensionAPI fake used to observe command registration and session writes. */
function createExtensionApiFake(): ExtensionApiFake {
	const commands: RegisteredCommandFake[] = [];
	const sessionWriteCalls: string[] = [];
	const beforeAgentStartHandlers: BeforeAgentStartHandler[] = [];

	return {
		commands,
		sessionWriteCalls,
		beforeAgentStartHandlers,
		on(eventName: string, handler: BeforeAgentStartHandler): void {
			if (eventName === "before_agent_start") {
				beforeAgentStartHandlers.push(handler);
			}
		},
		registerTool(): void {},
		registerCommand(name: string, options: RegisteredCommandFake): void {
			commands.push({ name, handler: options.handler });
		},
		registerShortcut(): void {},
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		registerMessageRenderer(): void {},
		sendMessage(): void {
			sessionWriteCalls.push("sendMessage");
		},
		sendUserMessage(): void {
			sessionWriteCalls.push("sendUserMessage");
		},
		appendEntry(): void {
			sessionWriteCalls.push("appendEntry");
		},
		setSessionName(): void {},
		getSessionName(): undefined {
			return undefined;
		},
		setLabel(): void {},
		async exec() {
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		getActiveTools(): string[] {
			return [];
		},
		getAllTools(): never[] {
			return [];
		},
		setActiveTools(): void {},
		getCommands(): never[] {
			return [];
		},
		async setModel(): Promise<boolean> {
			return true;
		},
		getThinkingLevel(): string {
			return "medium";
		},
		setThinkingLevel(): void {},
		registerProvider(): void {},
		unregisterProvider(): void {},
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
	} as unknown as ExtensionApiFake;
}

/** Returns the single registered ask command. */
function getAskCommand(pi: ExtensionApiFake): RegisteredCommandFake {
	const command = pi.commands.find((candidate) => candidate.name === "ask");
	if (command === undefined) {
		throw new Error("expected ask command");
	}
	return command;
}

/** Emits before-agent-start handlers in registration order. */
function emitBeforeAgentStartHandlers(
	pi: ExtensionApiFake,
	event: Parameters<BeforeAgentStartHandler>[0],
): void {
	if (pi.beforeAgentStartHandlers.length === 0) {
		throw new Error("expected before_agent_start handler");
	}

	for (const handler of pi.beforeAgentStartHandlers) {
		handler(event);
	}
}

/** Creates a model fixture that can be resolved by provider and model ID. */
function createModel(provider: string, id: string): Model<Api> {
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

/** Creates fake model completion and records every request sent by ask-llm. */
function createCompletionFake(
	text = "LLM answer",
	responseOverrides: Partial<AssistantMessage> = {},
): {
	readonly calls: CompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	return createCompletionSequenceFake([
		{
			kind: "response",
			content: [{ type: "text", text }],
			...(responseOverrides.stopReason !== undefined
				? { stopReason: responseOverrides.stopReason }
				: {}),
			...(responseOverrides.errorMessage !== undefined
				? { errorMessage: responseOverrides.errorMessage }
				: {}),
		},
	]);
}

/** Creates fake completeSimple that returns or throws one configured outcome per call. */
function createCompletionSequenceFake(outcomes: readonly CompletionOutcome[]): {
	readonly calls: CompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	const calls: CompletionCall[] = [];
	return {
		calls,
		async completeSimple<TApi extends Api>(
			model: Model<TApi>,
			context: Context,
			options?: SimpleStreamOptions,
		): Promise<AssistantMessage> {
			calls.push({ model: model as Model<Api>, context, options });
			const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
			if (outcome === undefined) {
				throw new Error("expected completion outcome");
			}
			if (outcome.kind === "throw") {
				throw outcome.error;
			}
			return createAssistantResponse(model, outcome);
		},
	};
}

/** Creates one assistant response with standard fake usage metadata. */
function createAssistantResponse<TApi extends Api>(
	model: Model<TApi>,
	outcome: CompletionResponseOutcome,
): AssistantMessage {
	return {
		role: "assistant",
		content: outcome.content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: outcome.stopReason ?? "stop",
		...(outcome.errorMessage !== undefined
			? { errorMessage: outcome.errorMessage }
			: {}),
		timestamp: 1,
	};
}

/** Creates a command context fake with isolated UI, model registry, and forbidden session reads. */
function createContextFake(
	models: readonly Model<Api>[],
	editorResult = "Question from editor",
	entries: readonly SessionEntry[] = [],
	authResult: AuthResult = {
		ok: true,
		apiKey: "ask-llm-api-key",
		headers: { "x-ask-llm": "enabled" },
	},
	hasUI = true,
	autoCloseAnswer = true,
): AskLlmContextFake {
	const notifications: Array<{
		message: string;
		type: string | undefined;
	}> = [];
	const renderedCustomOutputs: string[] = [];
	const editorPrompts: string[] = [];
	const answerComponents: AnswerComponentFake[] = [];
	let customCallIndex = 0;

	return {
		cwd: "/tmp/project",
		hasUI,
		model: models[0],
		notifications,
		renderedCustomOutputs,
		editorPrompts,
		answerComponents,
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined {
				return models.find(
					(model) => model.provider === provider && model.id === modelId,
				);
			},
			async getApiKeyAndHeaders() {
				return authResult;
			},
		},
		sessionManager: {
			getBranch(): SessionEntry[] {
				return [...entries];
			},
			getEntries(): SessionEntry[] {
				return [...entries];
			},
		} as never,
		ui: {
			theme: {
				fg: (_color: string, value: string) => value,
				bold: (value: string) => value,
			},
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
			async editor(title: string): Promise<string | undefined> {
				editorPrompts.push(title);
				return editorResult;
			},
			async custom<T>(factory: never): Promise<T> {
				const callIndex = customCallIndex++;
				return new Promise<T>((resolve, reject) => {
					let settled = false;
					let component: AnswerComponentFake | undefined;
					const done = (result: T) => {
						if (settled) {
							return;
						}
						settled = true;
						component?.dispose?.();
						resolve(result);
					};
					Promise.resolve(
						(
							factory as unknown as (
								tui: unknown,
								theme: unknown,
								keybindings: unknown,
								done: (result: T) => void,
							) => unknown
						)(
							{ requestRender(): void {} },
							{
								fg: (_color: string, value: string) => value,
								bold: (value: string) => value,
							},
							{},
							done,
						),
					)
						.then((created) => {
							component = created as AnswerComponentFake;
							if (callIndex > 0) {
								renderedCustomOutputs.push(
									component.render?.(100).join("\n") ?? "",
								);
								answerComponents.push(component);
								if (autoCloseAnswer) {
									done(undefined as T);
								}
							}
						})
						.catch(reject);
				});
			},
		},
		isIdle(): boolean {
			return true;
		},
		signal: undefined,
		abort(): void {},
		hasPendingMessages(): boolean {
			return false;
		},
		shutdown(): void {},
		getContextUsage(): undefined {
			return undefined;
		},
		compact(): void {},
		getSystemPrompt(): string {
			return "main session prompt must not be used";
		},
		async waitForIdle(): Promise<void> {},
		async newSession() {
			return { cancelled: true };
		},
		async fork() {
			return { cancelled: true };
		},
		async navigateTree() {
			return { cancelled: true };
		},
	} as unknown as AskLlmContextFake;
}

/** Creates one session message entry used as provider context for /ask. */
function createSessionMessageEntry(
	id: string,
	parentId: string | null,
	content: string,
): SessionEntry {
	return createMessageEntry(id, parentId, {
		role: "user",
		content,
		timestamp: 1,
	});
}

/** Creates a session message entry for direct provider-context assertions. */
function createMessageEntry(
	id: string,
	parentId: string | null,
	message: AgentMessage,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "t",
		message,
	} as SessionEntry;
}

/** Creates an extension-owned projection state entry. */
function createProjectionStateEntry(
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
		customType: CONTEXT_PROJECTION_CUSTOM_TYPE,
		data: { projectedEntries: [{ entryId: projectedEntryId, placeholder }] },
	} as SessionEntry;
}

/** Creates an assistant tool-call message for projection replay fixtures. */
function createAssistantToolCallMessage(
	toolCallId: string,
): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "bash",
				arguments: {},
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "main",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** Creates a successful text tool result for projection replay fixtures. */
function createToolResultMessage(
	toolCallId: string,
	text: string,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

/** Waits until the answer UI component is created by the fake custom UI. */
async function waitForAnswerComponent(
	ctx: AskLlmContextFake,
): Promise<AnswerComponentFake> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const component = ctx.answerComponents[0];
		if (component !== undefined) {
			return component;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("expected answer component");
}

describe("ask-llm", () => {
	test("registers ask command by default when config is missing", async () => {
		// Purpose: ask-llm must be usable without setup because missing config enables the extension.
		// Input and expected output: no config file registers the public /ask command.
		// Edge case: the isolated agent directory has no suite config directory at all.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake and temp pi storage.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake();

			askLlm(pi);

			expect(pi.commands.map((command) => command.name)).toEqual(["ask"]);
		});
	});

	test("ignores legacy ask-llm config", async () => {
		// Purpose: new ask-llm config must be read only from suite-owned storage.
		// Input and expected output: legacy disabled config does not suppress default /ask registration.
		// Edge case: no suite config exists, so missing suite config still means enabled by default.
		// Dependencies: this test uses isolated temp config and command registration observation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeLegacyConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			askLlm(pi);

			expect(pi.commands.map(({ name }) => name)).toEqual(["ask"]);
		});
	});

	test("does not register ask command when config disables the extension", async () => {
		// Purpose: enabled false must remove the command from pi command discovery.
		// Input and expected output: suite config with enabled false registers no command.
		// Edge case: no other config fields are needed for disablement.
		// Dependencies: this test uses only temp pi storage and an in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			askLlm(pi);

			expect(pi.commands).toEqual([]);
		});
	});

	test("sends tagged command argument to the selected model without session writes", async () => {
		// Purpose: /ask must send the active branch as context without persisting its question or answer in the active session.
		// Input and expected output: the existing session message is preserved, and the command argument becomes the tagged final user message.
		// Edge case: the saved session has no /ask question or answer because those are never written through ExtensionAPI session methods.
		// Dependencies: this test uses a fake model layer, fake UI, and fake ExtensionAPI session-write methods.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake("Visible answer");
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model], "Question from editor", [
				createSessionMessageEntry(
					"session-1",
					null,
					"Existing session context",
				),
			]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("What should I check?", ctx);

			expect(ctx.notifications).toEqual([]);
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.model).toBe(model);
			expect(completion.calls[0]?.context.messages).toEqual([
				{
					role: "user",
					content: "Existing session context",
					timestamp: 1,
				},
				{
					role: "user",
					content: [
						USER_QUESTION_OPEN_TAG,
						"What should I check?",
						USER_QUESTION_CLOSE_TAG,
					].join("\n"),
					timestamp: expect.any(Number),
				},
			]);
			expect(completion.calls[0]?.context.tools).toEqual([]);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				USER_QUESTION_OPEN_TAG,
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				USER_QUESTION_CLOSE_TAG,
			);
			expect(completion.calls[0]?.options?.reasoning).toBe("medium");
			expect(completion.calls[0]?.options?.apiKey).toBe("ask-llm-api-key");
			expect(completion.calls[0]?.options?.headers).toEqual({
				"x-ask-llm": "enabled",
			});
			expect(ctx.renderedCustomOutputs.join("\n")).toContain("Visible answer");
			expect(pi.sessionWriteCalls).toEqual([]);
		});
	});

	test("opens a question editor when ask command arguments are empty", async () => {
		// Purpose: users must be able to run /ask without inline arguments and still provide a one-off question.
		// Input and expected output: empty args open the editor and use the editor result as the model question.
		// Edge case: whitespace-only args are treated as empty.
		// Dependencies: this test uses a fake editor and fake model completion.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model], "Question from editor");
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("   ", ctx);

			expect(ctx.editorPrompts).toEqual(["Ask LLM"]);
			expect(completion.calls[0]?.context.messages.at(-1)).toEqual({
				role: "user",
				content: [
					USER_QUESTION_OPEN_TAG,
					"Question from editor",
					USER_QUESTION_CLOSE_TAG,
				].join("\n"),
				timestamp: expect.any(Number),
			});
		});
	});

	test("cancels without model call when the editor question is empty", async () => {
		// Purpose: /ask must not call the provider when the editor does not return a usable question.
		// Input and expected output: whitespace-only editor text produces one cancellation notification and no completion request.
		// Edge case: whitespace is trimmed before the empty-question decision.
		// Dependencies: this test uses a fake editor, fake model completion, and fake ExtensionAPI session-write methods.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model], "   ");
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("   ", ctx);

			expect(ctx.notifications).toEqual([
				{ message: "Ask cancelled", type: "info" },
			]);
			expect(completion.calls).toEqual([]);
			expect(pi.sessionWriteCalls).toEqual([]);
		});
	});

	test("does not call the model without interactive UI", async () => {
		// Purpose: /ask must avoid provider calls when the command cannot display editor, loader, or answer UI.
		// Input and expected output: non-interactive context exits before completion and session writes.
		// Edge case: inline arguments are present, so the UI guard is the only early-exit reason.
		// Dependencies: this test uses fake model completion and fake ExtensionAPI session-write methods.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake(
				[model],
				"Question from editor",
				[],
				{
					ok: true,
					apiKey: "ask-llm-api-key",
					headers: { "x-ask-llm": "enabled" },
				},
				false,
			);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Inline question", ctx);

			expect(completion.calls).toEqual([]);
			expect(pi.sessionWriteCalls).toEqual([]);
		});
	});

	test("escapes XML delimiters inside tagged user questions", async () => {
		// Purpose: user question tags must keep the question boundary unambiguous when the question contains XML-like text.
		// Input and expected output: angle brackets and ampersands are escaped inside the user_question block.
		// Edge case: a literal closing tag in the question must not close the wrapper tag early.
		// Dependencies: this test uses fake model completion and inspects only the direct provider request.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Use <tag> & </user_question>", ctx);

			expect(completion.calls[0]?.context.messages.at(-1)?.content).toBe(
				[
					USER_QUESTION_OPEN_TAG,
					"Use &lt;tag&gt; &amp; &lt;/user_question&gt;",
					USER_QUESTION_CLOSE_TAG,
				].join("\n"),
			);
		});
	});

	test("uses configured model, thinking, and custom system prompt", async () => {
		// Purpose: ask-llm config must control the direct model call without using current-session prompt text.
		// Input and expected output: configured provider/model and prompt file override current model and bundled prompt.
		// Edge case: current model remains available but must not be selected when config model.id is present.
		// Dependencies: this test uses temp config, temp prompt file, fake model registry, and fake completion.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFile = join(agentDir, "custom-system.md");
			await writeFile(promptFile, "Custom system prompt");
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "anthropic/claude-test", thinking: "high" },
				systemPromptFile: promptFile,
			});
			const currentModel = createModel("openai", "gpt-test");
			const configuredModel = createModel("anthropic", "claude-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([currentModel, configuredModel]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Use configured runtime", ctx);

			expect(completion.calls[0]?.model).toBe(configuredModel);
			expect(completion.calls[0]?.context.systemPrompt).toBe(
				"Custom system prompt",
			);
			expect(completion.calls[0]?.options?.reasoning).toBe("high");
		});
	});

	test("includes loaded project context files in ask-llm system prompt", async () => {
		// Purpose: ask-llm must preserve Pi-loaded project rules for the one-off model request.
		// Input and expected output: contextFiles with AGENTS.md and CLAUDE.md are appended to the ask-llm system prompt.
		// Edge case: project context comes from before_agent_start state, not from the conversation branch.
		// Dependencies: fake before_agent_start event, fake model registry, and fake completion function.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });
			emitBeforeAgentStartHandlers(pi, {
				systemPromptOptions: {
					contextFiles: [
						{
							path: "/tmp/project/AGENTS.md",
							content: "Project rule: use the project validation scripts.",
						},
						{
							path: "/tmp/project/CLAUDE.md",
							content: "Project rule: keep docs current.",
						},
					],
				},
			});

			await getAskCommand(pi).handler("Use project context", ctx);

			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"# Project Context",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"## /tmp/project/AGENTS.md",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"Project rule: use the project validation scripts.",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"## /tmp/project/CLAUDE.md",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"Project rule: keep docs current.",
			);
		});
	});

	test("replays persisted context projection state before calling ask-llm", async () => {
		// Purpose: ask-llm input must match the projected task state when context-projection has recorded omitted tool results.
		// Input and expected output: valid projection config plus persisted state replaces old tool output with the recorded placeholder.
		// Edge case: the one-off ask question is appended after projection replay.
		// Dependencies: temp context-projection config, fake model registry, fake completion function, and fake session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const placeholder = "[projected old output]";
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const entries = [
				createSessionMessageEntry("1", null, "hello"),
				createMessageEntry(
					"2",
					"1",
					createAssistantToolCallMessage("old-tool"),
				),
				createMessageEntry(
					"3",
					"2",
					createToolResultMessage("old-tool", "old full tool output"),
				),
				createProjectionStateEntry("4", "3", placeholder, "3"),
			];
			const ctx = createContextFake([model], "Question from editor", entries);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Should we proceed?", ctx);

			expect(completion.calls).toHaveLength(1);
			const askMessages = JSON.stringify(completion.calls[0]?.context.messages);
			expect(askMessages).toContain(placeholder);
			expect(askMessages).not.toContain("old full tool output");
			expect(completion.calls[0]?.context.messages.at(-1)?.content).toBe(
				[
					USER_QUESTION_OPEN_TAG,
					"Should we proceed?",
					USER_QUESTION_CLOSE_TAG,
				].join("\n"),
			);
		});
	});

	test("copies the rendered answer with Ctrl+Y without closing", async () => {
		// Purpose: the focused answer UI must let users copy the exact model answer without closing the dialog.
		// Input and expected output: Ctrl+Y copies the answer once, and Enter closes the already rendered answer view.
		// Edge case: copy is independent from close keys, so the command promise remains pending after Ctrl+Y.
		// Dependencies: this test uses fake model completion, fake clipboard dependency, and fake custom UI input.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake("Copyable answer");
			const clipboardWrites: string[] = [];
			const pi = createExtensionApiFake();
			const ctx = createContextFake(
				[model],
				"Question from editor",
				[],
				{
					ok: true,
					apiKey: "ask-llm-api-key",
					headers: { "x-ask-llm": "enabled" },
				},
				true,
				false,
			);
			askLlm(pi, {
				completeSimple: completion.completeSimple,
				copyToClipboard: async (text: string) => {
					clipboardWrites.push(text);
				},
			});

			let commandResolved = false;
			const commandPromise = getAskCommand(pi)
				.handler("Copy this", ctx)
				.then(() => {
					commandResolved = true;
				});
			const answerComponent = await waitForAnswerComponent(ctx);

			expect(answerComponent.render?.(100).join("\n")).toContain("Ctrl+Y");
			await answerComponent.handleInput?.("\x19");
			await Promise.resolve();

			expect(clipboardWrites).toEqual(["Copyable answer"]);
			expect(ctx.notifications).toEqual([
				{ message: "Answer copied to clipboard", type: "info" },
			]);
			expect(commandResolved).toBe(false);

			await answerComponent.handleInput?.("\r");
			await commandPromise;
			expect(commandResolved).toBe(true);
		});
	});

	test("reports clipboard copy failures without closing the answer", async () => {
		// Purpose: clipboard failures must be visible to the user and must not close the answer dialog.
		// Input and expected output: Ctrl+Y with a failing clipboard dependency reports one scoped warning.
		// Edge case: the answer remains open after copy failure and still closes on Enter.
		// Dependencies: this test uses fake model completion, fake clipboard dependency, and fake custom UI input.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake("Copyable answer");
			const pi = createExtensionApiFake();
			const ctx = createContextFake(
				[model],
				"Question from editor",
				[],
				{
					ok: true,
					apiKey: "ask-llm-api-key",
					headers: { "x-ask-llm": "enabled" },
				},
				true,
				false,
			);
			askLlm(pi, {
				completeSimple: completion.completeSimple,
				copyToClipboard: async () => {
					throw new Error("clipboard unavailable");
				},
			});

			let commandResolved = false;
			const commandPromise = getAskCommand(pi)
				.handler("Copy this", ctx)
				.then(() => {
					commandResolved = true;
				});
			const answerComponent = await waitForAnswerComponent(ctx);

			await answerComponent.handleInput?.("\x19");
			await Promise.resolve();

			expect(ctx.notifications).toEqual([
				{
					message:
						"[ask-llm] failed to copy answer to clipboard: clipboard unavailable",
					type: "warning",
				},
			]);
			expect(commandResolved).toBe(false);

			await answerComponent.handleInput?.("\r");
			await commandPromise;
			expect(commandResolved).toBe(true);
		});
	});

	test("reports invalid config without calling the model", async () => {
		// Purpose: invalid ask-llm config must fail inside ask-llm only and avoid unsafe provider calls.
		// Input and expected output: unsupported config keys produce one warning and no completion request.
		// Edge case: the command remains registered so the user can see the scoped config issue.
		// Dependencies: this test uses temp config, fake UI notifications, and fake completion observation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: true, unsupported: true });
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] config contains unsupported keys",
					type: "warning",
				},
			]);
		});
	});

	test("reports unreadable custom system prompt without calling the model", async () => {
		// Purpose: ask-llm must reject unreadable custom prompt files before a provider request.
		// Input and expected output: an absolute missing prompt path produces one scoped warning and no completion request.
		// Edge case: an absolute path reaches prompt loading instead of config validation.
		// Dependencies: this test uses temp config, fake UI notifications, and fake completion observation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				systemPromptFile: join(agentDir, "missing-system.md"),
			});
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: expect.stringContaining(
						"[ask-llm] failed to read system prompt:",
					),
					type: "warning",
				},
			]);
		});
	});

	test("reports empty custom system prompt without calling the model", async () => {
		// Purpose: ask-llm must reject empty custom prompt files before a provider request.
		// Input and expected output: whitespace-only prompt text produces one scoped warning and no completion request.
		// Edge case: whitespace is trimmed before the empty-prompt decision.
		// Dependencies: this test uses temp config, temp prompt file, fake UI notifications, and fake completion observation.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFile = join(agentDir, "empty-system.md");
			await writeFile(promptFile, "   ");
			await writeConfig(agentDir, {
				enabled: true,
				systemPromptFile: promptFile,
			});
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] system prompt must not be empty",
					type: "warning",
				},
			]);
		});
	});

	test("reports missing configured model without calling the model", async () => {
		// Purpose: ask-llm must resolve configured provider/model IDs through the pi model registry before a provider request.
		// Input and expected output: an unknown configured model produces one scoped warning and no completion request.
		// Edge case: the current model exists but must not be used when config names another model.
		// Dependencies: this test uses temp config, fake model registry, fake UI notifications, and fake completion observation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "anthropic/missing-model" },
			});
			const currentModel = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([currentModel]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] model anthropic/missing-model was not found",
					type: "warning",
				},
			]);
		});
	});

	test("rejects input that exceeds the model context window", async () => {
		// Purpose: ask-llm must fail before provider execution when the exact provider input is too large.
		// Input and expected output: a tiny model context window rejects a normal ask request without a completion call.
		// Edge case: rejection happens after model resolution but before provider execution.
		// Dependencies: this test uses fake model registry, fake completion function, and fake UI notifications.
		await withIsolatedAgentDir(async () => {
			const model = { ...createModel("openai", "gpt-test"), contextWindow: 1 };
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not fit", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] ask-llm input exceeds model context window",
					type: "warning",
				},
			]);
		});
	});

	test("retries retryable provider failures before showing the answer", async () => {
		// Purpose: ask-llm must retry transient provider failures inside command execution.
		// Input and expected output: first provider call throws a network error, second call renders the recovered answer.
		// Edge case: zero retry delay keeps the test deterministic and proves maxRetries controls provider calls.
		// Dependencies: temp config, fake model registry, and fake completeSimple sequence.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const completion = createCompletionSequenceFake([
				{ kind: "throw", error: new Error("network error: fetch failed") },
				{
					kind: "response",
					content: [{ type: "text", text: "answer after retry" }],
				},
			]);
			const pi = createExtensionApiFake();
			const ctx = createContextFake([createModel("openai", "gpt-test")]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Retry this", ctx);

			expect(completion.calls).toHaveLength(2);
			expect(ctx.renderedCustomOutputs.join("\n")).toContain(
				"answer after retry",
			);
		});
	});

	test("retries retryable provider error responses before showing the answer", async () => {
		// Purpose: provider responses with stopReason error must use the same retry path as thrown transient errors.
		// Input and expected output: first response has retryable error metadata, second response renders visible text.
		// Edge case: completeSimple resolves successfully but the assistant response marks the provider call as failed.
		// Dependencies: temp config, fake model registry, and fake completeSimple sequence.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const completion = createCompletionSequenceFake([
				{
					kind: "response",
					content: [],
					stopReason: "error",
					errorMessage: "provider returned error 503",
				},
				{
					kind: "response",
					content: [{ type: "text", text: "answer after error retry" }],
				},
			]);
			const pi = createExtensionApiFake();
			const ctx = createContextFake([createModel("openai", "gpt-test")]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Retry this", ctx);

			expect(completion.calls).toHaveLength(2);
			expect(ctx.renderedCustomOutputs.join("\n")).toContain(
				"answer after error retry",
			);
		});
	});

	test("does not retry aborted ask-llm requests", async () => {
		// Purpose: cancellation must stop ask-llm retry instead of starting another provider call.
		// Input and expected output: completeSimple throws AbortError and ask-llm reports one scoped warning.
		// Edge case: retry config allows retries, so abort classification is the only reason no retry happens.
		// Dependencies: temp config, fake model registry, and fake completeSimple sequence.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const abortError = new Error("user aborted ask-llm request");
			abortError.name = "AbortError";
			const completion = createCompletionSequenceFake([
				{ kind: "throw", error: abortError },
			]);
			const pi = createExtensionApiFake();
			const ctx = createContextFake([createModel("openai", "gpt-test")]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Abort this", ctx);

			expect(completion.calls).toHaveLength(1);
			expect(ctx.notifications).toEqual([
				{
					message:
						"[ask-llm] Ask LLM request failed: user aborted ask-llm request",
					type: "warning",
				},
			]);
		});
	});

	test("rejects invalid ask-llm retry config", async () => {
		// Purpose: retry config is external JSON and must fail closed when numeric limits are invalid.
		// Input and expected output: negative maxRetries produces one scoped warning before provider calls.
		// Edge case: the config object uses only supported keys except the invalid retry field value.
		// Dependencies: temp config, fake model registry, fake completion function, and in-memory UI notifications.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: -1, baseDelayMs: 0 },
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([createModel("openai", "gpt-test")]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] retry.maxRetries must be a non-negative integer",
					type: "warning",
				},
			]);
		});
	});

	test("reports unavailable model auth without calling the model", async () => {
		// Purpose: ask-llm must stop before provider calls when pi cannot provide model auth.
		// Input and expected output: model registry auth failure produces one scoped warning and no completion request.
		// Edge case: auth failure happens after model resolution but before prompt execution.
		// Dependencies: this test uses fake model auth, fake UI notifications, and fake completion observation.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model], "Question from editor", [], {
				ok: false,
				error: "missing token",
			});
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Will not call", ctx);

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] model auth unavailable: missing token",
					type: "warning",
				},
			]);
		});
	});

	test("reports provider error responses when retry is disabled", async () => {
		// Purpose: ask-llm must report provider-level error stop reasons when retry is disabled.
		// Input and expected output: a provider error response produces one scoped warning after one completion request.
		// Edge case: the provider error message is used when present.
		// Dependencies: this test uses temp config, fake model completion, and fake UI notifications.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			});
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake("Ignored answer", {
				stopReason: "error",
				errorMessage: "provider rejected request",
			});
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Call provider", ctx);

			expect(completion.calls).toHaveLength(1);
			expect(ctx.notifications).toEqual([
				{
					message:
						"[ask-llm] Ask LLM request failed: provider rejected request",
					type: "warning",
				},
			]);
		});
	});

	test("reports empty text responses", async () => {
		// Purpose: ask-llm must not show a blank answer when the provider response has no visible text.
		// Input and expected output: whitespace-only answer text produces one scoped warning after one completion request.
		// Edge case: response text is trimmed before the empty-response decision.
		// Dependencies: this test uses fake model completion and fake UI notifications.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "gpt-test");
			const completion = createCompletionFake("   ");
			const pi = createExtensionApiFake();
			const ctx = createContextFake([model]);
			askLlm(pi, { completeSimple: completion.completeSimple });

			await getAskCommand(pi).handler("Call provider", ctx);

			expect(completion.calls).toHaveLength(1);
			expect(ctx.notifications).toEqual([
				{
					message: "[ask-llm] model response did not contain text",
					type: "warning",
				},
			]);
		});
	});

	test("bundled default system prompt documents the user question tag", async () => {
		// Purpose: ask-llm must keep default prompt text in the extension prompt directory.
		// Input and expected output: the bundled prompt file is readable and documents the tag used by request-building logic.
		// Edge case: this test checks only prompt text that is part of the provider request contract.
		// Dependencies: this test reads only the package-owned default prompt file.
		const prompt = await readFile(
			join(import.meta.dir, "prompts", "system.md"),
			"utf8",
		);

		expect(prompt).toContain(USER_QUESTION_OPEN_TAG);
		expect(prompt).toContain(USER_QUESTION_CLOSE_TAG);
	});
});
