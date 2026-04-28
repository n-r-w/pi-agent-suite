import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import mainAgentSelection from "../../../pi-package/extensions/main-agent-selection/index";
import { getAgentRuntimeComposition } from "../../../pi-package/shared/agent-runtime-composition";
import { SUBAGENT_AGENT_ID_ENV } from "../../../pi-package/shared/subagent-environment";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const FRONTMATTER_MODEL_KEY = "model";
const FRONTMATTER_TOOLS_KEY = "tools";
const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

type MainAgentSelectionFactory = typeof mainAgentSelection;

interface RegisteredCommandFake {
	readonly name: string;
	readonly description?: string;
	readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

interface RegisteredShortcutFake {
	readonly shortcut: string;
	readonly description?: string;
	readonly handler: (ctx: unknown) => Promise<void> | void;
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly commands: RegisteredCommandFake[];
	readonly shortcuts: RegisteredShortcutFake[];
	readonly setModelCalls: Model<Api>[];
	readonly thinkingCalls: string[];
	readonly activeToolCalls: string[][];
}

interface ExtensionApiFakeOptions {
	readonly setModelResult?: boolean;
	readonly setModelResults?: readonly boolean[];
	readonly activeTools?: readonly string[];
	readonly allTools?: readonly string[];
}

interface CustomComponentFake {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
}

interface KeybindingsFake {
	matches(data: string, keybinding: string): boolean;
}

interface CommandContextFake {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly ui: {
		custom<T>(
			factory: (
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string },
				keybindings: unknown,
				done: (result: T) => void,
			) => CustomComponentFake | Promise<CustomComponentFake>,
		): Promise<T>;
		notify(message: string, type?: string): void;
		setStatus(key: string, text: string | undefined): void;
	};
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
}

interface AgentFixture {
	readonly id: string;
	readonly description: string;
	readonly body: string;
	readonly type?: "main" | "subagent" | "both";
	readonly model?: { readonly id?: string; readonly thinking?: string };
	readonly tools?: readonly string[];
}

/** Creates the ExtensionAPI fake needed to observe command, shortcut, event, model, and tool calls. */
function createExtensionApiFake(
	options: ExtensionApiFakeOptions = {},
): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const commands: RegisteredCommandFake[] = [];
	const shortcuts: RegisteredShortcutFake[] = [];
	const setModelCalls: Model<Api>[] = [];
	const thinkingCalls: string[] = [];
	const activeToolCalls: string[][] = [];
	let currentActiveTools = [...(options.activeTools ?? [])];
	const setModelResults = [...(options.setModelResults ?? [])];

	return {
		handlers,
		commands,
		shortcuts,
		setModelCalls,
		thinkingCalls,
		activeToolCalls,
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: RegisteredCommandFake["handler"];
			},
		): void {
			commands.push(
				options.description === undefined
					? { name, handler: options.handler }
					: {
							name,
							description: options.description,
							handler: options.handler,
						},
			);
		},
		registerShortcut(
			shortcut: string,
			options: {
				description?: string;
				handler: RegisteredShortcutFake["handler"];
			},
		): void {
			shortcuts.push(
				options.description === undefined
					? { shortcut, handler: options.handler }
					: {
							shortcut,
							description: options.description,
							handler: options.handler,
						},
			);
		},
		async setModel(model: Model<Api>): Promise<boolean> {
			setModelCalls.push(model);
			return setModelResults.shift() ?? options.setModelResult ?? true;
		},
		setThinkingLevel(level: string): void {
			thinkingCalls.push(level);
		},
		setActiveTools(toolNames: string[]): void {
			currentActiveTools = [...toolNames];
			activeToolCalls.push(toolNames);
		},
		getAllTools() {
			return (options.allTools ?? ["read", "bash", "edit", "write"]).map(
				(name) => ({
					name,
					description: name,
					parameters: {},
					sourceInfo: { path: "fake" },
				}),
			);
		},
		getActiveTools(): string[] {
			return [...currentActiveTools];
		},
		getCommands(): never[] {
			return [];
		},
		getThinkingLevel(): string {
			return "medium";
		},
		setLabel(): void {},
		modelRegistry: undefined,
	} as unknown as ExtensionApiFake;
}

/** Runs a test with isolated pi agent and subagent environment so state reads never touch real user files or child-process mode. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousSubagentAgentId = process.env[SUBAGENT_AGENT_ID_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-main-agent-selection-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[SUBAGENT_AGENT_ID_ENV];
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousSubagentAgentId === undefined) {
			delete process.env[SUBAGENT_AGENT_ID_ENV];
		} else {
			process.env[SUBAGENT_AGENT_ID_ENV] = previousSubagentAgentId;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Creates a fake model that can be resolved by provider/model ID. */
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

/** Writes one agent Markdown file with strict frontmatter and body. */
async function writeAgent(
	agentDir: string,
	agent: AgentFixture,
): Promise<void> {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	const frontmatter: Record<string, unknown> = {
		description: agent.description,
		type: agent.type ?? "main",
	};
	if (agent.model !== undefined) {
		frontmatter[FRONTMATTER_MODEL_KEY] = agent.model;
	}
	if (agent.tools !== undefined) {
		frontmatter[FRONTMATTER_TOOLS_KEY] = agent.tools;
	}

	const lines = [
		"---",
		...Object.entries(frontmatter).flatMap(([key, value]) => {
			if (Array.isArray(value)) {
				return [
					`${key}:`,
					...value.map((item) => `  - ${JSON.stringify(item)}`),
				];
			}
			if (typeof value === "object" && value !== null) {
				return [
					`${key}:`,
					...Object.entries(value).map(
						([childKey, childValue]) =>
							`  ${childKey}: ${JSON.stringify(childValue)}`,
					),
				];
			}

			return `${key}: ${JSON.stringify(value)}`;
		}),
		"---",
		agent.body,
	];

	await writeFile(join(agentDir, "agents", `${agent.id}.md`), lines.join("\n"));
}

