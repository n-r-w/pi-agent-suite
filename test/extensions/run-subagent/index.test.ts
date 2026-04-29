import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import mainAgentSelection from "../../../pi-package/extensions/main-agent-selection/index";
import runSubagent from "../../../pi-package/extensions/run-subagent/index";
import { COLLAPSED_SUBAGENT_RESULT_LINES } from "../../../pi-package/extensions/run-subagent/rendering";
import {
	createSubagentWidgetFactory,
	createSubagentWidgetState,
	formatSubagentWidgetPanel,
	recordSubagentWidgetRun,
} from "../../../pi-package/extensions/run-subagent/widget";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOLS_ENV,
} from "../../../pi-package/shared/subagent-environment";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEPTH_ENV = SUBAGENT_DEPTH_ENV;
const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

/** SGR reset sequence that would break parent panel styling when embedded in truncated text. */
const SGR_RESET = `${String.fromCharCode(27)}[0m`;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ToolInfoFake {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly sourceInfo: { readonly path: string };
}

interface RegisteredCommandFake {
	readonly name: string;
	readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
	readonly commands: RegisteredCommandFake[];
	readonly activeToolCalls: string[][];
	readonly setModelCalls: Model<Api>[];
	readonly thinkingCalls: string[];
}

interface SpawnCall {
	readonly command: string;
	readonly args: string[];
	readonly options: {
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly signal: AbortSignal | undefined;
	};
	readonly process: SpawnedProcessFake;
}

interface SpawnedProcessStdinFake extends EventEmitter {
	readonly writes: string[];
	ended: boolean;
	write(data: string): boolean;
	end(): void;
	on(event: "error", handler: (error: Error) => void): this;
	on(event: "write", handler: (data: string) => void): this;
	on(event: "end", handler: () => void): this;
}

interface SpawnedProcessFake extends EventEmitter {
	readonly stdin: SpawnedProcessStdinFake;
	readonly stdout: EventEmitter;
	readonly stderr: EventEmitter;
	readonly killedSignals: string[];
	kill(signal?: string): boolean;
	on(event: "close", handler: (code: number | null) => void): this;
	on(event: "error", handler: (error: Error) => void): this;
}

/** Fake child stdin that records RPC commands and shutdown. */
class SpawnedProcessStdinFakeImpl
	extends EventEmitter
	implements SpawnedProcessStdinFake
{
	public readonly writes: string[] = [];
	public ended = false;

	public write(data: string): boolean {
		this.writes.push(data);
		this.emit("write", data);
		return true;
	}

	public end(): void {
		this.ended = true;
		this.emit("end");
	}
}

/** Fake child process with stdin, stdout, stderr, close, error, and kill behavior. */
class SpawnedProcessFakeImpl
	extends EventEmitter
	implements SpawnedProcessFake
{
	public readonly stdin = new SpawnedProcessStdinFakeImpl();
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public readonly killedSignals: string[] = [];

	public kill(signal = "SIGTERM"): boolean {
		this.killedSignals.push(signal);
		return true;
	}
}

interface CommandContextFake {
	readonly cwd: string;
	readonly model: Model<Api> | undefined;
	readonly hasUI?: boolean;
	readonly ui: {
		notify(message: string, type?: string): void;
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, content: string[] | undefined): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
}

interface ContextObservations {
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}>;
	readonly statuses: Array<{
		readonly key: string;
		readonly text: string | undefined;
	}>;
	readonly widgets: Array<{
		readonly key: string;
		readonly content: unknown;
	}>;
}

/** Runs a test with an isolated pi agent directory and optional subagent depth. */
async function withIsolatedEnvironment<T>(
	action: (agentDir: string) => Promise<T>,
	depth?: string,
	childAgentId?: string,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousDepth = process.env[DEPTH_ENV];
	const previousChildAgentId = process.env[SUBAGENT_AGENT_ID_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-run-subagent-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	if (depth === undefined) {
		delete process.env[DEPTH_ENV];
	} else {
		process.env[DEPTH_ENV] = depth;
	}
	if (childAgentId === undefined) {
		delete process.env[SUBAGENT_AGENT_ID_ENV];
	} else {
		process.env[SUBAGENT_AGENT_ID_ENV] = childAgentId;
	}

	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousDepth === undefined) {
			delete process.env[DEPTH_ENV];
		} else {
			process.env[DEPTH_ENV] = previousDepth;
		}
		if (previousChildAgentId === undefined) {
			delete process.env[SUBAGENT_AGENT_ID_ENV];
		} else {
			process.env[SUBAGENT_AGENT_ID_ENV] = previousChildAgentId;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Creates a strict fake for ExtensionAPI behavior used by run-subagent and cross-extension tests. */
function createExtensionApiFake(
	allToolNames: readonly string[] = [],
): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const tools: ToolDefinition[] = [];
	const commands: RegisteredCommandFake[] = [];
	const activeToolCalls: string[][] = [];
	const setModelCalls: Model<Api>[] = [];
	const thinkingCalls: string[] = [];
	let currentActiveTools: string[] = [];

	return {
		handlers,
		tools,
		commands,
		activeToolCalls,
		setModelCalls,
		thinkingCalls,
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		registerCommand(
			name: string,
			options: { handler: RegisteredCommandFake["handler"] },
		): void {
			commands.push({ name, handler: options.handler });
		},
		registerShortcut(): void {},
		getAllTools(): ToolInfoFake[] {
			return allToolNames.map((name) => ({
				name,
				description: `${name} tool`,
				parameters: {},
				sourceInfo: { path: "fake" },
			}));
		},
		getActiveTools(): string[] {
			return [...currentActiveTools];
		},
		setActiveTools(toolNames: string[]): void {
			currentActiveTools = [...toolNames];
			activeToolCalls.push(toolNames);
		},
		getCommands(): never[] {
			return [];
		},
		getThinkingLevel(): string {
			return "medium";
		},
		setThinkingLevel(level: string): void {
			thinkingCalls.push(level);
		},
		async setModel(model: Model<Api>): Promise<boolean> {
			setModelCalls.push(model);
			return true;
		},
		setLabel(): void {},
		modelRegistry: undefined,
	} as unknown as ExtensionApiFake;
}

/** Creates a fake execution context with observable UI side effects. */
function createContext(
	cwd: string,
	model: Model<Api> | undefined = createModel("openai", "parent"),
	models: readonly Model<Api>[] = [],
	selected?: string,
	hasUI?: boolean,
): CommandContextFake & ContextObservations {
	const notifications: ContextObservations["notifications"] = [];
	const statuses: ContextObservations["statuses"] = [];
	const widgets: ContextObservations["widgets"] = [];

	return {
		cwd,
		model,
		notifications,
		statuses,
		widgets,
		...(hasUI !== undefined ? { hasUI } : {}),
		ui: {
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined): void {
				statuses.push({ key, text });
			},
			setWidget(key: string, content: unknown): void {
				widgets.push({ key, content });
			},
			async select(): Promise<string | undefined> {
				return selected;
			},
		},
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined {
				return models.find(
					(candidate) =>
						candidate.provider === provider && candidate.id === modelId,
				);
			},
		},
	};
}

/** Creates a model fixture with the fields needed by extension APIs. */
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

/** Writes one Markdown agent definition into the isolated agent registry. */
async function writeAgent(
	agentDir: string,
	agent: {
		readonly id: string;
		readonly type: "main" | "subagent" | "both";
		readonly description: string;
		readonly body: string;
		readonly model?: { readonly id?: string; readonly thinking?: string };
		readonly tools?: readonly string[];
		readonly agents?: readonly string[];
	},
): Promise<void> {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	const lines = [
		"---",
		`description: ${JSON.stringify(agent.description)}`,
		`type: ${JSON.stringify(agent.type)}`,
	];
	if (agent.model !== undefined) {
		lines.push("model:");
		if (agent.model.id !== undefined) {
			lines.push(`  id: ${JSON.stringify(agent.model.id)}`);
		}
		if (agent.model.thinking !== undefined) {
			lines.push(`  thinking: ${JSON.stringify(agent.model.thinking)}`);
		}
	}
	if (agent.tools !== undefined) {
		if (agent.tools.length === 0) {
			lines.push("tools: []");
		} else {
			lines.push("tools:");
			for (const tool of agent.tools) {
				lines.push(`  - ${JSON.stringify(tool)}`);
			}
		}
	}
	if (agent.agents !== undefined) {
		if (agent.agents.length === 0) {
			lines.push("agents: []");
		} else {
			lines.push("agents:");
			for (const subagent of agent.agents) {
				lines.push(`  - ${JSON.stringify(subagent)}`);
			}
		}
	}
	lines.push("---", agent.body);
	await writeFile(join(agentDir, "agents", `${agent.id}.md`), lines.join("\n"));
}

/** Writes run-subagent configuration into the isolated config directory. */
async function writeRunSubagentConfig(
	agentDir: string,
	content: string,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "run-subagent.json"), content);
}

/** Writes selected-agent state exactly where main-agent-selection restores it from. */
async function writeSelectedAgentState(
	agentDir: string,
	cwd: string,
	activeAgentId: string | null,
): Promise<void> {
	const stateDir = join(agentDir, "agent-selection", "state");
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		join(stateDir, selectedAgentStateFileName(cwd)),
		JSON.stringify({ cwd, activeAgentId }),
	);
}

/** Returns the hash-based selected-agent state file name for one normalized working directory. */
function selectedAgentStateFileName(cwd: string): string {
	return `${createHash("sha256").update(cwd).digest(SELECTED_AGENT_STATE_HASH_ENCODING)}.json`;
}

/** Returns the registered run_subagent tool from the fake API. */
function getRunSubagentTool(pi: ExtensionApiFake): ToolDefinition {
	const tool = pi.tools.find((candidate) => candidate.name === "run_subagent");
	if (tool === undefined) {
		throw new Error("expected run_subagent tool to be registered");
	}

	return tool;
}

/** Returns the before-agent-start handler registered by runtime composition. */
function getBeforeAgentStartHandler(
	pi: ExtensionApiFake,
): (event: unknown, ctx: unknown) => unknown {
	const handler = pi.handlers.find(
		(item) => item.eventName === "before_agent_start",
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error("expected before_agent_start handler to be registered");
	}

	return handler as (event: unknown, ctx: unknown) => unknown;
}

/** Runs before_agent_start handlers in registration order like pi does for one agent turn. */
async function runBeforeAgentStartHandlers(
	pi: ExtensionApiFake,
	event: { readonly systemPrompt: string },
	ctx: unknown,
): Promise<unknown> {
	let currentEvent = event;
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "before_agent_start",
	)) {
		if (typeof item.handler !== "function") {
			continue;
		}

		const result = await item.handler(currentEvent, ctx);
		if (isPromptResult(result)) {
			currentEvent = { systemPrompt: result.systemPrompt };
		}
	}

	return currentEvent.systemPrompt === event.systemPrompt
		? undefined
		: currentEvent;
}

/** Detects before_agent_start results that replace the system prompt. */
function isPromptResult(
	value: unknown,
): value is { readonly systemPrompt: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"systemPrompt" in value &&
		typeof value.systemPrompt === "string"
	);
}