/** Creates keybinding behavior for custom component input tests. */
function createKeybindingsFake(
	overrides: Readonly<Record<string, string>> = {},
): KeybindingsFake {
	return {
		matches(data: string, keybinding: string): boolean {
			if (overrides[data] !== undefined) {
				return overrides[data] === keybinding;
			}

			return (
				(data === "\n" && keybinding === "tui.select.confirm") ||
				(data === "\u001b" && keybinding === "tui.select.cancel") ||
				(data === "\u001b[A" && keybinding === "tui.select.up") ||
				(data === "\u001b[B" && keybinding === "tui.select.down")
			);
		},
	};
}

/** Creates command context with observable selection and notifications. */
function createCommandContext(
	cwd: string,
	selected?: string,
	models: readonly Model<Api>[] = [],
	hasUI?: boolean,
	customInputs: readonly string[] = [],
	keybindings: KeybindingsFake = createKeybindingsFake(),
): CommandContextFake & {
	readonly notifications: Notification[];
	readonly customCalls: Array<{
		readonly renderedLines: readonly string[];
	}>;
	readonly customCompletions: unknown[];
	readonly statusCalls: Array<{
		readonly key: string;
		readonly text: string | undefined;
	}>;
} {
	const notifications: Notification[] = [];
	const customCalls: Array<{
		readonly renderedLines: readonly string[];
	}> = [];
	const statusCalls: Array<{
		readonly key: string;
		readonly text: string | undefined;
	}> = [];
	const customCompletions: unknown[] = [];

	return {
		cwd,
		notifications,
		customCalls,
		customCompletions,
		statusCalls,
		...(hasUI !== undefined ? { hasUI } : {}),
		ui: {
			async custom<T>(
				factory: (
					tui: { requestRender(): void },
					theme: { fg(color: string, text: string): string },
					keybindings: unknown,
					done: (result: T) => void,
				) => CustomComponentFake | Promise<CustomComponentFake>,
			): Promise<T> {
				let result: T | undefined;
				const component = await factory(
					{ requestRender(): void {} },
					{ fg: (_color, text) => text },
					keybindings,
					(value) => {
						customCompletions.push(value);
						result = value;
					},
				);
				customCalls.push({ renderedLines: component.render(120) });
				for (const input of customInputs) {
					component.handleInput?.(input);
					customCalls.push({ renderedLines: component.render(120) });
				}
				return selected !== undefined ? (selected as T) : (result as T);
			},
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined): void {
				statusCalls.push({ key, text });
			},
		},
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined {
				return models.find(
					(model) => model.provider === provider && model.id === modelId,
				);
			},
		},
	};
}

/** Returns the registered slash command from the fake API. */
function getCommand(pi: ExtensionApiFake, name: string): RegisteredCommandFake {
	const command = pi.commands.find(
		(registeredCommand) => registeredCommand.name === name,
	);
	if (command === undefined) {
		throw new Error(`expected ${name} command to be registered`);
	}

	return command;
}

/** Returns the registered shortcut from the fake API. */
function getShortcut(
	pi: ExtensionApiFake,
	shortcut: string,
): RegisteredShortcutFake {
	const registeredShortcut = pi.shortcuts.find(
		(item) => item.shortcut === shortcut,
	);
	if (registeredShortcut === undefined) {
		throw new Error(`expected ${shortcut} shortcut to be registered`);
	}

	return registeredShortcut;
}

/** Returns one registered event handler from the fake API. */
function getHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => unknown {
	const handler = pi.handlers.find(
		(item) => item.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (event: unknown, ctx: unknown) => unknown;
}

/** Returns the before-agent-start handler from the fake API. */
function getBeforeAgentStartHandler(
	pi: ExtensionApiFake,
): (event: unknown, ctx: unknown) => unknown {
	return getHandler(pi, "before_agent_start");
}

/** Writes main-agent-selection configuration into the isolated config directory. */
async function writeMainAgentSelectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "main-agent-selection.json"),
		JSON.stringify(config),
	);
}

/** Returns the hash-based selected-agent state file name for one normalized working directory. */
function selectedAgentStateFileName(cwd: string): string {
	return `${createHash("sha256").update(cwd).digest(SELECTED_AGENT_STATE_HASH_ENCODING)}.json`;
}

/** Reads the only selected-agent state file written by a test. */
async function readOnlyStateFile(agentDir: string): Promise<unknown> {
	const stateDir = join(agentDir, "agent-selection", "state");
	const files = await readdir(stateDir);
	expect(files).toHaveLength(1);
	return JSON.parse(await readFile(join(stateDir, files[0] ?? ""), "utf8"));
}

/** Loads a fresh extension module instance, matching pi's hot session replacement loader behavior. */
async function importFreshMainAgentSelection(): Promise<MainAgentSelectionFactory> {
	const modulePath = `../../../pi-package/extensions/main-agent-selection/index.ts?fresh=${randomUUID()}`;
	const module = (await import(modulePath)) as {
		default: MainAgentSelectionFactory;
	};
	return module.default;
}