/** Serializes an accepted prompt response followed by session events and completion. */
function rpcOutputLines(
	...events: readonly Record<string, unknown>[]
): readonly string[] {
	return [
		JSON.stringify({
			id: "run-subagent-prompt",
			type: "response",
			command: "prompt",
			success: true,
		}),
		...events.map((event) => JSON.stringify(event)),
		JSON.stringify({ type: "agent_end", messages: [] }),
	];
}

/** Creates a fake child process that can emit RPC output and close. */
function createSpawnFake(outputLines: readonly string[] = rpcOutputLines()): {
	readonly calls: SpawnCall[];
	readonly spawnPi: (
		command: string,
		args: string[],
		options: SpawnCall["options"],
	) => SpawnedProcessFake;
} {
	const calls: SpawnCall[] = [];

	return {
		calls,
		spawnPi(
			command: string,
			args: string[],
			options: SpawnCall["options"],
		): SpawnedProcessFake {
			const process = new SpawnedProcessFakeImpl();
			calls.push({ command, args, options, process });
			queueMicrotask(() => {
				for (const line of outputLines) {
					process.stdout.emit("data", `${line}\n`);
				}
				process.emit("close", 0);
			});
			return process;
		},
	};
}

/** Executes the registered run_subagent tool through the fake ExtensionAPI. */
async function executeRunSubagent(
	pi: ExtensionApiFake,
	ctx: CommandContextFake,
	params: { readonly agentId: string; readonly prompt: string },
): Promise<unknown> {
	return getRunSubagentTool(pi).execute(
		"tool-call-1",
		params,
		undefined,
		undefined,
		ctx as never,
	);
}