describe("main-agent-selection", () => {
	test("does not register agent command or shortcut when explicitly disabled", async () => {
		// Purpose: disabled main-agent-selection config must remove the selection command surface.
		// Input and expected output: enabled false leaves command and shortcut registries empty.
		// Edge case: missing agent files cannot mask config disablement.
		// Dependencies: this test uses an isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeMainAgentSelectionConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			mainAgentSelection(pi);

			expect(pi.commands).toEqual([]);
			expect(pi.shortcuts).toEqual([]);
		});
	});

	test("registers /agent command and Ctrl+Shift+A shortcut", async () => {
		// Purpose: the extension must expose both selection entry points.
		// Input and expected output: loading the factory registers /agent and Ctrl+Shift+A.
		// Edge case: registration happens before any session or agent files exist.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake.
		const pi = createExtensionApiFake();

		mainAgentSelection(pi);

		expect(getCommand(pi, "agent")).toMatchObject({ name: "agent" });
		expect(getShortcut(pi, "Ctrl+Shift+A")).toMatchObject({
			shortcut: "Ctrl+Shift+A",
		});
	});

	test("selects an agent through /agent, persists state, applies model and thinking, and publishes runtime contribution", async () => {
		// Purpose: explicit /agent selection must apply only selected main-agent behavior and persist minimal state.
		// Input and expected output: /agent builder selects builder, writes cwd and activeAgentId, sets model/thinking, tools, and prompt contribution.
		// Edge case: state file must not contain model, thinking level, or tools.
		// Dependencies: this test uses temp agent files, temp state, fake model calls, and runtime composition fake through ExtensionAPI.
		await withIsolatedAgentDir(async (agentDir) => {
			const model = createModel("openai", "gpt-test");
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
				model: { id: "openai/gpt-test", thinking: "high" },
				tools: ["read", "write"],
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project", undefined, [model]);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("builder", ctx);

			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "builder",
			});
			expect(pi.setModelCalls).toEqual([model]);
			expect(pi.thinkingCalls).toEqual(["high"]);
			expect(pi.activeToolCalls).toEqual([["read", "write"]]);
			expect(ctx.statusCalls).toEqual([]);
			expect(ctx.notifications).toEqual([]);

			const result = await getBeforeAgentStartHandler(pi)(
				{
					type: "before_agent_start",
					systemPrompt: "Base prompt",
				},
				ctx,
			);
			expect(result).toEqual({
				systemPrompt: "Base prompt\n\nBuilder system prompt",
			});
		});
	});

	test("does not apply external selected-agent state changes before reload when the session started without an agent", async () => {
		// Purpose: running sessions must not reread selected-agent state before each prompt.
		// Input and expected output: missing state at startup keeps mainAgentContribution undefined after an external Sage state file appears.
		// Edge case: the external state is valid for the current working directory.
		// Dependencies: this test uses the session_start and before_agent_start handlers from the shared runtime composition.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Sage",
				description: "Guides work",
				body: "Sage prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}

			await sessionStart({ type: "session_start", reason: "startup" }, ctx);
			await mkdir(join(agentDir, "agent-selection", "state"), {
				recursive: true,
			});
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "Sage" }),
			);

			expect(
				getAgentRuntimeComposition(pi).getMainAgentContribution(),
			).toBeUndefined();
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
			expect(
				getAgentRuntimeComposition(pi).getMainAgentContribution(),
			).toBeUndefined();
		});
	});

	test("reload rereads selected-agent state and updates runtime contribution", async () => {
		// Purpose: /reload must be the boundary where persisted selected-agent state affects the running session.
		// Input and expected output: missing state at startup then Sage state before reload publishes Sage prompt after reload.
		// Edge case: reload uses the same extension instance in this unit test, matching the observable session_start contract.
		// Dependencies: this test writes only isolated agent definitions and selected-agent state files.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Sage",
				description: "Guides work",
				body: "Sage prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}

			await sessionStart({ type: "session_start", reason: "startup" }, ctx);
			await mkdir(join(agentDir, "agent-selection", "state"), {
				recursive: true,
			});
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "Sage" }),
			);

			await sessionStart({ type: "session_start", reason: "reload" }, ctx);

			expect(
				getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id,
			).toBe("Sage");
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toEqual({ systemPrompt: "Base prompt\n\nSage prompt" });
		});
	});

	test("new session keeps current main-agent runtime contribution", async () => {
		// Purpose: /new must start a fresh chat without changing the active main agent.
		// Input and expected output: Coder is active, persisted state changes to Sage, and session_start reason new keeps Coder prompt active.
		// Edge case: the external state is valid and would switch the agent if /new reread selected-agent state.
		// Dependencies: this test uses only isolated agent files, selected-agent state, and in-memory session handlers.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Coder",
				description: "Writes code",
				body: "Coder prompt",
			});
			await writeAgent(agentDir, {
				id: "Sage",
				description: "Guides work",
				body: "Sage prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = getHandler(pi, "session_start");

			await getCommand(pi, "agent").handler("Coder", ctx);
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "Sage" }),
			);

			await sessionStart({ type: "session_start", reason: "new" }, ctx);

			expect(
				getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id,
			).toBe("Coder");
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toEqual({ systemPrompt: "Base prompt\n\nCoder prompt" });
		});
	});

	test("new session preserves current main agent across fresh extension instances", async () => {
		// Purpose: real /new replaces the extension runtime, so the selected main agent must cross that boundary.
		// Input and expected output: old Coder selection plus a later Sage state file still starts the new runtime with Coder prompt, tools, model, and thinking.
		// Edge case: each extension instance is imported separately to match pi's moduleCache false extension loader.
		// Dependencies: this test uses isolated agent files, selected-agent state, fake model calls, and fake runtime composition per ExtensionAPI instance.
		await withIsolatedAgentDir(async (agentDir) => {
			const model = createModel("openai", "gpt-test");
			await writeAgent(agentDir, {
				id: "Coder",
				description: "Writes code",
				body: "Coder prompt",
				model: { id: "openai/gpt-test", thinking: "high" },
				tools: ["read", "write"],
			});
			await writeAgent(agentDir, {
				id: "Sage",
				description: "Guides work",
				body: "Sage prompt",
			});
			const oldPi = createExtensionApiFake({
				activeTools: ["read", "bash"],
				allTools: ["read", "bash", "edit", "write"],
			});
			const oldCtx = createCommandContext("/tmp/project", undefined, [model]);
			const oldMainAgentSelection = await importFreshMainAgentSelection();
			oldMainAgentSelection(oldPi);

			await getCommand(oldPi, "agent").handler("Coder", oldCtx);
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "Sage" }),
			);
			await getHandler(oldPi, "session_shutdown")(
				{ type: "session_shutdown", reason: "new" },
				oldCtx,
			);

			const newPi = createExtensionApiFake({
				activeTools: ["read", "bash"],
				allTools: ["read", "bash", "edit", "write"],
			});
			const newCtx = createCommandContext("/tmp/project", undefined, [model]);
			const newMainAgentSelection = await importFreshMainAgentSelection();
			newMainAgentSelection(newPi);

			await getHandler(newPi, "session_start")(
				{ type: "session_start", reason: "new" },
				newCtx,
			);

			expect(newPi.setModelCalls).toEqual([model]);
			expect(newPi.thinkingCalls).toEqual(["high"]);
			expect(newPi.activeToolCalls).toEqual([["read", "write"]]);
			expect(
				getAgentRuntimeComposition(newPi).getMainAgentContribution()?.agent?.id,
			).toBe("Coder");
			expect(
				await getBeforeAgentStartHandler(newPi)(
					{ systemPrompt: "Base prompt" },
					newCtx,
				),
			).toEqual({ systemPrompt: "Base prompt\n\nCoder prompt" });
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "Sage",
			});
		});
	});

	test("new session handoff is consumed once", async () => {
		// Purpose: a /new handoff must not restore a stale agent after the first replacement runtime consumes it.
		// Input and expected output: Coder is restored once, then a second fresh new-session runtime without a preceding shutdown has no contribution.
		// Edge case: persisted state names Sage, but reason new must not reread disk after the handoff is gone.
		// Dependencies: this test uses fresh extension imports to simulate replacement runtimes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Coder",
				description: "Writes code",
				body: "Coder prompt",
			});
			await writeAgent(agentDir, {
				id: "Sage",
				description: "Guides work",
				body: "Sage prompt",
			});
			const oldPi = createExtensionApiFake();
			const oldCtx = createCommandContext("/tmp/project");
			const oldMainAgentSelection = await importFreshMainAgentSelection();
			oldMainAgentSelection(oldPi);

			await getCommand(oldPi, "agent").handler("Coder", oldCtx);
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "Sage" }),
			);
			await getHandler(oldPi, "session_shutdown")(
				{ type: "session_shutdown", reason: "new" },
				oldCtx,
			);

			const firstNewPi = createExtensionApiFake();
			const firstNewCtx = createCommandContext("/tmp/project");
			const firstNewMainAgentSelection = await importFreshMainAgentSelection();
			firstNewMainAgentSelection(firstNewPi);
			await getHandler(firstNewPi, "session_start")(
				{ type: "session_start", reason: "new" },
				firstNewCtx,
			);

			const secondNewPi = createExtensionApiFake();
			const secondNewCtx = createCommandContext("/tmp/project");
			const secondNewMainAgentSelection = await importFreshMainAgentSelection();
			secondNewMainAgentSelection(secondNewPi);
			await getHandler(secondNewPi, "session_start")(
				{ type: "session_start", reason: "new" },
				secondNewCtx,
			);

			expect(
				getAgentRuntimeComposition(firstNewPi).getMainAgentContribution()?.agent
					?.id,
			).toBe("Coder");
			expect(
				getAgentRuntimeComposition(secondNewPi).getMainAgentContribution(),
			).toBeUndefined();
			expect(
				await getBeforeAgentStartHandler(secondNewPi)(
					{ systemPrompt: "Base prompt" },
					secondNewCtx,
				),
			).toBeUndefined();
		});
	});

	test("reload rereads no-agent state and clears current main-agent runtime contribution", async () => {
		// Purpose: /reload must still apply a persisted No agent state.
		// Input and expected output: Coder is active, persisted state changes to null, and reload clears the prompt contribution.
		// Edge case: the active runtime contribution exists before reload.
		// Dependencies: this test uses only isolated agent files, selected-agent state, and in-memory session handlers.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Coder",
				description: "Writes code",
				body: "Coder prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}

			await getCommand(pi, "agent").handler("Coder", ctx);
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: null }),
			);

			await sessionStart({ type: "session_start", reason: "reload" }, ctx);

			expect(
				getAgentRuntimeComposition(pi).getMainAgentContribution(),
			).toBeUndefined();
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
		});
	});

	test("applies selected agent without status updates when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive selected-agent status UI calls.
		// Input and expected output: explicit /agent selection with hasUI false applies tools and writes state, but records no status calls.
		// Edge case: the UI object still has setStatus, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses temp agent files, temp state, fake tools, and runtime composition fake through ExtensionAPI.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
				tools: ["read"],
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project", undefined, [], false);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("builder", ctx);

			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "builder",
			});
			expect(pi.activeToolCalls).toEqual([["read"]]);
			expect(ctx.statusCalls).toEqual([]);
			expect(ctx.notifications).toEqual([]);
		});
	});

	test("resolves main-agent wildcard tool policy before applying active tools", async () => {
		// Purpose: main-agent tools must use the same exact-name and wildcard policy as child subagent tools.
		// Input and expected output: /agent coder resolves team_* and asteria_* against the registered tool list before setActiveTools().
		// Edge case: wildcard expansion preserves configured order and expands only matching registered tools.
		// Dependencies: this test uses temp agent files, fake tool registry, and runtime composition fake through ExtensionAPI.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Codes",
				body: "Coder system prompt",
				tools: [
					"consult_advisor",
					"run_subagent",
					"read",
					"team_*",
					"asteria_*",
				],
			});
			const pi = createExtensionApiFake({
				allTools: [
					"consult_advisor",
					"run_subagent",
					"read",
					"bash",
					"team_topic_list",
					"team_message_get",
					"asteria_find_symbol",
					"asteria_find_referencing_symbols",
				],
			});
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("coder", ctx);

			expect(pi.activeToolCalls).toEqual([
				[
					"consult_advisor",
					"run_subagent",
					"read",
					"team_topic_list",
					"team_message_get",
					"asteria_find_symbol",
					"asteria_find_referencing_symbols",
				],
			]);
			expect(ctx.notifications).toEqual([]);
		});
	});

	test("rejects invalid main-agent tool policy without persisting stale selection", async () => {
		// Purpose: invalid main-agent tool policy must fail closed instead of applying partial tools or persisting a broken agent.
		// Input and expected output: /agent coder with missing team_* match reports an issue, clears selection state, and does not call setActiveTools().
		// Edge case: wildcard validation fails before active-tool mutation.
		// Dependencies: this test uses temp agent files, fake tool registry, and temp selected-agent state.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Codes",
				body: "Coder system prompt",
				tools: ["read", "team_*"],
			});
			const pi = createExtensionApiFake({ allTools: ["read", "bash"] });
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("coder", ctx);

			expect(pi.activeToolCalls).toEqual([]);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: null,
			});
			expect(ctx.notifications).toEqual([
				{
					message:
						"[main-agent-selection] tool pattern team_* did not match any available tool",
					type: "warning",
				},
			]);
		});
	});

	test("clears selection through /agent none and the No agent selector option", async () => {
		// Purpose: the explicit no-agent state must remove the active main-agent prompt and tool policy.
		// Input and expected output: selecting builder then /agent none stores activeAgentId null, restores baseline tools, and publishes no prompt.
		// Edge case: the interactive selector must also expose the No agent option and clear the same state.
		// Dependencies: this test uses temp agent files, temp state, fake model calls, and runtime composition fake through ExtensionAPI.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
				tools: ["write"],
			});
			const pi = createExtensionApiFake({ activeTools: ["read"] });
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("builder", ctx);
			await getCommand(pi, "agent").handler("none", ctx);

			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: null,
			});
			expect(pi.activeToolCalls).toEqual([["write"], ["read"]]);
			expect(ctx.statusCalls).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();

			const selectorCtx = createCommandContext("/tmp/project", "__none__");
			await getShortcut(pi, "Ctrl+Shift+A").handler(selectorCtx);

			expect(selectorCtx.customCalls[0]?.renderedLines).toContain("→ No agent");
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: null,
			});
		});
	});

	test("restores the current agent when opening the /agent selector", async () => {
		// Purpose: opening /agent without arguments must highlight the current directory selection.
		// Input and expected output: persisted reviewer state renders reviewer as the selected row.
		// Edge case: No agent remains present but is not selected when an agent is active.
		// Dependencies: this test uses temp agent files, temp state, and an in-memory custom UI component.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("reviewer", selectionCtx);

			const dialogCtx = createCommandContext("/tmp/project");
			await getCommand(pi, "agent").handler("", dialogCtx);

			const renderedLines = dialogCtx.customCalls[0]?.renderedLines ?? [];
			expect(renderedLines).toContain("  No agent");
			expect(renderedLines).toContain("  builder — Builds code");
			expect(renderedLines).toContain("→ reviewer — Reviews code");
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "reviewer",
			});
		});
	});

	test("filters the /agent selector by typed substring", async () => {
		// Purpose: typing in the /agent selector must immediately narrow visible agent options.
		// Input and expected output: entering "view" shows reviewer because the visible row contains "Reviews" and hides builder.
		// Edge case: matching uses a substring that is not at the start of the agent ID.
		// Dependencies: this test uses temp agent files and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["view"],
			);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("", ctx);

			const renderedAfterSearch = ctx.customCalls.at(-1)?.renderedLines ?? [];
			expect(renderedAfterSearch).toContain("→ reviewer — Reviews code");
			expect(renderedAfterSearch).not.toContain("  builder — Builds code");
		});
	});

	test("filters the /agent selector case-insensitively and reports empty matches", async () => {
		// Purpose: selector search must be case-insensitive and show an empty-result state when no agent row matches.
		// Input and expected output: entering "REVIEW" shows reviewer, then replacing it with "missing" shows no matches.
		// Edge case: uppercase input must match lowercase visible text, and unmatched input must not leave stale rows visible.
		// Dependencies: this test uses temp agent files and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["REVIEW", "\u0015", "missing"],
			);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("", ctx);

			expect(ctx.customCalls[1]?.renderedLines).toContain(
				"→ reviewer — Reviews code",
			);
			const renderedAfterMissing = ctx.customCalls.at(-1)?.renderedLines ?? [];
			expect(renderedAfterMissing).toContain("  No matching agents");
			expect(renderedAfterMissing).not.toContain("  builder — Builds code");
			expect(renderedAfterMissing).not.toContain("→ reviewer — Reviews code");
		});
	});

	test("keeps the current agent highlighted when filtering leaves it available", async () => {
		// Purpose: filtering must not reset the highlighted row away from the current agent when it still matches.
		// Input and expected output: reviewer is active, "project" matches builder and reviewer, and reviewer stays highlighted.
		// Edge case: the active agent remains second in the filtered list rather than becoming the first visible match.
		// Dependencies: this test uses temp agent files, temp selected-agent state, and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds project",
				body: "Builder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews project",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("reviewer", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["project"],
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			const renderedAfterSearch =
				dialogCtx.customCalls.at(-1)?.renderedLines ?? [];
			expect(renderedAfterSearch).toContain("  builder — Builds project");
			expect(renderedAfterSearch).toContain("→ reviewer — Reviews project");
			expect(renderedAfterSearch).not.toContain("→ builder — Builds project");
		});
	});

	test("keeps the filtered candidate active after clearing the /agent selector search", async () => {
		// Purpose: clearing the search must preserve the local menu candidate chosen while the previous active agent was hidden.
		// Input and expected output: coder is active, "team" leaves only Team Lead visible, clearing the query keeps Team Lead highlighted and Enter applies it.
		// Edge case: the previously active agent becomes visible again after clearing the filter but must not steal the local menu selection.
		// Dependencies: this test uses temp agent files, temp selected-agent state, and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Writes code",
				body: "Coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "team-lead",
				description: "Team Lead",
				body: "Team lead system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("coder", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["team", "\u0015", "\n"],
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			expect(dialogCtx.customCalls[1]?.renderedLines).toContain(
				"→ team-lead — Team Lead",
			);
			expect(dialogCtx.customCalls[2]?.renderedLines).toContain(
				"→ team-lead — Team Lead",
			);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "team-lead",
			});
		});
	});

	test("keeps the persisted /agent selection unchanged when cancelling after filtering", async () => {
		// Purpose: Escape must close the filtered selector without applying the local menu candidate.
		// Input and expected output: coder is active, "team" highlights Team Lead, Escape keeps coder persisted.
		// Edge case: the local candidate differs from the persisted active agent when cancellation happens.
		// Dependencies: this test uses temp agent files, temp selected-agent state, and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Writes code",
				body: "Coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "team-lead",
				description: "Team Lead",
				body: "Team lead system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("coder", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["team", "\u001b"],
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			expect(dialogCtx.customCalls[1]?.renderedLines).toContain(
				"→ team-lead — Team Lead",
			);
			expect(dialogCtx.customCompletions).toEqual([undefined]);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "coder",
			});
		});
	});

	test("filters the /agent selector by agent ID text", async () => {
		// Purpose: search must match the ID part of the visible `id — description` row.
		// Input and expected output: entering "alpha" shows alpha-coder even though the description does not contain "alpha".
		// Edge case: ID-only matches must not depend on the description text.
		// Dependencies: this test uses temp agent files and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "alpha-coder",
				description: "Writes code",
				body: "Alpha coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["alpha"],
			);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("", ctx);

			const renderedAfterSearch = ctx.customCalls.at(-1)?.renderedLines ?? [];
			expect(renderedAfterSearch).toContain("→ alpha-coder — Writes code");
			expect(renderedAfterSearch).not.toContain("  reviewer — Reviews code");
		});
	});

	test("keeps a navigated filtered candidate active after clearing the /agent selector search", async () => {
		// Purpose: navigation inside a filtered multi-match list must update the local menu candidate.
		// Input and expected output: injected Down moves from alpha to beta, clearing search keeps beta highlighted, and Enter applies beta.
		// Edge case: the navigated candidate differs from the first filtered result and from the persisted active agent.
		// Dependencies: this test uses temp agent files, temp selected-agent state, injected keybindings, and custom UI input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Writes code",
				body: "Coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "alpha-team",
				description: "Alpha group",
				body: "Alpha team system prompt",
			});
			await writeAgent(agentDir, {
				id: "beta-team",
				description: "Beta group",
				body: "Beta team system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("coder", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["team", "next", "\u0015", "choose"],
				createKeybindingsFake({
					next: "tui.select.down",
					choose: "tui.select.confirm",
				}),
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			expect(dialogCtx.customCalls[1]?.renderedLines).toContain(
				"→ alpha-team — Alpha group",
			);
			expect(dialogCtx.customCalls[2]?.renderedLines).toContain(
				"→ beta-team — Beta group",
			);
			expect(dialogCtx.customCalls[3]?.renderedLines).toContain(
				"→ beta-team — Beta group",
			);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "beta-team",
			});
		});
	});

	test("keeps filtered navigation local when cancelling the /agent selector", async () => {
		// Purpose: filtered arrow navigation must not persist selection before Enter.
		// Input and expected output: Down highlights beta-team, Escape closes the selector, and coder remains persisted.
		// Edge case: the local candidate changed through navigation rather than automatic first-match selection.
		// Dependencies: this test uses temp agent files, temp selected-agent state, injected keybindings, and custom UI input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Writes code",
				body: "Coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "alpha-team",
				description: "Alpha group",
				body: "Alpha team system prompt",
			});
			await writeAgent(agentDir, {
				id: "beta-team",
				description: "Beta group",
				body: "Beta team system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("coder", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["team", "next", "cancel"],
				createKeybindingsFake({
					next: "tui.select.down",
					cancel: "tui.select.cancel",
				}),
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			expect(dialogCtx.customCalls[2]?.renderedLines).toContain(
				"→ beta-team — Beta group",
			);
			expect(dialogCtx.customCompletions).toEqual([undefined]);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "coder",
			});
		});
	});

	test("keeps the persisted /agent selection unchanged when confirming an empty filter result", async () => {
		// Purpose: Enter on an empty filtered list must not apply a stale local menu candidate.
		// Input and expected output: coder remains persisted after entering a missing query and pressing Enter.
		// Edge case: a stale candidate existed before the no-match query.
		// Dependencies: this test uses temp agent files, temp selected-agent state, and an in-memory custom UI component with input simulation.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "coder",
				description: "Writes code",
				body: "Coder system prompt",
			});
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const selectionCtx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			await getCommand(pi, "agent").handler("coder", selectionCtx);

			const dialogCtx = createCommandContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				["missing", "\n"],
			);
			await getCommand(pi, "agent").handler("", dialogCtx);

			const renderedAfterSearch = dialogCtx.customCalls[1]?.renderedLines ?? [];
			expect(renderedAfterSearch).toContain("  No matching agents");
			expect(dialogCtx.customCompletions).toEqual([]);
			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "coder",
			});
		});
	});

	test("selects an agent through Ctrl+Shift+A", async () => {
		// Purpose: keyboard shortcut must use the same selection behavior as /agent.
		// Input and expected output: selector returns reviewer, state stores reviewer, and prompt contribution changes.
		// Edge case: selection by option value must map back to the selected agent ID.
		// Dependencies: this test uses temp agent files and an in-memory shortcut context.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project", "reviewer");
			mainAgentSelection(pi);

			await getShortcut(pi, "Ctrl+Shift+A").handler(ctx);

			expect(await readOnlyStateFile(agentDir)).toEqual({
				cwd: "/tmp/project",
				activeAgentId: "reviewer",
			});
			const result = await getBeforeAgentStartHandler(pi)(
				{
					type: "before_agent_start",
					systemPrompt: "Base prompt",
				},
				ctx,
			);
			expect(result).toEqual({
				systemPrompt: "Base prompt\n\nReviewer system prompt",
			});
		});
	});

	test("reports invalid selected-agent state without applying stale model or tools", async () => {
		// Purpose: invalid state must fail closed instead of being silently migrated or applied.
		// Input and expected output: current-cwd state with unsupported model field produces a main-agent-selection warning and no model/tool calls.
		// Edge case: the state file exists under the selected-agent state directory but violates the strict schema.
		// Dependencies: this test uses temp state and an in-memory session_start context.
		await withIsolatedAgentDir(async (agentDir) => {
			await mkdir(join(agentDir, "agent-selection", "state"), {
				recursive: true,
			});
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({
					cwd: "/tmp/project",
					activeAgentId: "builder",
					model: "bad",
				}),
			);
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}

			await sessionStart({ type: "session_start", reason: "startup" }, ctx);

			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0]?.message).toStartWith(
				"[main-agent-selection]",
			);
			expect(ctx.notifications[0]?.type).toBe("warning");
			expect(pi.setModelCalls).toEqual([]);
			expect(pi.activeToolCalls).toEqual([]);
		});
	});

	test("fails closed when model application fails", async () => {
		// Purpose: a selected agent must not publish prompt, tools, thinking, or runtime contribution when its configured model cannot be applied.
		// Input and expected output: setModel returns false, selection reports a warning, and no runtime contribution is applied.
		// Edge case: the agent also defines thinking and tools, which must remain unapplied after model failure.
		// Dependencies: this test uses a fake model registry and fake setModel result.
		await withIsolatedAgentDir(async (agentDir) => {
			const model = createModel("openai", "gpt-test");
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
				model: { id: "openai/gpt-test", thinking: "high" },
				tools: ["write"],
			});
			const pi = createExtensionApiFake({ setModelResult: false });
			const ctx = createCommandContext("/tmp/project", undefined, [model]);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("builder", ctx);

			expect(ctx.notifications[0]?.message).toStartWith(
				"[main-agent-selection]",
			);
			expect(ctx.notifications[0]?.type).toBe("warning");
			expect(pi.thinkingCalls).toEqual([]);
			expect(pi.activeToolCalls).toEqual([]);
			expect(ctx.statusCalls).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
		});
	});

	test("resolves model IDs that contain slash characters after the provider", async () => {
		// Purpose: valid pi model IDs may contain slash characters after the provider segment.
		// Input and expected output: openrouter/ai21/jamba-large-1.7 resolves to provider openrouter and model ID ai21/jamba-large-1.7.
		// Edge case: only the first slash separates provider from model ID.
		// Dependencies: this test uses a fake model registry with a slash-containing model ID.
		await withIsolatedAgentDir(async (agentDir) => {
			const model = createModel("openrouter", "ai21/jamba-large-1.7");
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
				model: { id: "openrouter/ai21/jamba-large-1.7" },
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project", undefined, [model]);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("builder", ctx);

			expect(ctx.notifications).toEqual([]);
			expect(pi.setModelCalls).toEqual([model]);
		});
	});

	test("skips agents with malformed model IDs during registry loading", async () => {
		// Purpose: agent model IDs must be validated at the shared agent-registry boundary instead of failing later in one extension path.
		// Input and expected output: an agent with model.id missing provider/model shape is not selectable, while a valid agent remains available.
		// Edge case: model.thinking-only agents remain valid because model.id is optional.
		// Dependencies: this test writes temporary Markdown agent files only.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "broken",
				description: "Broken model id",
				body: "Broken prompt",
				model: { id: "missing-provider-separator" },
			});
			await writeAgent(agentDir, {
				id: "valid",
				description: "Valid agent",
				body: "Valid prompt",
				model: { thinking: "high" },
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("broken", ctx);

			expect(ctx.notifications).toEqual([
				{
					message: "[main-agent-selection] agent broken was not found",
					type: "warning",
				},
			]);
			await getCommand(pi, "agent").handler("valid", ctx);
			expect(pi.thinkingCalls).toEqual(["high"]);
		});
	});

	test("uses hash-based selected-agent state filenames for long working directories", async () => {
		// Purpose: selected-agent state filenames must stay below filesystem name-length limits for long working directories.
		// Input and expected output: a long cwd writes one fixed-length hash filename.
		// Edge case: the raw cwd would be too long for an encodeURIComponent-based filename.
		// Dependencies: this test writes only isolated selected-agent state files and temp agent definitions.
		await withIsolatedAgentDir(async (agentDir) => {
			const longProjectDir = join(tmpdir(), "p".repeat(260));
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext(longProjectDir);
			mainAgentSelection(pi);

			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}
			await sessionStart({ type: "session_start", reason: "startup" }, ctx);

			expect(ctx.notifications).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
			await getCommand(pi, "agent").handler("builder", ctx);
			const stateDir = join(agentDir, "agent-selection", "state");
			const files = await readdir(stateDir);
			const hashFileName = selectedAgentStateFileName(longProjectDir);

			expect(files).toContain(hashFileName);
			expect(Buffer.byteLength(hashFileName, "utf8")).toBeLessThanOrEqual(255);
			expect(
				JSON.parse(await readFile(join(stateDir, hashFileName), "utf8")),
			).toEqual({ cwd: longProjectDir, activeAgentId: "builder" });
		});
	});

	test("does not read legacy encodeURIComponent selected-agent state filenames", async () => {
		// Purpose: selected-agent state reads must use only the hash-based filename format.
		// Input and expected output: a matching legacy encoded state file exists but selected-agent state remains unset.
		// Edge case: the legacy file content is otherwise valid for the current cwd.
		// Dependencies: this test writes only isolated selected-agent state files and temp agent definitions.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "builder",
				description: "Builds code",
				body: "Builder system prompt",
			});
			await mkdir(join(agentDir, "agent-selection", "state"), {
				recursive: true,
			});
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					`${encodeURIComponent("/tmp/project")}.json`,
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "builder" }),
			);
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}
			await sessionStart({ type: "session_start", reason: "startup" }, ctx);

			expect(ctx.notifications).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
		});
	});

	test("clears previous runtime contribution when a later model application fails", async () => {
		// Purpose: fail-closed behavior must remove stale prompt, tools, and runtime contribution from the previous agent.
		// Input and expected output: first agent succeeds, second agent setModel returns false, baseline tools and empty prompt are restored.
		// Edge case: the previous agent had both prompt and restricted tools.
		// Dependencies: this test uses ordered fake setModel results and fake active-tool state.
		await withIsolatedAgentDir(async (agentDir) => {
			const writerModel = createModel("openai", "writer");
			const brokenModel = createModel("openai", "broken");
			await writeAgent(agentDir, {
				id: "writer",
				description: "Writes code",
				body: "Writer prompt",
				model: { id: "openai/writer" },
				tools: ["write"],
			});
			await writeAgent(agentDir, {
				id: "broken",
				description: "Broken model",
				body: "Broken prompt",
				model: { id: "openai/broken" },
				tools: ["bash"],
			});
			const pi = createExtensionApiFake({
				activeTools: ["read"],
				setModelResults: [true, false],
			});
			const ctx = createCommandContext("/tmp/project", undefined, [
				writerModel,
				brokenModel,
			]);
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("writer", ctx);
			await getCommand(pi, "agent").handler("broken", ctx);

			expect(ctx.notifications[0]?.message).toStartWith(
				"[main-agent-selection]",
			);
			expect(pi.activeToolCalls).toEqual([["write"], ["read"]]);
			expect(ctx.statusCalls).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toBeUndefined();
		});
	});

	test("ignores invalid state files for other working directories", async () => {
		// Purpose: one corrupt project state must not block valid restoration for the current working directory.
		// Input and expected output: unrelated invalid state is ignored, current state restores reviewer.
		// Edge case: both files live under the same selected-agent state directory.
		// Dependencies: this test uses deterministic temp state files and temp agent files.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "reviewer",
				description: "Reviews code",
				body: "Reviewer system prompt",
			});
			await mkdir(join(agentDir, "agent-selection", "state"), {
				recursive: true,
			});
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/other"),
				),
				"{",
			);
			await writeFile(
				join(
					agentDir,
					"agent-selection",
					"state",
					selectedAgentStateFileName("/tmp/project"),
				),
				JSON.stringify({ cwd: "/tmp/project", activeAgentId: "reviewer" }),
			);
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);
			const sessionStart = pi.handlers.find(
				(item) => item.eventName === "session_start",
			)?.handler;
			if (typeof sessionStart !== "function") {
				throw new Error("expected session_start handler to be registered");
			}

			await sessionStart({ type: "session_start", reason: "startup" }, ctx);

			expect(ctx.notifications).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toEqual({
				systemPrompt: "Base prompt\n\nReviewer system prompt",
			});
		});
	});

	test("normalizes cwd before writing and restoring selected-agent state", async () => {
		// Purpose: state ownership must be per normalized working directory, not per raw cwd string.
		// Input and expected output: selecting from a path with `..` stores and restores the normalized project path.
		// Edge case: restore uses a different representation of the same path.
		// Dependencies: this test uses real temporary directories for path normalization.
		await withIsolatedAgentDir(async (agentDir) => {
			const projectDir = await mkdtemp(
				join(tmpdir(), "pi-main-agent-project-"),
			);
			try {
				const nestedDir = join(projectDir, "nested");
				await mkdir(nestedDir);
				await writeAgent(agentDir, {
					id: "builder",
					description: "Builds code",
					body: "Builder system prompt",
				});
				const pi = createExtensionApiFake();
				const rawCtx = createCommandContext(`${nestedDir}/..`);
				mainAgentSelection(pi);

				await getCommand(pi, "agent").handler("builder", rawCtx);

				expect(await readOnlyStateFile(agentDir)).toEqual({
					cwd: projectDir,
					activeAgentId: "builder",
				});
				const restoreCtx = createCommandContext(projectDir);
				const sessionStart = pi.handlers.find(
					(item) => item.eventName === "session_start",
				)?.handler;
				if (typeof sessionStart !== "function") {
					throw new Error("expected session_start handler to be registered");
				}

				await sessionStart(
					{ type: "session_start", reason: "startup" },
					restoreCtx,
				);

				expect(restoreCtx.notifications).toEqual([]);
			} finally {
				await rm(projectDir, { recursive: true, force: true });
			}
		});
	});

	test("skips malformed agent files while loading valid agent definitions", async () => {
		// Purpose: malformed frontmatter must not break the whole agent registry.
		// Input and expected output: one malformed file and one valid file still allow selecting the valid agent.
		// Edge case: malformed YAML throws from parseFrontmatter.
		// Dependencies: this test writes temporary Markdown agent files only.
		await withIsolatedAgentDir(async (agentDir) => {
			await mkdir(join(agentDir, "agents"), { recursive: true });
			await writeFile(
				join(agentDir, "agents", "broken.md"),
				"---\nmodel: [\n---\nBroken",
			);
			await writeAgent(agentDir, {
				id: "valid",
				description: "Valid agent",
				body: "Valid system prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("valid", ctx);

			expect(ctx.notifications).toEqual([]);
			expect(
				await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base prompt" },
					ctx,
				),
			).toEqual({
				systemPrompt: "Base prompt\n\nValid system prompt",
			});
		});
	});

	test("restores baseline active tools when switching to an agent without tools", async () => {
		// Purpose: omitted tools must not leak a previous agent-specific tool policy.
		// Input and expected output: first agent applies write-only tools, second agent without tools restores baseline tools.
		// Edge case: baseline tools are captured before the first main-agent contribution.
		// Dependencies: this test observes active-tool calls through the shared runtime composition fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "writer",
				description: "Writes code",
				body: "Writer prompt",
				tools: ["write"],
			});
			await writeAgent(agentDir, {
				id: "planner",
				description: "Plans work",
				body: "Planner prompt",
			});
			const pi = createExtensionApiFake({ activeTools: ["read", "bash"] });
			const ctx = createCommandContext("/tmp/project");
			mainAgentSelection(pi);

			await getCommand(pi, "agent").handler("writer", ctx);
			await getCommand(pi, "agent").handler("planner", ctx);

			expect(pi.activeToolCalls).toEqual([["write"], ["read", "bash"]]);
		});
	});
});