describe("run-subagent", () => {
	test("does not register run_subagent when explicitly disabled", async () => {
		// Purpose: disabled run-subagent config must remove the tool and prompt contribution from the runtime.
		// Input and expected output: enabled false registers no run_subagent tool.
		// Edge case: the extension is loaded normally with all fake API methods available.
		// Dependencies: this test uses only an isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({ enabled: false }),
			);
			const pi = createExtensionApiFake();

			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

			expect(pi.tools.map((tool) => tool.name)).not.toContain("run_subagent");
		});
	});

	test("registers the unchanged public run_subagent tool schema", async () => {
		// Purpose: the public tool contract must stay limited to agentId and prompt.
		// Input and expected output: extension load registers one run_subagent tool with agentId and prompt parameters.
		// Edge case: no agent files or session context are needed for registration.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake.
		const pi = createExtensionApiFake();

		await runSubagent(pi);

		expect(getRunSubagentTool(pi)).toMatchObject({
			name: "run_subagent",
			label: "Run subagent",
		});
		const parameters = getRunSubagentTool(pi).parameters as unknown as {
			readonly properties: Record<string, unknown>;
		};
		expect(Object.keys(parameters.properties)).toEqual(["agentId", "prompt"]);
	});

	test("starts child pi with explicit model, thinking, tools, and subagent environment", async () => {
		// Purpose: a valid callable agent must start an isolated child pi process with explicit runtime options.
		// Input and expected output: subagent helper resolves tools, model, thinking, depth, env, prompt, and parses final assistant text.
		// Edge case: wildcard tool pattern resolves narrowly and deduplicates with an exact tool.
		// Dependencies: this test uses temp agent files, fake tool registry, and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
				model: { id: "openai/child", thinking: "low" },
				tools: ["read", "grep*"],
			});
			const spawn = createSpawnFake(
				rpcOutputLines(
					{
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "wor" },
					},
					{
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "kin" },
					},
					{
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", delta: "g" },
					},
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
						},
					},
				),
			);
			const pi = createExtensionApiFake(["read", "grep", "write"]);
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(spawn.calls).toHaveLength(1);
			expect(spawn.calls[0]).toMatchObject({
				command: "pi",
				args: [
					"--mode",
					"rpc",
					"--no-session",
					"--model",
					"openai/child",
					"--thinking",
					"low",
					"--tools",
					"read,grep",
				],
				options: {
					cwd: "/tmp/project",
					env: {
						PI_SUBAGENT_AGENT_ID: "helper",
						PI_SUBAGENT_DEPTH: "1",
						PI_SUBAGENT_TOOLS: "read,grep",
					},
					signal: undefined,
				},
			});
			expect(spawn.calls[0]?.process.stdin.writes).toEqual([
				`${JSON.stringify({
					id: "run-subagent-prompt",
					type: "prompt",
					message: "Do work",
				})}\n`,
			]);
			expect(spawn.calls[0]?.process.stdin.ended).toBe(true);
			expect(result).toMatchObject({
				content: [{ type: "text", text: "done" }],
			});
			expect(
				(result.details as { readonly fullOutputPath?: string }).fullOutputPath,
			).toBeUndefined();
			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const widget = (
				widgetFactory as () => { render(width: number): string[] }
			)();
			const renderedWidget = widget.render(24);
			expect(renderedWidget).toContain("────────────────────────");
			expect(renderedWidget.join("\n")).toContain("Subagents:");
			expect(renderedWidget.join("\n")).toContain("helper");
			expect(renderedWidget.join("\n")).not.toContain("helper: wor");
			expect(renderedWidget.every((line) => visibleWidth(line) <= 24)).toBe(
				true,
			);
			const runSubagentTool = getRunSubagentTool(pi);
			expect(typeof runSubagentTool.renderResult).toBe("function");
			const renderedResult = runSubagentTool
				.renderResult?.(
					result,
					{ expanded: false } as never,
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as never,
					{ args: { prompt: "Do work" } } as never,
				)
				.render(24);
			expect(renderedResult?.every((line) => visibleWidth(line) <= 24)).toBe(
				true,
			);
		});
	});

	test("renders child projection savings before child context usage in widget rows", async () => {
		// Purpose: widget rows must show the projection state published by the same child process.
		// Input and expected output: child setStatus(context-projection, ~65k) plus usage renders ~65k/154.7k/272k.
		// Edge case: parent/global statuses and context-overflow status must not be copied into the child row.
		// Dependencies: this test uses temp agent files, fake context statuses, and fake child RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child", thinking: "low" },
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "projection-status-1",
					method: "setStatus",
					statusKey: "context-projection",
					statusText: "\u001b[33m~65k\u001b[39m",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "context-overflow-status-1",
					method: "setStatus",
					statusKey: "context-overflow",
					statusText: "262k",
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { totalTokens: 154700 },
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const childModel = {
				...createModel("openai", "child"),
				contextWindow: 272000,
			};
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[childModel],
			);
			ctx.ui.setStatus("context-projection", "~99k");
			ctx.ui.setStatus("context-overflow", "262k");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const widget = (
				widgetFactory as () => { render(width: number): string[] }
			)();
			const renderedWidget = widget.render(160).join("\n");
			expect(renderedWidget).toContain("~65k/154.7k/272k");
			expect(renderedWidget).not.toContain("~99k");
			expect(renderedWidget).not.toContain("262k");
			expect(renderedWidget).not.toContain("\u001b[33m");
			expect(renderedWidget).not.toContain("\u001b[39m");
			expect(
				spawn.calls[0]?.process.stdin.writes.some(
					(line) => JSON.parse(line).id === "projection-status-1",
				),
			).toBe(false);
		});
	});

	test("colors subagent widget projection and context usage like footer context", () => {
		// Purpose: widget rows must use the same context pressure colors as the footer and warning color for projection savings.
		// Input and expected output: low, warning, and error context rows render plain, warning, and error context values.
		// Edge case: projection savings use warning independently from the context pressure color.
		// Dependencies: this test uses the exported widget state updater and widget component factory.
		const state = createSubagentWidgetState();
		const contextWindow = 272000;
		const commonDetails = {
			depth: 1,
			runtime: {
				modelId: "openai/child",
				thinking: "low",
				contextWindow,
			},
			status: "running" as const,
			elapsedMs: 199000,
			exitCode: undefined,
			finalOutput: "",
			stderr: "",
			stopReason: undefined,
			errorMessage: undefined,
			events: [],
			omittedEventCount: 0,
			children: [],
		};
		recordSubagentWidgetRun(
			state,
			{
				...commonDetails,
				runId: "low",
				agentId: "LowAgent",
				contextUsage: {
					tokens: 100000,
					contextWindow,
					percent: 36.76,
				},
				contextProjectionStatus: undefined,
			},
			1,
		);
		recordSubagentWidgetRun(
			state,
			{
				...commonDetails,
				runId: "warning",
				agentId: "WarningAgent",
				contextUsage: {
					tokens: 187300,
					contextWindow,
					percent: 68.86,
				},
				contextProjectionStatus: "~51k",
			},
			2,
		);
		recordSubagentWidgetRun(
			state,
			{
				...commonDetails,
				runId: "error",
				agentId: "ErrorAgent",
				contextUsage: {
					tokens: 220000,
					contextWindow,
					percent: 80.88,
				},
				contextProjectionStatus: undefined,
			},
			3,
		);
		const theme: { fg(color: string, text: string): string } = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const widgetFactory = createSubagentWidgetFactory(state, 4) as (
			tui: unknown,
			theme: { fg(color: string, text: string): string },
		) => { render(width: number): string[] };
		const renderedWidget = widgetFactory(undefined, theme)
			.render(240)
			.join("\n");

		expect(renderedWidget).toContain("LowAgent 199s · 100k/272k");
		expect(renderedWidget).toContain(
			"WarningAgent 199s · <warning>~51k</warning>/<warning>187.3k/272k</warning>",
		);
		expect(renderedWidget).toContain(
			"ErrorAgent 199s · <error>220k/272k</error>",
		);
		expect(renderedWidget).not.toContain("<warning>100k/272k</warning>");
	});

	test("colors subagent widget status icons by run status", () => {
		// Purpose: widget status icons must use the requested theme color for each run status.
		// Input and expected output: running, succeeded, failed, and aborted rows render accent, success, error, and error icons.
		// Edge case: aborted and failed both use error color while keeping different glyphs.
		// Dependencies: this test uses the exported widget state updater and widget component factory.
		const state = createSubagentWidgetState();
		const statuses = [
			{ runId: "running", agentId: "RunningAgent", status: "running" },
			{ runId: "succeeded", agentId: "SucceededAgent", status: "succeeded" },
			{ runId: "failed", agentId: "FailedAgent", status: "failed" },
			{ runId: "aborted", agentId: "AbortedAgent", status: "aborted" },
		] as const;
		for (const [index, status] of statuses.entries()) {
			recordSubagentWidgetRun(
				state,
				{
					runId: status.runId,
					agentId: status.agentId,
					depth: 1,
					runtime: undefined,
					contextUsage: undefined,
					contextProjectionStatus: undefined,
					status: status.status,
					elapsedMs: 1000,
					exitCode: undefined,
					finalOutput: "",
					stderr: "",
					stopReason: undefined,
					errorMessage: undefined,
					events: [],
					omittedEventCount: 0,
					children: [],
				},
				index,
			);
		}
		const theme: { fg(color: string, text: string): string } = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const widgetFactory = createSubagentWidgetFactory(state, 5) as (
			tui: unknown,
			theme: { fg(color: string, text: string): string },
		) => { render(width: number): string[] };
		const renderedWidget = widgetFactory(undefined, theme)
			.render(240)
			.join("\n");

		expect(renderedWidget).toContain("<accent>⏳</accent> RunningAgent");
		expect(renderedWidget).toContain("<success>✓</success> SucceededAgent");
		expect(renderedWidget).toContain("<error>✗</error> FailedAgent");
		expect(renderedWidget).toContain("<error>■</error> AbortedAgent");
		expect(renderedWidget).not.toContain("<warning>■</warning>");
	});

	test("colors only positive subagent summary counts", () => {
		// Purpose: the widget summary must highlight only active non-zero counts.
		// Input and expected output: zero running stays plain, while one failed and one done color only the numbers.
		// Edge case: labels stay uncolored even when their count is positive.
		// Dependencies: this test uses the exported widget state updater and widget component factory.
		const state = createSubagentWidgetState();
		const statuses = [
			{ runId: "failed", agentId: "FailedAgent", status: "failed" },
			{ runId: "succeeded", agentId: "SucceededAgent", status: "succeeded" },
		] as const;
		for (const [index, status] of statuses.entries()) {
			recordSubagentWidgetRun(
				state,
				{
					runId: status.runId,
					agentId: status.agentId,
					depth: 1,
					runtime: undefined,
					contextUsage: undefined,
					contextProjectionStatus: undefined,
					status: status.status,
					elapsedMs: 1000,
					exitCode: undefined,
					finalOutput: "",
					stderr: "",
					stopReason: undefined,
					errorMessage: undefined,
					events: [],
					omittedEventCount: 0,
					children: [],
				},
				index,
			);
		}
		const theme: { fg(color: string, text: string): string } = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const widgetFactory = createSubagentWidgetFactory(state, 1) as (
			tui: unknown,
			theme: { fg(color: string, text: string): string },
		) => { render(width: number): string[] };
		const renderedWidget = widgetFactory(undefined, theme)
			.render(240)
			.join("\n");

		expect(renderedWidget).toContain(
			"Subagents: 0 running · <error>1</error> failed · <success>1</success> done",
		);
		expect(renderedWidget).not.toContain("<accent>0</accent>");
		expect(renderedWidget).not.toContain("<error>failed</error>");
		expect(renderedWidget).not.toContain("<success>done</success>");
	});

	test("clears and ignores non-positive child projection statuses in widget rows", async () => {
		// Purpose: widget rows must not show child projection states that do not represent positive savings.
		// Input and expected output: positive, error, ready, and clear statuses result in plain context usage after the clear.
		// Edge case: a later non-positive status must clear a stale positive projection value.
		// Dependencies: this test uses temp agent files and fake child RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child", thinking: "low" },
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "projection-status-positive",
					method: "setStatus",
					statusKey: "context-projection",
					statusText: "~65k",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "projection-status-error",
					method: "setStatus",
					statusKey: "context-projection",
					statusText: "CP!",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "projection-status-ready",
					method: "setStatus",
					statusKey: "context-projection",
					statusText: "~0",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "projection-status-clear",
					method: "setStatus",
					statusKey: "context-projection",
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { totalTokens: 154700 },
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const childModel = {
				...createModel("openai", "child"),
				contextWindow: 272000,
			};
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[childModel],
			);
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const widget = (
				widgetFactory as () => { render(width: number): string[] }
			)();
			const renderedWidget = widget.render(160).join("\n");
			expect(renderedWidget).toContain("154.7k/272k");
			expect(renderedWidget).not.toContain("~65k");
			expect(renderedWidget).not.toContain("~0");
			expect(renderedWidget).not.toContain("CP!");
		});
	});

	test("keeps widget state current when first activity arrives inside throttle window", async () => {
		// Purpose: widget state must not stay at starting when real child activity arrives before the next repaint is allowed.
		// Input and expected output: initial running update is followed by an assistant message in the same throttle window, and the existing widget factory renders that activity.
		// Edge case: no second setWidget call happens before the render inspection.
		// Dependencies: this test uses temp agent files, a fake child process, and a fixed Date.now value.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const originalDateNow = Date.now;
			Date.now = () => 1_000;
			try {
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									id: "run-subagent-prompt",
									type: "response",
									command: "prompt",
									success: true,
								})}\n`,
							);
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									type: "message_end",
									message: {
										role: "assistant",
										content: [{ type: "text", text: "first activity" }],
									},
								})}\n`,
							);
						});
						return process;
					},
				});

				const resultPromise = executeRunSubagent(pi, ctx, {
					agentId: "helper",
					prompt: "Do work",
				}) as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));

				expect(ctx.widgets).toHaveLength(1);
				const widgetFactory = ctx.widgets.at(-1)?.content;
				expect(typeof widgetFactory).toBe("function");
				const widget = (
					widgetFactory as () => { render(width: number): string[] }
				)();
				const renderedWidget = widget.render(120).join("\n");
				expect(renderedWidget).toContain("assistant first activity");
				expect(renderedWidget).not.toContain("starting");

				process.stdout.emit(
					"data",
					`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
				);
				process.emit("close", 0);
				await resultPromise;
			} finally {
				Date.now = originalDateNow;
			}
		});
	});

	test("returns prompt response failures without treating them as completed work", async () => {
		// Purpose: a failed RPC prompt response is a preflight failure, not a successful empty subagent run.
		// Input and expected output: child returns success false for prompt and the tool returns the response error.
		// Edge case: child process exits with code 0 after reporting prompt rejection.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: false,
					error: "prompt rejected",
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("prompt rejected");
			expect(spawn.calls[0]?.process.stdin.ended).toBe(true);
		});
	});

	test("keeps prompt failure status when parent abort fires before child close", async () => {
		// Purpose: parent abort must not replace an already-known prompt failure with aborted status.
		// Input and expected output: prompt failure closes stdin, parent abort fires before close, and result remains failed.
		// Edge case: abort happens after the failure is known but before child process close.
		// Dependencies: this test uses temp agent files, AbortController, and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const controller = new AbortController();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: false,
								error: "prompt rejected",
							})}\n`,
						);
					});
					return process;
				},
			});

			const resultPromise = getRunSubagentTool(pi).execute(
				"tool-call-1",
				{ agentId: "helper", prompt: "Do work" },
				controller.signal,
				undefined,
				ctx as never,
			) as unknown as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			await new Promise((resolve) => queueMicrotask(resolve));
			controller.abort();
			process.emit("close", 0);

			const result = await resultPromise;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			const writes = process.stdin.writes.map((line) => JSON.parse(line));

			expect(content).toBe("prompt rejected");
			expect((result.details as { readonly status?: string }).status).toBe(
				"failed",
			);
			expect(writes).not.toContainEqual({
				id: "run-subagent-abort",
				type: "abort",
			});
		});
	});

	test("terminates the child after prompt failure when parent abort fires before close", async () => {
		// Purpose: parent abort after a known prompt failure must clean up the child process without changing the failure result.
		// Input and expected output: prompt failure, parent abort, SIGTERM, SIGKILL, then close returns the original failed result.
		// Edge case: the child reports prompt failure but ignores stdin close and keeps running.
		// Dependencies: this test patches global timers only for the duration of the scenario.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const timers: Array<{
				readonly timeout: number | undefined;
				readonly run: () => void;
			}> = [];
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = ((
				handler: Parameters<typeof globalThis.setTimeout>[0],
				timeout?: number,
			) => {
				const run = () => {
					if (typeof handler === "function") {
						handler();
					}
				};
				timers.push({ timeout, run });
				return {} as ReturnType<typeof globalThis.setTimeout>;
			}) as typeof globalThis.setTimeout;
			globalThis.clearTimeout = (() =>
				undefined) as typeof globalThis.clearTimeout;
			try {
				const controller = new AbortController();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									id: "run-subagent-prompt",
									type: "response",
									command: "prompt",
									success: false,
									error: "prompt rejected",
								})}\n`,
							);
						});
						return process;
					},
				});

				const resultPromise = getRunSubagentTool(pi).execute(
					"tool-call-1",
					{ agentId: "helper", prompt: "Do work" },
					controller.signal,
					undefined,
					ctx as never,
				) as unknown as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));
				controller.abort();

				expect(timers.map((timer) => timer.timeout)).toEqual([10_000]);
				timers[0]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
				expect(timers.map((timer) => timer.timeout)).toEqual([10_000, 5_000]);
				timers[1]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
				process.emit("close", 0);

				const result = await resultPromise;
				const content =
					result.content[0]?.type === "text" ? result.content[0].text : "";
				const writes = process.stdin.writes.map((line) => JSON.parse(line));

				expect(content).toBe("prompt rejected");
				expect((result.details as { readonly status?: string }).status).toBe(
					"failed",
				);
				expect(writes).not.toContainEqual({
					id: "run-subagent-abort",
					type: "abort",
				});
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			}
		});
	});

	test("fails when child RPC stdout is malformed", async () => {
		// Purpose: malformed RPC stdout must be reported as a transport failure instead of being ignored.
		// Input and expected output: invalid JSONL returns a bounded malformed-output error.
		// Edge case: the child exits with code 0 after malformed output.
		// Dependencies: this test uses temp agent files and a fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake(["{not-json}"]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toContain("child pi emitted malformed RPC output");
		});
	});

	test("keeps malformed output status when parent abort fires before child close", async () => {
		// Purpose: parent abort must not replace an already-known transport failure with aborted status.
		// Input and expected output: malformed output closes stdin, parent abort fires before close, and result remains failed.
		// Edge case: abort happens after malformed RPC output but before child process close.
		// Dependencies: this test uses temp agent files, AbortController, and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const controller = new AbortController();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						process.stdout.emit("data", "{not-json}\n");
					});
					return process;
				},
			});

			const resultPromise = getRunSubagentTool(pi).execute(
				"tool-call-1",
				{ agentId: "helper", prompt: "Do work" },
				controller.signal,
				undefined,
				ctx as never,
			) as unknown as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			await new Promise((resolve) => queueMicrotask(resolve));
			controller.abort();
			process.emit("close", 0);

			const result = await resultPromise;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			const writes = process.stdin.writes.map((line) => JSON.parse(line));

			expect(content).toContain("child pi emitted malformed RPC output");
			expect((result.details as { readonly status?: string }).status).toBe(
				"failed",
			);
			expect(writes).not.toContainEqual({
				id: "run-subagent-abort",
				type: "abort",
			});
		});
	});

	test("terminates the child after malformed output when parent abort fires before close", async () => {
		// Purpose: parent abort after a known malformed-output failure must clean up the child process without changing the failure result.
		// Input and expected output: malformed stdout, parent abort, SIGTERM, SIGKILL, then close returns the original failed result.
		// Edge case: the child emits invalid RPC output and then keeps running.
		// Dependencies: this test patches global timers only for the duration of the scenario.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const timers: Array<{
				readonly timeout: number | undefined;
				readonly run: () => void;
			}> = [];
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = ((
				handler: Parameters<typeof globalThis.setTimeout>[0],
				timeout?: number,
			) => {
				const run = () => {
					if (typeof handler === "function") {
						handler();
					}
				};
				timers.push({ timeout, run });
				return {} as ReturnType<typeof globalThis.setTimeout>;
			}) as typeof globalThis.setTimeout;
			globalThis.clearTimeout = (() =>
				undefined) as typeof globalThis.clearTimeout;
			try {
				const controller = new AbortController();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit("data", "{not-json}\n");
						});
						return process;
					},
				});

				const resultPromise = getRunSubagentTool(pi).execute(
					"tool-call-1",
					{ agentId: "helper", prompt: "Do work" },
					controller.signal,
					undefined,
					ctx as never,
				) as unknown as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));
				controller.abort();

				expect(timers.map((timer) => timer.timeout)).toEqual([10_000]);
				timers[0]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
				expect(timers.map((timer) => timer.timeout)).toEqual([10_000, 5_000]);
				timers[1]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
				process.emit("close", 0);

				const result = await resultPromise;
				const content =
					result.content[0]?.type === "text" ? result.content[0].text : "";
				const writes = process.stdin.writes.map((line) => JSON.parse(line));

				expect(content).toContain("child pi emitted malformed RPC output");
				expect((result.details as { readonly status?: string }).status).toBe(
					"failed",
				);
				expect(writes).not.toContainEqual({
					id: "run-subagent-abort",
					type: "abort",
				});
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			}
		});
	});

	test("fails when the subagent exits before completing the task", async () => {
		// Purpose: a zero-exit child process is not successful unless RPC completion was observed.
		// Input and expected output: child exits after prompt acceptance but before completion and returns a clear user-facing failure.
		// Edge case: exit code is 0, so process status alone would look successful.
		// Dependencies: this test uses temp agent files and a fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent exited before completing the task");
		});
	});

	test("does not use streamed deltas as final output without a completed assistant message", async () => {
		// Purpose: successful final output must come from assistant message_end, not from partial streaming deltas.
		// Input and expected output: text_delta events followed by agent_end return the no-final-answer diagnostic.
		// Edge case: the child completed normally but never emitted a completed assistant text message.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				...rpcOutputLines({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "partial answer",
					},
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent completed without a final answer");
		});
	});

	test("uses the latest assistant message before RPC completion", async () => {
		// Purpose: final output must be the latest completed assistant message before agent_end.
		// Input and expected output: two assistant message_end events before completion return the second answer.
		// Edge case: earlier completed text must be replaced only by another completed assistant text.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake(
				rpcOutputLines(
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "first answer" }],
						},
					},
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "second answer" }],
						},
					},
				),
			);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "second answer" }],
			});
		});
	});

	test("handles async child stdin errors as bounded diagnostics", async () => {
		// Purpose: child stdin stream errors must not crash the parent process.
		// Input and expected output: stdin emits an error and the tool returns a bounded error message.
		// Edge case: the stream error happens after prompt acceptance but before completion.
		// Dependencies: this test uses temp agent files and the fake stdin EventEmitter.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
					});
					return process;
				},
			});

			const resultPromise = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			}) as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			await new Promise((resolve) => queueMicrotask(resolve));
			expect(() => {
				process.stdin.emit("error", new Error("EPIPE"));
			}).not.toThrow();
			process.emit("close", 1);

			const result = await resultPromise;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toContain("child stdin error: EPIPE");
		});
	});

	test("does not write UI cancellation responses after stdin is closed", async () => {
		// Purpose: RPC UI cancellation must respect stdin shutdown state.
		// Input and expected output: prompt failure closes stdin and a later UI request does not write a response.
		// Edge case: the child emits a blocking UI request after prompt rejection.
		// Dependencies: this test uses temp agent files and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: false,
					error: "prompt rejected",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "select-after-close",
					method: "select",
					title: "Select",
					options: ["A"],
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			const writes = spawn.calls[0]?.process.stdin.writes.map((line) =>
				JSON.parse(line),
			);
			expect(writes).toEqual([
				{ id: "run-subagent-prompt", type: "prompt", message: "Do work" },
			]);
		});
	});

	test("processes child output only after the RPC prompt write", async () => {
		// Purpose: tests must prove the child prompt is sent through stdin before output is consumed.
		// Input and expected output: fake child emits its RPC output from the prompt write handler.
		// Edge case: no queued stdout exists before the prompt command.
		// Dependencies: this test uses temp agent files and fake stdin write events.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					process.stdin.on("write", (data) => {
						const command = JSON.parse(data) as { readonly type?: string };
						if (command.type !== "prompt") {
							return;
						}
						for (const line of rpcOutputLines({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "done after prompt" }],
							},
						})) {
							process.stdout.emit("data", `${line}\n`);
						}
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "done after prompt" }],
			});
		});
	});

	test("cancels blocking RPC UI requests and ignores fire-and-forget requests", async () => {
		// Purpose: child extension UI requests must not hang headless subagent execution.
		// Input and expected output: dialog requests get deterministic cancellation responses, while notify gets no response.
		// Edge case: all supported blocking request methods appear before completion.
		// Dependencies: this test uses temp agent files and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "select-1",
					method: "select",
					title: "Select",
					options: ["A"],
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "confirm-1",
					method: "confirm",
					title: "Confirm",
					message: "Continue?",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "input-1",
					method: "input",
					title: "Input",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "editor-1",
					method: "editor",
					title: "Editor",
				}),
				JSON.stringify({
					type: "extension_ui_request",
					id: "notify-1",
					method: "notify",
					message: "info",
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			const writes = spawn.calls[0]?.process.stdin.writes.map((line) =>
				JSON.parse(line),
			);
			expect(writes).toContainEqual({
				type: "extension_ui_response",
				id: "select-1",
				cancelled: true,
			});
			expect(writes).toContainEqual({
				type: "extension_ui_response",
				id: "confirm-1",
				confirmed: false,
			});
			expect(writes).toContainEqual({
				type: "extension_ui_response",
				id: "input-1",
				cancelled: true,
			});
			expect(writes).toContainEqual({
				type: "extension_ui_response",
				id: "editor-1",
				cancelled: true,
			});
			expect(
				writes?.some(
					(write) => (write as { readonly id?: string }).id === "notify-1",
				),
			).toBe(false);
		});
	});

	test("ignores assistant messages emitted after RPC completion", async () => {
		// Purpose: final output must come from the latest completed assistant message before agent completion.
		// Input and expected output: a late assistant message after completion does not replace the completed answer.
		// Edge case: late output arrives before the child close event.
		// Dependencies: this test uses temp agent files and a fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "completed answer" }],
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "late answer" }],
					},
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "completed answer" }],
			});
		});
	});

	test("keeps a completed run successful when parent abort fires before child close", async () => {
		// Purpose: parent abort after RPC completion must not change an already completed child run into aborted.
		// Input and expected output: message_end and agent_end arrive, parent aborts before close, and the final answer remains successful.
		// Edge case: abort signal fires in the narrow window between agent_end and child process close.
		// Dependencies: this test uses temp agent files, AbortController, and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const controller = new AbortController();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						for (const line of rpcOutputLines({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "completed answer" }],
							},
						})) {
							process.stdout.emit("data", `${line}\n`);
						}
					});
					return process;
				},
			});

			const resultPromise = getRunSubagentTool(pi).execute(
				"tool-call-1",
				{ agentId: "helper", prompt: "Do work" },
				controller.signal,
				undefined,
				ctx as never,
			) as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			await new Promise((resolve) => queueMicrotask(resolve));
			controller.abort();
			process.emit("close", 0);

			const result = await resultPromise;
			const writes = process.stdin.writes.map((line) => JSON.parse(line));

			expect(result).toMatchObject({
				content: [{ type: "text", text: "completed answer" }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
			expect(writes).not.toContainEqual({
				id: "run-subagent-abort",
				type: "abort",
			});
			expect(process.killedSignals).toEqual([]);
		});
	});

	test("keeps completion when agent_end messages exceed the stdout line buffer", async () => {
		// Purpose: completion must not depend on materializing the unbounded agent_end messages array.
		// Input and expected output: a small final assistant message plus oversized agent_end messages succeeds with the final answer.
		// Edge case: agent_end is a valid RPC control event whose data payload exceeds the raw JSONL line buffer.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "completed answer" }],
						stopReason: "stop",
					},
				}),
				JSON.stringify({
					type: "agent_end",
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "text", text: `large-history-${"x".repeat(300_000)}` },
							],
							stopReason: "stop",
						},
					],
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "completed answer" }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
			expect(spawn.calls[0]?.process.stdin.ended).toBe(true);
		});
	});

	test("keeps completion when image tool result exceeds the stdout line buffer", async () => {
		// Purpose: valid oversized tool result events must not make child RPC output look malformed.
		// Input and expected output: an oversized read image result followed by a final assistant answer succeeds with that answer.
		// Edge case: image data exceeds the raw JSONL line buffer and must not be surfaced as final output.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const finalAnswer = "image inspected";
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "tool_execution_end",
					toolCallId: "call-read-image",
					toolName: "read",
					result: {
						content: [
							{ type: "text", text: "Read image file [image/jpeg]" },
							{
								type: "image",
								data: "a".repeat(300_000),
								mimeType: "image/jpeg",
							},
						],
					},
					isError: false,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalAnswer }],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: finalAnswer }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
			expect(
				(result.details as { readonly finalOutput?: string }).finalOutput,
			).toBe(finalAnswer);
		});
	});

	test("keeps completion when turn_end tool results exceed the stdout line buffer", async () => {
		// Purpose: valid oversized turn_end events must not make child RPC output look malformed.
		// Input and expected output: a final assistant answer plus oversized turn_end tool results succeeds with that answer.
		// Edge case: turn_end repeats image tool results after the separate tool_execution_end event.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const finalAnswer = "continued after image read";
			const imageResult = {
				content: [
					{ type: "text", text: "Read image file [image/jpeg]" },
					{
						type: "image",
						data: "a".repeat(300_000),
						mimeType: "image/jpeg",
					},
				],
			};
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalAnswer }],
						stopReason: "stop",
					},
				}),
				JSON.stringify({
					type: "turn_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalAnswer }],
						stopReason: "stop",
					},
					toolResults: [
						{
							toolCallId: "call-read-image",
							toolName: "read",
							result: imageResult,
							isError: false,
						},
					],
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: finalAnswer }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
			expect(
				(result.details as { readonly finalOutput?: string }).finalOutput,
			).toBe(finalAnswer);
		});
	});

	test("uses streamed final text only when message_end text was skipped by the adapter limit", async () => {
		// Purpose: oversized final message content may use matching streamed text as a bounded fallback.
		// Input and expected output: text_delta rebuilds the answer when message_end metadata is present but text content is oversized.
		// Edge case: message_end contains a huge text value that must not be materialized by the RPC adapter.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const streamedAnswer = "streamed fallback answer";
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: streamedAnswer,
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `${streamedAnswer}${"x".repeat(300_000)}` },
						],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: streamedAnswer }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
		});
	});

	test("uses text delta from oversized message_update with large partial message", async () => {
		// Purpose: oversized message_update must still contribute text_delta while ignoring large partial message snapshots.
		// Input and expected output: a real-shaped message_update with large message plus text_delta feeds the skipped message_end fallback.
		// Edge case: assistantMessageEvent appears after the large partial message and outside the raw stdout line buffer prefix.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const streamedAnswer = "oversized update answer";
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_update",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `large-partial-${"x".repeat(300_000)}` },
						],
					},
					assistantMessageEvent: {
						type: "text_delta",
						delta: streamedAnswer,
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `${streamedAnswer}${"x".repeat(300_000)}` },
						],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: streamedAnswer }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
		});
	});

	test("keeps a large text delta from oversized message_update", async () => {
		// Purpose: oversized message_update projection must preserve text_delta values beyond small control-field limits.
		// Input and expected output: one text_delta larger than 4096 characters feeds the skipped message_end fallback.
		// Edge case: the large delta is valid streamed answer data, not small RPC control metadata.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const streamedAnswer = `large-delta-${"d".repeat(10_000)}-end`;
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_update",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `large-partial-${"x".repeat(300_000)}` },
						],
					},
					assistantMessageEvent: {
						type: "text_delta",
						delta: streamedAnswer,
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `${streamedAnswer}${"x".repeat(300_000)}` },
						],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: streamedAnswer }],
			});
			expect(
				(result.details as { readonly finalOutput?: string }).finalOutput,
			).toBe(streamedAnswer);
		});
	});

	test("uses oversized assistant message_start to reset streamed text", async () => {
		// Purpose: oversized message_start is a lifecycle event and must not fail the child run.
		// Input and expected output: an oversized assistant message_start resets stale streamed text before the final answer.
		// Edge case: role preservation is required so reset logic recognizes the assistant turn.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_start",
					message: { role: "assistant" },
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "stale ",
					},
				}),
				JSON.stringify({
					type: "message_start",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `large-start-${"x".repeat(300_000)}` },
						],
					},
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "fresh answer",
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `fresh answer${"x".repeat(300_000)}` },
						],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "fresh answer" }],
			});
		});
	});

	test("ignores oversized message_update without usable text delta", async () => {
		// Purpose: oversized non-text-delta message_update is progress only and must not fail the child run.
		// Input and expected output: a large message_update without text_delta is ignored and the later final answer succeeds.
		// Edge case: message_update has a valid event type but no usable assistant text delta.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_update",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: `large-partial-${"x".repeat(300_000)}` },
						],
					},
					assistantMessageEvent: {
						type: "metadata_update",
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "completed answer" }],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "completed answer" }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
		});
	});

	test("does not use streamed text when message_end confirms text is absent", async () => {
		// Purpose: streamed text is only a fallback for skipped text, not a replacement for an intentionally textless final message.
		// Input and expected output: text_delta plus a textless assistant message_end returns the missing-final-answer diagnostic.
		// Edge case: provider streaming emitted text that is absent from the completed message.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "streamed but absent",
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						stopReason: "stop",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent completed without a final answer");
		});
	});

	test("does not treat tool-use assistant text as the final subagent answer", async () => {
		// Purpose: assistant messages that call tools are intermediate turns and must not become final output.
		// Input and expected output: toolUse assistant message with text and toolCall plus agent_end returns the missing-final-answer diagnostic.
		// Edge case: providers may emit explanatory text before a tool call.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "intermediate tool preface" },
							{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
						],
						stopReason: "toolUse",
					},
				}),
				JSON.stringify({ type: "agent_end", messages: [] }),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent completed without a final answer");
		});
	});

	test("fails as incomplete when assistant message_end arrives without agent_end", async () => {
		// Purpose: a completed assistant message is not enough without the RPC completion event.
		// Input and expected output: message_end without agent_end returns the incomplete-run diagnostic.
		// Edge case: the child exits with code 0 after a final-looking assistant message.
		// Dependencies: this test uses temp agent files and a fake child RPC process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake([
				JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: true,
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final-looking answer" }],
					},
				}),
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent exited before completing the task");
		});
	});

	test("kills the child after abort timeout when the child ignores RPC abort", async () => {
		// Purpose: ignored child aborts must first request graceful process termination.
		// Input and expected output: parent abort schedules a 10 second fallback and sends SIGTERM only when that timer fires.
		// Edge case: the child accepts the prompt but never emits agent_end or close.
		// Dependencies: this test patches global timers only for the duration of the scenario.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			let fallback: (() => void) | undefined;
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			const fakeTimer = originalSetTimeout(() => undefined, 0);
			originalClearTimeout(fakeTimer);
			globalThis.setTimeout = ((
				handler: Parameters<typeof globalThis.setTimeout>[0],
				timeout?: number,
			) => {
				if (timeout === 10_000) {
					fallback = () => {
						if (typeof handler === "function") {
							handler();
						}
					};
				}
				return fakeTimer;
			}) as typeof globalThis.setTimeout;
			globalThis.clearTimeout = ((
				timer?: Parameters<typeof clearTimeout>[0],
			) => {
				expect(timer).toBe(fakeTimer);
			}) as typeof globalThis.clearTimeout;
			try {
				const controller = new AbortController();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									id: "run-subagent-prompt",
									type: "response",
									command: "prompt",
									success: true,
								})}\n`,
							);
						});
						return process;
					},
				});

				const resultPromise = getRunSubagentTool(pi).execute(
					"tool-call-1",
					{ agentId: "helper", prompt: "Do work" },
					controller.signal,
					undefined,
					ctx as never,
				) as unknown as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));
				controller.abort();

				expect(process.killedSignals).toEqual([]);
				fallback?.();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
				process.emit("close", 1);
				await resultPromise;
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			}
		});
	});

	test("escalates abort from SIGTERM to SIGKILL when the child ignores termination", async () => {
		// Purpose: a child that ignores graceful termination must receive a stronger termination signal.
		// Input and expected output: parent abort sends SIGTERM after 10 seconds and SIGKILL 5 seconds later.
		// Edge case: the child never emits close after SIGTERM.
		// Dependencies: this test patches global timers only for the duration of the scenario.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const timers: Array<{
				readonly timeout: number | undefined;
				readonly run: () => void;
			}> = [];
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			const fakeTimer = originalSetTimeout(() => undefined, 0);
			originalClearTimeout(fakeTimer);
			globalThis.setTimeout = ((
				handler: Parameters<typeof globalThis.setTimeout>[0],
				timeout?: number,
			) => {
				const run = () => {
					if (typeof handler === "function") {
						handler();
					}
				};
				timers.push({ timeout, run });
				return fakeTimer;
			}) as typeof globalThis.setTimeout;
			globalThis.clearTimeout = (() =>
				undefined) as typeof globalThis.clearTimeout;
			try {
				const controller = new AbortController();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									id: "run-subagent-prompt",
									type: "response",
									command: "prompt",
									success: true,
								})}\n`,
							);
						});
						return process;
					},
				});

				const resultPromise = getRunSubagentTool(pi).execute(
					"tool-call-1",
					{ agentId: "helper", prompt: "Do work" },
					controller.signal,
					undefined,
					ctx as never,
				) as unknown as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));
				controller.abort();

				expect(timers.map((timer) => timer.timeout)).toEqual([10_000]);
				expect(process.killedSignals).toEqual([]);
				timers[0]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
				expect(timers.map((timer) => timer.timeout)).toEqual([10_000, 5_000]);
				timers[1]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
				process.emit("close", 1);
				await resultPromise;
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			}
		});
	});

	test("does not escalate to SIGKILL when the child exits after SIGTERM", async () => {
		// Purpose: SIGKILL must not run after the child closes from graceful termination.
		// Input and expected output: parent abort sends SIGTERM, child closes, and the SIGKILL timer is cleared.
		// Edge case: close happens after SIGTERM timer fires but before SIGKILL timer fires.
		// Dependencies: this test patches global timers only for the duration of the scenario.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const timers: Array<{
				cleared: boolean;
				readonly timeout: number | undefined;
				readonly run: () => void;
			}> = [];
			const clearedTimers: unknown[] = [];
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			globalThis.setTimeout = ((
				handler: Parameters<typeof globalThis.setTimeout>[0],
				timeout?: number,
			) => {
				const timer = {
					cleared: false,
					timeout,
					run: () => {
						if (!timer.cleared && typeof handler === "function") {
							handler();
						}
					},
				};
				timers.push(timer);
				return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
			}) as typeof globalThis.setTimeout;
			globalThis.clearTimeout = ((
				timer?: Parameters<typeof clearTimeout>[0],
			) => {
				clearedTimers.push(timer);
				if (typeof timer === "object" && timer !== null && "cleared" in timer) {
					(timer as { cleared: boolean }).cleared = true;
				}
			}) as typeof globalThis.clearTimeout;
			try {
				const controller = new AbortController();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, {
					spawnPi() {
						const process = new SpawnedProcessFakeImpl();
						resolveProcess(process);
						queueMicrotask(() => {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									id: "run-subagent-prompt",
									type: "response",
									command: "prompt",
									success: true,
								})}\n`,
							);
						});
						return process;
					},
				});

				const resultPromise = getRunSubagentTool(pi).execute(
					"tool-call-1",
					{ agentId: "helper", prompt: "Do work" },
					controller.signal,
					undefined,
					ctx as never,
				) as unknown as Promise<AgentToolResult<unknown>>;
				const process = await processReady;
				await new Promise((resolve) => queueMicrotask(resolve));
				controller.abort();
				timers[0]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
				process.emit("close", 1);
				await resultPromise;

				expect(clearedTimers).toEqual([timers[0], timers[1]]);
				timers[1]?.run();
				expect(process.killedSignals).toEqual(["SIGTERM"]);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			}
		});
	});

	test("sends an RPC abort command when the parent abort signal fires", async () => {
		// Purpose: parent cancellation must ask the child RPC session to abort before cleanup.
		// Input and expected output: abort signal writes one abort command and returns aborted status details.
		// Edge case: the child emits agent_end after abort handling.
		// Dependencies: this test uses temp agent files, AbortController, and captured fake stdin writes.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const controller = new AbortController();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
					});
					return process;
				},
			});

			const resultPromise = getRunSubagentTool(pi).execute(
				"tool-call-1",
				{ agentId: "helper", prompt: "Do work" },
				controller.signal,
				undefined,
				ctx as never,
			) as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			await new Promise((resolve) => queueMicrotask(resolve));
			controller.abort();
			process.stdout.emit(
				"data",
				`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
			);
			process.emit("close", 0);

			const result = await resultPromise;
			const writes = process.stdin.writes.map((line) => JSON.parse(line));

			expect(writes).toContainEqual({
				id: "run-subagent-abort",
				type: "abort",
			});
			expect(process.stdin.ended).toBe(true);
			expect(process.killedSignals).toEqual([]);
			expect((result.details as { readonly status?: string }).status).toBe(
				"aborted",
			);
		});
	});

	test("decodes split UTF-8 stdout chunks before JSON parsing", async () => {
		// Purpose: child stdout decoding must preserve multibyte UTF-8 characters split across process chunks.
		// Input and expected output: a JSON message_end line containing an emoji split between Buffer chunks still parses and returns the emoji.
		// Edge case: the split happens inside the UTF-8 byte sequence, not at a JavaScript string boundary.
		// Dependencies: this test uses temp agent files and a fake child process with Buffer stdout chunks.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const line = `${rpcOutputLines({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done 🙂" }],
				},
			}).join("\n")}\n`;
			const bytes = Buffer.from(line, "utf8");
			const splitIndex = bytes.indexOf(Buffer.from("🙂", "utf8")) + 2;
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit("data", bytes.subarray(0, splitIndex));
						process.stdout.emit("data", bytes.subarray(splitIndex));
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: "done 🙂" }],
			});
		});
	});

	test("decodes split UTF-8 stderr chunks before returning diagnostics", async () => {
		// Purpose: child stderr diagnostics must preserve multibyte UTF-8 characters split across process chunks.
		// Input and expected output: a failed child emits an emoji split between Buffer chunks and the returned error keeps the emoji intact.
		// Edge case: the split happens inside the UTF-8 byte sequence, not at a JavaScript string boundary.
		// Dependencies: this test uses temp agent files and a fake child process with Buffer stderr chunks.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const stderrText = "failed 🙂";
			const bytes = Buffer.from(stderrText, "utf8");
			const splitIndex = bytes.indexOf(Buffer.from("🙂", "utf8")) + 2;
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stderr.emit("data", bytes.subarray(0, splitIndex));
						process.stderr.emit("data", bytes.subarray(splitIndex));
						process.emit("close", 1);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(stderrText);
		});
	});

	test("keeps large child stderr bounded during failed execution", async () => {
		// Purpose: child stderr diagnostics must not be accumulated without a runtime limit.
		// Input and expected output: a failed child emits a very large stderr payload, but the tool returns bounded diagnostics.
		// Edge case: the child exits with a non-zero code before producing a final assistant answer.
		// Dependencies: this test uses temp agent files and a fake child process with controlled stderr output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const stderrText = `first-line\n${"x".repeat(200_000)}\nlast-line`;
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stderr.emit("data", stderrText);
						process.emit("close", 1);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content.length).toBeLessThan(100_000);
			expect(content).toContain("child stderr truncated");
			expect(content).not.toContain("first-line");
			expect(content).toContain("last-line");
		});
	});

	test("fails on a long malformed stdout line before later RPC events", async () => {
		// Purpose: malformed RPC stdout must fail deterministically without keeping an unbounded line buffer.
		// Input and expected output: a huge non-JSON partial line returns a bounded malformed-output error.
		// Edge case: a valid RPC event arrives after the malformed line and must not hide the protocol failure.
		// Dependencies: this test uses temp agent files and a fake child process with controlled stdout chunks.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit("data", "x".repeat(200_000));
						process.stdout.emit(
							"data",
							`\n${JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "done after noise" }],
								},
							})}\n`,
						);
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toContain("child pi emitted malformed RPC output");
		});
	});

	test("uses streamed output when oversized message_end metadata confirms skipped text", async () => {
		// Purpose: oversized final message content may use matching streamed text only after message_end metadata confirms skipped text.
		// Input and expected output: streamed deltas plus an oversized assistant message_end return the complete final answer.
		// Edge case: the final message_end line exceeds the raw stdout line buffer but still carries parseable metadata.
		// Dependencies: this test uses temp agent files, Pi truncation constants, and a fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const finalOutput = `large-final-${"x".repeat(300_000)}-end`;
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
						for (const delta of finalOutput.match(/.{1,100000}/gs) ?? []) {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									type: "message_update",
									assistantMessageEvent: {
										type: "text_delta",
										delta,
									},
								})}\n`,
							);
						}
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: finalOutput }],
								},
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
						);
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			const finalText = (result.details as { readonly finalOutput?: string })
				.finalOutput;
			expect(finalText?.startsWith("large-final-")).toBe(true);
			expect(finalText?.endsWith("-end")).toBe(true);
			expect(finalText?.length).toBe(finalOutput.length);
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
		});
	});

	test("uses streamed output when skipped text metadata appears after the stdout line buffer", async () => {
		// Purpose: oversized message_end parsing must not depend on the needed content metadata being in the bounded prefix.
		// Input and expected output: streamed deltas plus a message_end with large earlier metadata still return the streamed answer.
		// Edge case: content.type and content.text appear only after the raw stdout line buffer limit.
		// Dependencies: this test uses temp agent files, Pi truncation constants, and a fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const streamedAnswer = "late skipped text answer";
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								type: "message_update",
								assistantMessageEvent: {
									type: "text_delta",
									delta: streamedAnswer,
								},
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									usage: { debug: "x".repeat(300_000) },
									content: [{ type: "text", text: streamedAnswer }],
									stopReason: "stop",
								},
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
						);
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result).toMatchObject({
				content: [{ type: "text", text: streamedAnswer }],
			});
			expect((result.details as { readonly status?: string }).status).toBe(
				"succeeded",
			);
		});
	});

	test("reports missing final answer when message_end is lost after stdout line overflow", async () => {
		// Purpose: oversized final message_end output must not look like a successful empty subagent run.
		// Input and expected output: an oversized message_end without a parsed assistant message returns the no-final-answer diagnostic.
		// Edge case: the child exits successfully but the only final-answer event exceeded the raw stdout line buffer.
		// Dependencies: this test uses temp agent files and a fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const finalOutput = `lost-final-${"x".repeat(300_000)}-end`;
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: finalOutput }],
								},
							})}\n`,
						);
						process.stdout.emit(
							"data",
							`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
						);
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe("subagent completed without a final answer");
		});
	});

	test("reports an error when streamed final output exceeds the memory limit", async () => {
		// Purpose: streamed final-answer accumulation must stop before a runaway child process can grow memory without a bound.
		// Input and expected output: repeated text_delta events exceed the streamed-answer memory limit and return a clear execution error.
		// Edge case: each delta fits the raw stdout line buffer, but the accumulated final answer does not fit the streamed-answer limit.
		// Dependencies: this test uses temp agent files and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					queueMicrotask(() => {
						process.stdout.emit(
							"data",
							`${JSON.stringify({
								id: "run-subagent-prompt",
								type: "response",
								command: "prompt",
								success: true,
							})}\n`,
						);
						const delta = "x".repeat(100_000);
						for (let index = 0; index < 1_050; index += 1) {
							process.stdout.emit(
								"data",
								`${JSON.stringify({
									type: "message_update",
									assistantMessageEvent: {
										type: "text_delta",
										delta,
									},
								})}\n`,
							);
						}
						process.stdout.emit(
							"data",
							`${JSON.stringify({ type: "agent_end", messages: [] })}\n`,
						);
						process.emit("close", 0);
					});
					return process;
				},
			});

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(
				"child pi final response exceeded 100 MiB memory limit",
			);
		});
	});

	test("truncates large final child output and saves full output to a temp file", async () => {
		// Purpose: model-facing run_subagent content must be bounded while complete child answers remain available from a temp file.
		// Input and expected output: a child final answer over the Pi line limit returns tail-truncated content plus a full-output path.
		// Edge case: tail truncation preserves the latest child answer lines and omits the earliest line.
		// Dependencies: this test uses temp agent files, Pi truncation constants, and a fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helps with code",
				body: "Helper prompt",
			});
			const totalLines = DEFAULT_MAX_LINES + 5;
			const finalOutput = Array.from(
				{ length: totalLines },
				(_, index) => `child line ${index + 1}`,
			).join("\n");
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: finalOutput }],
					},
				}),
			);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as {
				readonly fullOutputPath?: string;
				readonly truncation?: {
					readonly truncated: boolean;
					readonly outputLines: number;
					readonly totalLines: number;
				};
			};

			expect(content).not.toBe(finalOutput);
			expect(content).not.toContain("child line 1\n");
			expect(content).toContain("child line 6\n");
			expect(content).toContain(`child line ${totalLines}`);
			expect(content).toContain(
				`[Showing lines 6-${totalLines} of ${totalLines}. Full output: `,
			);
			expect(details.truncation).toMatchObject({
				truncated: true,
				outputLines: DEFAULT_MAX_LINES,
				totalLines,
			});
			const fullOutputPath = details.fullOutputPath ?? "";
			expect(fullOutputPath).toStartWith(join(tmpdir(), "pi-run-subagent-"));
			expect(fullOutputPath).toEndWith(".log");
			expect(await readFile(fullOutputPath, "utf8")).toBe(finalOutput);
			await rm(fullOutputPath, { force: true });
		});
	});

	test("renders collapsed result rows with one shared row-count limit", async () => {
		// Purpose: collapsed run_subagent output must apply one shared row-count limit to progress events without duplicating the final answer.
		// Input and expected output: more events than the row-count limit render the latest events and one hidden-line expansion summary.
		// Edge case: final output is already rendered as an assistant message and must not consume collapsed progress rows.
		// Dependencies: this test uses the registered run_subagent renderer and its exported preview-count constant.
		await withIsolatedEnvironment(async () => {
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			const tool = getRunSubagentTool(pi);
			const eventCount = COLLAPSED_SUBAGENT_RESULT_LINES + 3;
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "done" }],
				details: {
					runId: "helper:1:1",
					agentId: "SubAgentExtractor",
					depth: 1,
					runtime: {
						modelId: "openai-codex/gpt-5.5",
						thinking: "medium",
						contextWindow: 272000,
					},
					contextUsage: {
						tokens: 35700,
						contextWindow: 272000,
						percent: 13.125,
					},
					status: "succeeded",
					elapsedMs: 43900,
					exitCode: 0,
					finalOutput: "done",
					stderr: "",
					stopReason: undefined,
					errorMessage: undefined,
					events: Array.from({ length: eventCount }, (_, index) => ({
						kind: "assistant",
						title: `event-${index + 1}`,
						text: `text-${index + 1}`,
						timestampMs: index + 1,
					})),
					omittedEventCount: 0,
					children: [],
				},
			};

			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const rendererState = {};
			const rendered = tool
				.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					theme as never,
					{
						args: { prompt: "Do work" },
						state: rendererState,
						invalidate: () => {},
					} as never,
				)
				.render(120);
			const renderedCall = tool
				.renderCall?.(
					{ agentId: "SubAgentExtractor", prompt: "Do work" },
					theme as never,
					{ state: rendererState } as never,
				)
				.render(120);

			expect(renderedCall?.[0]).toBe(
				"run_subagent SubAgentExtractor · openai-codex/gpt-5.5/medium · 35.7k/272k · 43.9s",
			);
			expect(renderedCall?.[0]).not.toContain("✓");
			expect(rendered).toHaveLength(COLLAPSED_SUBAGENT_RESULT_LINES + 1);
			const renderedLines = rendered ?? [];
			expect(renderedLines.some((line) => line.includes("• event-1 "))).toBe(
				false,
			);
			expect(renderedLines.some((line) => line.includes("• event-4 "))).toBe(
				true,
			);
			expect(
				renderedLines.some((line) => line.includes(`• event-${eventCount} `)),
			).toBe(true);
			expect(renderedLines.some((line) => line.includes("Final output"))).toBe(
				false,
			);
			expect(renderedLines.at(-1)).toContain("... (");
			expect(renderedLines.at(-1)).toContain("more lines");
			expect(renderedLines.at(-1)).toContain("total");
			expect(renderedLines.at(-1)).toContain("to expand");
			expect(rendered?.every((line) => visibleWidth(line) <= 120)).toBe(true);
		});
	});

	test("keeps subagent widget rows within visible terminal width for emoji variation sequences", () => {
		// Purpose: subagent widget output must satisfy pi TUI width checks when progress text contains grapheme clusters.
		// Input and expected output: the crash-log row containing `⚠️` renders at or below 120 visible columns.
		// Edge case: `⚠️` is a multi-code-point grapheme whose visible width is wider than the sum used by code-point slicing.
		// Dependencies: this test uses the exported widget panel formatter and pi-tui visible-width measurement.
		const renderedLines = formatSubagentWidgetPanel(
			[
				"   └─ ⏳ SubAgentSage 168s · 88.4k/272k · assistant ## Findings - **⚠️ FND-01 — Major** - **Location:** `pi-package/ex...",
			],
			120,
		);

		expect(renderedLines).not.toHaveLength(0);
		for (const line of renderedLines) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	test("renders run_subagent call rows without reset codes when truncating complex Unicode", async () => {
		// Purpose: run_subagent call previews must not reset parent TUI panel styling while clipping Unicode prompt text.
		// Input and expected output: a long prompt with combining marks, ZWJ emoji, and RTL text renders within 72 columns without SGR resets.
		// Edge case: truncation occurs after mixed-width graphemes and bidirectional text.
		// Dependencies: this test uses the registered run_subagent call renderer and a plain in-memory theme.
		await withIsolatedEnvironment(async () => {
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			const tool = getRunSubagentTool(pi);
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const prompt =
				"Return complex Unicode A̐éö̲ñ͜͡ 👨‍👩‍👧‍👦 🏳️‍🌈 שלום עולם مرحبا بالعالم العربية עברית END";

			const renderedLines =
				tool
					.renderCall?.(
						{ agentId: "SubAgentExtractor", prompt },
						theme as never,
						{} as never,
					)
					.render(72) ?? [];

			expect(renderedLines).not.toHaveLength(0);
			for (const line of renderedLines) {
				expect(line).not.toContain(SGR_RESET);
				expect(visibleWidth(line)).toBeLessThanOrEqual(72);
			}
		});
	});

	test("clips collapsed mixed-direction Unicode progress to one visual row", async () => {
		// Purpose: collapsed run_subagent progress must stay on one row because the tool shell owns row layout.
		// Input and expected output: the session-log Unicode line renders as one bounded row that uses the full available width before the ellipsis.
		// Edge case: the string includes combining marks, emoji sequences, right-to-left scripts, and explicit right-to-left marks.
		// Dependencies: this test uses the registered run_subagent renderer and pi-tui visible-width measurement.
		await withIsolatedEnvironment(async () => {
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			const tool = getRunSubagentTool(pi);
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const text =
				"Unicode-test: Здравствуй, мир! Привіт, світе! こんにちは世界 🌍🚀✨ — café naïve façade coöperate; math: ∑ᵢ₌₁ⁿ xᵢ² ≈ π; symbols: ♜♞♝♛♚♟; RTL: שלום עולם / مرحبا بالعالم; combining: é å ñ; emoji ZWJ: 👨‍👩‍👧‍👦 🧑🏽‍💻 🏳️‍🌈; rare: 𐍈 𠜎 𝄞";
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text }],
				details: {
					runId: "helper:1:1",
					agentId: "TestAgent",
					depth: 1,
					runtime: {
						modelId: "openai-codex/gpt-5.5",
						thinking: "low",
						contextWindow: 272000,
					},
					contextUsage: {
						tokens: 8666,
						contextWindow: 272000,
						percent: 3.1860294117647054,
					},
					status: "succeeded",
					elapsedMs: 9161,
					exitCode: 0,
					finalOutput: text,
					stderr: "",
					stopReason: "stop",
					errorMessage: undefined,
					events: [
						{
							kind: "assistant",
							title: "assistant",
							text,
							timestampMs: 1,
						},
					],
					omittedEventCount: 0,
					children: [],
				},
			};
			const renderWidth = 160;

			const collapsedLines =
				tool
					.renderResult?.(
						result,
						{ expanded: false, isPartial: false },
						theme as never,
						{ args: { prompt: "Do work" } } as never,
					)
					.render(renderWidth) ?? [];

			expect(collapsedLines).toHaveLength(1);
			expect(collapsedLines[0]).toContain("math:");
			expect(collapsedLines[0]).toContain("RTL:");
			expect(collapsedLines[0]).not.toContain("coöperate; …");
			expect(collapsedLines[0]).toEndWith("…");
			expect(collapsedLines[0]).not.toContain(SGR_RESET);
			expect(visibleWidth(collapsedLines[0] ?? "")).toBe(renderWidth);
		});
	});

	test("keeps collapsed subagent result rows within visible terminal width for emoji variation sequences", async () => {
		// Purpose: collapsed run_subagent progress rows must satisfy pi TUI width checks when event text contains grapheme clusters.
		// Input and expected output: an assistant progress event containing `⚠️` renders at or below 80 visible columns.
		// Edge case: truncation happens near `⚠️`, which exposes code-point-based width undercounting.
		// Dependencies: this test uses the registered run_subagent renderer and a plain in-memory theme.
		await withIsolatedEnvironment(async () => {
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			const tool = getRunSubagentTool(pi);
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "" }],
				details: {
					runId: "helper:1:1",
					agentId: "SubAgentSage",
					depth: 1,
					runtime: undefined,
					contextUsage: undefined,
					status: "running",
					elapsedMs: 168000,
					exitCode: undefined,
					finalOutput: "",
					stderr: "",
					stopReason: undefined,
					errorMessage: undefined,
					events: [
						{
							kind: "assistant",
							title: "assistant",
							text: "## Findings - **⚠️ FND-01 — Major** - **Location:** `pi-package/extensions/run-subagent/widget.ts`",
							timestampMs: 1,
						},
					],
					omittedEventCount: 0,
					children: [],
				},
			};

			const renderedLines =
				tool
					.renderResult?.(
						result,
						{ expanded: false, isPartial: false },
						theme as never,
						{ args: { prompt: "Do work" } } as never,
					)
					.render(80) ?? [];

			expect(renderedLines).not.toHaveLength(0);
			for (const line of renderedLines) {
				expect(line).not.toContain(SGR_RESET);
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
		});
	});

	test("uses --no-tools for an explicit empty tools list", async () => {
		// Purpose: an explicit empty child tool list must disable tools in the child process.
		// Input and expected output: empty tools frontmatter produces --no-tools and empty PI_SUBAGENT_TOOLS.
		// Edge case: empty array is different from missing tools.
		// Dependencies: this test uses temp agent files and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "No tools",
				body: "Helper prompt",
				tools: [],
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake(["read"]);
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			expect(spawn.calls[0]?.args).toContain("--no-tools");
			expect(spawn.calls[0]?.args).not.toContain("--tools");
			const { PI_SUBAGENT_TOOLS: childTools } =
				spawn.calls[0]?.options.env ?? {};
			expect(childTools).toBe("");
		});
	});

	test("injects the selected callable agent prompt when loaded in a child subagent process", async () => {
		// Purpose: child pi must receive the selected callable agent prompt through runtime composition.
		// Input and expected output: PI_SUBAGENT_AGENT_ID=helper contributes Helper prompt to before_agent_start.
		// Edge case: prompt injection is child-side and does not rely on parent process command flags.
		// Dependencies: this test uses temp agent files and process environment isolation.
		await withIsolatedEnvironment(
			async (agentDir) => {
				await writeAgent(agentDir, {
					id: "helper",
					type: "subagent",
					description: "Helper",
					body: "Helper prompt",
				});
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");

				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

				expect(
					await getBeforeAgentStartHandler(pi)({ systemPrompt: "Base" }, ctx),
				).toEqual({
					systemPrompt: [
						"Base",
						"Helper prompt",
						[
							"Callable agents available through run_subagent:",
							"- agentId: helper\n  description: Helper",
							"Use run_subagent with exactly one agentId and one prompt.",
							"For independent work, emit multiple run_subagent tool calls in the same assistant response so pi can run them in parallel.",
						].join("\n"),
					].join("\n\n"),
				});
			},
			"0",
			"helper",
		);
	});

	test("keeps child CLI tool policy when selected main-agent state exists", async () => {
		// Purpose: a child subagent process must keep the tools passed by run_subagent instead of restoring parent main-agent tools.
		// Input and expected output: persisted TestAgent enables only run_subagent, child SubAgentExtractor is active through PI_SUBAGENT_AGENT_ID, and session_start must not call setActiveTools(["run_subagent"]).
		// Edge case: the same cwd has a persisted main-agent state, which is valid for the parent process but stale inside the child process.
		// Dependencies: this test uses temp agent files, temp selected-agent state, main-agent-selection, and run-subagent composition.
		await withIsolatedEnvironment(
			async (agentDir) => {
				const cwd = "/tmp/project";
				await writeAgent(agentDir, {
					id: "TestAgent",
					type: "both",
					description: "Parent main agent",
					body: "Test agent prompt",
					tools: ["run_subagent"],
					agents: ["SubAgentExtractor"],
				});
				await writeAgent(agentDir, {
					id: "SubAgentExtractor",
					type: "subagent",
					description: "Extractor",
					body: "Extractor prompt",
					tools: ["read", "bash"],
				});
				await writeSelectedAgentState(agentDir, cwd, "TestAgent");
				const pi = createExtensionApiFake(["run_subagent", "read", "bash"]);
				const ctx = createContext(cwd);

				mainAgentSelection(pi);
				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
				for (const item of pi.handlers.filter(
					(handler) => handler.eventName === "session_start",
				)) {
					if (typeof item.handler === "function") {
						await item.handler({ type: "session_start" }, ctx);
					}
				}

				expect(pi.activeToolCalls).toEqual([]);
				const promptResult = await runBeforeAgentStartHandlers(
					pi,
					{ systemPrompt: "Base" },
					ctx,
				);
				expect(isPromptResult(promptResult)).toBe(true);
				expect(
					(promptResult as { readonly systemPrompt: string }).systemPrompt,
				).toContain("Extractor prompt");
				expect(pi.activeToolCalls).toEqual([]);
			},
			"0",
			"SubAgentExtractor",
		);
	});

	test("omits child tool flags and PI_SUBAGENT_TOOLS when tools are missing", async () => {
		// Purpose: missing tools must let child pi use its default tool state.
		// Input and expected output: no tools frontmatter produces no --tools, no --no-tools, and no PI_SUBAGENT_TOOLS.
		// Edge case: stale parent PI_SUBAGENT_TOOLS must not leak into the child process.
		// Dependencies: this test uses temp agent files and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			const previousTools = process.env[SUBAGENT_TOOLS_ENV];
			process.env[SUBAGENT_TOOLS_ENV] = "stale";
			try {
				await writeAgent(agentDir, {
					id: "helper",
					type: "subagent",
					description: "Default tools",
					body: "Helper prompt",
				});
				const spawn = createSpawnFake();
				const pi = createExtensionApiFake(["read"]);
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, { spawnPi: spawn.spawnPi });

				await executeRunSubagent(pi, ctx, {
					agentId: "helper",
					prompt: "Do work",
				});

				expect(spawn.calls[0]?.args).not.toContain("--tools");
				expect(spawn.calls[0]?.args).not.toContain("--no-tools");
				expect("PI_SUBAGENT_TOOLS" in (spawn.calls[0]?.options.env ?? {})).toBe(
					false,
				);
			} finally {
				if (previousTools === undefined) {
					delete process.env[SUBAGENT_TOOLS_ENV];
				} else {
					process.env[SUBAGENT_TOOLS_ENV] = previousTools;
				}
			}
		});
	});

	test("fails closed on invalid config and depth limit", async () => {
		// Purpose: invalid config must disable run_subagent without affecting other extensions.
		// Input and expected output: invalid maxDepth reports run-subagent warning, sets effective maxDepth to 0, and does not spawn.
		// Edge case: fail-closed config still keeps widgetLineBudget default internal behavior.
		// Dependencies: this test uses temp config and fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({ enabled: true, maxDepth: -1 }),
			);
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			expect(ctx.notifications).toEqual([
				{
					message:
						"[run-subagent] maxDepth must be an integer greater than or equal to 0",
					type: "warning",
				},
			]);
			expect(spawn.calls).toEqual([]);
			expect(result).toMatchObject({ content: [{ type: "text" }] });
		});
	});

	test("does not notify invalid config when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive run-subagent warning notifications.
		// Input and expected output: invalid maxDepth with hasUI false returns an error result without notifications or spawn calls.
		// Edge case: the UI object still has notify, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses temp config, temp agent files, and fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({ enabled: true, maxDepth: -1 }),
			);
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[],
				undefined,
				false,
			);
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			expect(ctx.notifications).toEqual([]);
			expect(spawn.calls).toEqual([]);
			expect(result).toMatchObject({ content: [{ type: "text" }] });
		});
	});

	test("rejects full wildcard tool patterns", async () => {
		// Purpose: full wildcard must not grant every tool to child agents.
		// Input and expected output: tools ["**"] rejects execution and does not spawn.
		// Edge case: all-wildcard patterns differ from narrower wildcard patterns such as grep*.
		// Dependencies: this test uses temp agent files and fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Unsafe tools",
				body: "Helper prompt",
				tools: ["**"],
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake(["read", "write"]);
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			expect(spawn.calls).toEqual([]);
			expect(result).toMatchObject({ content: [{ type: "text" }] });
		});
	});

	test("restores selected main-agent allowlist before exposing callable agents", async () => {
		// Purpose: callable-agent prompt must use the persisted selected main agent after session_start restores it.
		// Input and expected output: persisted TestAgent allows only SubAgentExtractor, so other callable agents and TestAgent itself are omitted.
		// Edge case: TestAgent has type both and would be globally callable without the selected main-agent allowlist.
		// Dependencies: this test uses temp agent files, temp selected-agent state, main-agent-selection, and run-subagent composition.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "SubAgentCoder",
				type: "subagent",
				description: "Coder",
				body: "Coder prompt",
			});
			await writeAgent(agentDir, {
				id: "SubAgentExtractor",
				type: "subagent",
				description: "Extractor",
				body: "Extractor prompt",
			});
			await writeAgent(agentDir, {
				id: "SubAgentSage",
				type: "subagent",
				description: "Sage",
				body: "Sage prompt",
			});
			await writeAgent(agentDir, {
				id: "TestAgent",
				type: "both",
				description: "Agent for testing subagents subsystem.",
				body: "Test agent prompt",
				tools: ["run_subagent"],
				agents: ["SubAgentExtractor"],
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "TestAgent");
			const pi = createExtensionApiFake(["run_subagent"]);
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			mainAgentSelection(pi);
			for (const item of pi.handlers.filter(
				(handler) => handler.eventName === "session_start",
			)) {
				if (typeof item.handler === "function") {
					await item.handler({ type: "session_start", reason: "startup" }, ctx);
				}
			}

			const result = await runBeforeAgentStartHandlers(
				pi,
				{ systemPrompt: "Base" },
				ctx,
			);

			expect(result).toEqual({
				systemPrompt: [
					"Base",
					"Test agent prompt",
					[
						"Callable agents available through run_subagent:",
						"- agentId: SubAgentExtractor\n  description: Extractor",
						"Use run_subagent with exactly one agentId and one prompt.",
						"For independent work, emit multiple run_subagent tool calls in the same assistant response so pi can run them in parallel.",
					].join("\n"),
				].join("\n\n"),
			});
		});
	});

	test("rejects callable agents blocked by the selected main-agent allowlist", async () => {
		// Purpose: execution must enforce the same selected main-agent subagent allowlist shown in the prompt.
		// Input and expected output: main allows helper, so blocked is rejected and no child process starts.
		// Edge case: blocked is a valid subagent globally but unavailable for the effective main agent.
		// Dependencies: this test uses temp agent files, main-agent-selection, run-subagent, and a fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["run_subagent"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "blocked",
				type: "subagent",
				description: "Blocked agent",
				body: "Blocked prompt",
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake(["run_subagent"]);
			const ctx = createContext("/tmp/project");
			mainAgentSelection(pi);
			await runSubagent(pi, { spawnPi: spawn.spawnPi });
			await pi.commands[0]?.handler("main", ctx);

			const result = await executeRunSubagent(pi, ctx, {
				agentId: "blocked",
				prompt: "Do work",
			});

			expect(spawn.calls).toEqual([]);
			expect(result).toMatchObject({
				content: [{ type: "text", text: "agent blocked was not found" }],
			});
		});
	});

	test("rejects execution when current subagent depth is invalid", async () => {
		// Purpose: malformed depth must fail closed instead of resetting to top-level depth.
		// Input and expected output: non-canonical PI_SUBAGENT_DEPTH values reject execution and do not spawn.
		// Edge case: only canonical base-10 non-negative integers are accepted; coercible strings are rejected.
		// Dependencies: this test sets only process environment for the isolated test scope.
		for (const depth of [
			"bad",
			"",
			"   ",
			"1e2",
			"+1",
			"01",
			"0x10",
			"1.0",
			"-0",
		]) {
			await withIsolatedEnvironment(async (agentDir) => {
				await writeAgent(agentDir, {
					id: "helper",
					type: "subagent",
					description: "Helper",
					body: "Helper prompt",
				});
				const spawn = createSpawnFake();
				const pi = createExtensionApiFake();
				const ctx = createContext("/tmp/project");
				await runSubagent(pi, { spawnPi: spawn.spawnPi });

				const result = await executeRunSubagent(pi, ctx, {
					agentId: "helper",
					prompt: "Do work",
				});

				expect(spawn.calls).toEqual([]);
				expect(result).toMatchObject({ content: [{ type: "text" }] });
			}, depth);
		}
	});

	test("hides run_subagent tool and prompt when current subagent depth reaches maxDepth", async () => {
		// Purpose: an agent at maxDepth must not see or receive run_subagent in its effective tool policy or prompt.
		// Input and expected output: depth 1 with maxDepth 1 keeps the selected main prompt, removes run_subagent, and omits callable-agent guidance.
		// Edge case: session_start restores run_subagent before composition, so the depth filter must run after restoration.
		// Dependencies: this test uses temp agent files, selected-agent state, main-agent-selection, and run-subagent composition.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["run_subagent", "read"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "main");
			const pi = createExtensionApiFake(["run_subagent", "read"]);
			const ctx = createContext("/tmp/project");
			mainAgentSelection(pi);
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			for (const item of pi.handlers.filter(
				(handler) => handler.eventName === "session_start",
			)) {
				if (typeof item.handler === "function") {
					await item.handler({ type: "session_start", reason: "startup" }, ctx);
				}
			}

			const result = await runBeforeAgentStartHandlers(
				pi,
				{ systemPrompt: "Base" },
				ctx,
			);

			expect(result).toEqual({ systemPrompt: "Base\n\nMain prompt" });
			expect(pi.getActiveTools()).toEqual(["read"]);
			expect(
				(result as { readonly systemPrompt: string }).systemPrompt,
			).not.toContain("Callable agents available through run_subagent:");
		}, "1");
	});

	test("rejects execution when current subagent depth reaches maxDepth", async () => {
		// Purpose: nested subagent calls must respect configured depth limits.
		// Input and expected output: current depth 1 with default maxDepth 1 rejects execution.
		// Edge case: missing config uses default maxDepth 1.
		// Dependencies: this test sets only process environment for the isolated test scope.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			});

			expect(spawn.calls).toEqual([]);
			expect(result).toMatchObject({ content: [{ type: "text" }] });
		}, "1");
	});

	test("composes filtered callable agents with main-agent-selection in both load orders", async () => {
		// Purpose: selected main-agent subagent policy must expose only allowed callable agents to the model prompt.
		// Input and expected output: main allows helper, so the prompt lists helper and omits blocked.
		// Edge case: extension load order must not change the composed prompt or active tools.
		// Dependencies: this test loads both extension factories by design to verify cross-extension composition.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["run_subagent"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "blocked",
				type: "subagent",
				description: "Blocked agent",
				body: "Blocked prompt",
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});

			const first = await loadAndSelectMainAgent(["main", "run"]);
			const second = await loadAndSelectMainAgent(["run", "main"]);

			expect(first).toEqual(second);
			expect(first.promptResult).toEqual({
				systemPrompt: [
					"Base",
					"Main prompt",
					[
						"Callable agents available through run_subagent:",
						"- agentId: helper\n  description: Helper agent",
						"Use run_subagent with exactly one agentId and one prompt.",
						"For independent work, emit multiple run_subagent tool calls in the same assistant response so pi can run them in parallel.",
					].join("\n"),
				].join("\n\n"),
			});
		});
	});
});

/** Loads extension factories in one order, selects the main agent, starts run-subagent resources, and returns composed output. */
async function loadAndSelectMainAgent(
	order: readonly ("main" | "run")[],
): Promise<{
	readonly promptResult: unknown;
	readonly activeToolCalls: string[][];
}> {
	const pi = createExtensionApiFake(["run_subagent"]);
	const ctx = createContext("/tmp/project", undefined, [], "main — Main agent");
	for (const extension of order) {
		if (extension === "main") {
			mainAgentSelection(pi);
		} else {
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
		}
	}

	const command = pi.commands.find(
		(registeredCommand) => registeredCommand.name === "agent",
	);
	if (command === undefined) {
		throw new Error("main-agent-selection command was not captured");
	}
	await command.handler("main", ctx);
	for (const handler of pi.handlers.filter(
		(item) => item.eventName === "session_start",
	)) {
		if (typeof handler.handler === "function") {
			await handler.handler({ type: "session_start", reason: "startup" }, ctx);
		}
	}

	return {
		promptResult: await getBeforeAgentStartHandler(pi)(
			{ systemPrompt: "Base" },
			ctx,
		),
		activeToolCalls: pi.activeToolCalls,
	};
}
