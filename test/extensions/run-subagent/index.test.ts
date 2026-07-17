import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import {
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import mainAgentSelection from "../../../pi-package/extensions/main-agent-selection/index";
import runSubagent from "../../../pi-package/extensions/run-subagent/index";
import type { SubagentRunDetails } from "../../../pi-package/extensions/run-subagent/progress";
import { AGENT_SUITE_DIR_ENV } from "../../../pi-package/shared/agent-suite-storage";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../../pi-package/shared/child-agent-environment";
import { HELPER_API_COST_CUSTOM_TYPE } from "../../../pi-package/shared/helper-api-cost";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
} from "../../../pi-package/shared/subagent-environment";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Matches Pi-compatible UUIDv7 session identifiers. */
const PI_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEPTH_ENV = SUBAGENT_DEPTH_ENV;
const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

/** SGR reset sequence that would break parent panel styling when embedded in truncated text. */
const SGR_RESET = `${String.fromCharCode(27)}[0m`;
/** Supplies semantic identity to tests that exercise behavior unrelated to task naming. */
const DEFAULT_TEST_TASK_NAME = "Execute test task";
/** Matches the child Pi startup failure that is retryable after parent auth succeeds. */
const NO_OPENAI_API_KEY_ERROR = `No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.`;

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

interface RegisteredShortcutFake {
	readonly shortcut: string;
	readonly handler: (ctx: unknown) => Promise<void>;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
	readonly commands: RegisteredCommandFake[];
	readonly shortcuts: RegisteredShortcutFake[];
	readonly activeToolCalls: string[][];
	readonly setModelCalls: Model<Api>[];
	readonly thinkingCalls: string[];
	readonly appendEntryCalls: Array<{ customType: string; data: unknown }>;
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

type ModelAuthResult =
	| { readonly ok: true; readonly apiKey?: string }
	| { readonly ok: false; readonly error: string };

interface CommandContextFake {
	readonly cwd: string;
	readonly mode: "tui" | "rpc" | "json" | "print";
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
		getApiKeyAndHeaders(model: Model<Api>): Promise<ModelAuthResult>;
	};
	readonly sessionManager: {
		getEntries(): readonly unknown[];
		getBranch(): readonly unknown[];
	};
}

interface AgentFixture {
	readonly id: string;
	readonly type: "main" | "subagent" | "both";
	readonly description: string;
	readonly body: string;
	readonly model?: { readonly id?: string; readonly thinking?: string };
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
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
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const previousDepth = process.env[DEPTH_ENV];
	const previousChildAgentId = process.env[SUBAGENT_AGENT_ID_ENV];
	const previousToolPatterns = process.env[SUBAGENT_TOOL_PATTERNS_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-run-subagent-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[AGENT_SUITE_DIR_ENV] = join(agentDir, "agent-suite");
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
	delete process.env[SUBAGENT_TOOL_PATTERNS_ENV];

	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
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
		if (previousToolPatterns === undefined) {
			delete process.env[SUBAGENT_TOOL_PATTERNS_ENV];
		} else {
			process.env[SUBAGENT_TOOL_PATTERNS_ENV] = previousToolPatterns;
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
	const shortcuts: RegisteredShortcutFake[] = [];
	const activeToolCalls: string[][] = [];
	const setModelCalls: Model<Api>[] = [];
	const thinkingCalls: string[] = [];
	const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
	let currentActiveTools: string[] = [];

	return {
		handlers,
		tools,
		commands,
		shortcuts,
		activeToolCalls,
		setModelCalls,
		thinkingCalls,
		appendEntryCalls,
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
		registerShortcut(
			shortcut: string,
			options: { handler: RegisteredShortcutFake["handler"] },
		): void {
			shortcuts.push({ shortcut, handler: options.handler });
		},
		appendEntry(customType: string, data: unknown): void {
			appendEntryCalls.push({ customType, data });
		},
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
	mode: CommandContextFake["mode"] = "tui",
	sessionEntries: readonly unknown[] = [],
	branchEntries: readonly unknown[] = sessionEntries,
	authResult: ModelAuthResult = { ok: true, apiKey: "test-key" },
): CommandContextFake & ContextObservations {
	const notifications: ContextObservations["notifications"] = [];
	const statuses: ContextObservations["statuses"] = [];
	const widgets: ContextObservations["widgets"] = [];

	return {
		cwd,
		mode,
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
				return [model, ...models].find(
					(candidate) =>
						candidate?.provider === provider && candidate.id === modelId,
				);
			},
			async getApiKeyAndHeaders(): Promise<ModelAuthResult> {
				return authResult;
			},
		},
		sessionManager: {
			getEntries(): readonly unknown[] {
				return sessionEntries;
			},
			getBranch(): readonly unknown[] {
				return branchEntries;
			},
		},
	};
}

/** Creates a context whose model-auth preflight returns the requested result. */
function createContextWithAuthResult(
	cwd: string,
	authResult: ModelAuthResult,
): CommandContextFake & ContextObservations {
	return createContext(
		cwd,
		createModel("openai", "parent"),
		[],
		undefined,
		undefined,
		"tui",
		[],
		[],
		authResult,
	);
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

/** Creates a persisted child-session reference that stays outside LLM context. */
function persistedSubagentSession(data: {
	readonly sessionId: number;
	readonly childSessionId: string;
	readonly childSessionDir: string;
	readonly agentId: string;
	readonly cwd: string;
}): unknown {
	return {
		type: "custom",
		id: `session-${data.sessionId}`,
		parentId: null,
		timestamp: "2026-07-14T00:00:00.000Z",
		customType: "run-subagent-session",
		data,
	};
}

/** Creates persisted terminal details for widget restoration tests. */
function persistedSubagentRunDetails(options: {
	readonly formatVersion?: number;
	readonly runId: string;
	readonly childSessionId: string;
	readonly sessionId: number;
	readonly taskName: string;
	readonly status?: "running" | "succeeded" | "failed" | "aborted";
	readonly isResume?: boolean;
	readonly children?: readonly unknown[];
}): unknown {
	return {
		formatVersion: options.formatVersion ?? 1,
		runId: options.runId,
		agentId: "SubAgentSage",
		taskName: options.taskName,
		sessionId: options.sessionId,
		isResume: options.isResume ?? false,
		depth: 1,
		runtime: undefined,
		childSessionId: options.childSessionId,
		childSessionDir: "/tmp/sessions",
		childSessionPath: `/tmp/sessions/${options.childSessionId}.jsonl`,
		contextUsage: undefined,
		contextProjectionStatus: undefined,
		status: options.status ?? "succeeded",
		elapsedMs: 1000,
		exitCode: 0,
		finalOutput: "done",
		stderr: "",
		stopReason: "stop",
		errorMessage: undefined,
		events: [],
		omittedEventCount: 0,
		children: options.children ?? [],
	};
}

/** Wraps one persisted tool result on the current main-session branch. */
function persistedSubagentToolResult(
	toolName: "run_subagent" | "resume_subagent",
	details: unknown,
): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `result-${toolName}`,
			toolName,
			content: [{ type: "text", text: "done" }],
			details,
			isError: false,
			timestamp: 1,
		},
	};
}

/** Creates one versioned invocation-start record without a matching final result. */
function persistedSubagentStart(options: {
	readonly formatVersion?: number;
	readonly runId: string;
	readonly childSessionId: string;
	readonly sessionId: number;
	readonly taskName: string;
	readonly isResume: boolean;
}): unknown {
	return {
		type: "custom",
		customType: "run-subagent-widget-start",
		data: {
			formatVersion: options.formatVersion ?? 1,
			runId: options.runId,
			childSessionId: options.childSessionId,
			sessionId: options.sessionId,
			agentId: "SubAgentSage",
			taskName: options.taskName,
			isResume: options.isResume,
			startedAtMs: 1000,
		},
	};
}

/** Creates one versioned browser-pin record. */
function persistedSubagentPin(
	childSessionId: string | undefined,
	formatVersion = 1,
): unknown {
	return {
		type: "custom",
		customType: "run-subagent-widget-pin",
		data: { formatVersion, childSessionId: childSessionId ?? null },
	};
}

/** Writes one Markdown agent definition into the isolated global registry. */
async function writeAgent(
	agentDir: string,
	agent: AgentFixture,
): Promise<void> {
	await writeAgentToDirectory(join(agentDir, "agents"), agent);
}

/** Writes one Markdown agent definition into a project's local registry. */
async function writeProjectAgent(
	projectDir: string,
	agent: AgentFixture,
): Promise<void> {
	await writeAgentToDirectory(join(projectDir, ".pi", "agents"), agent);
}

/** Writes one Markdown agent definition into the selected registry directory. */
async function writeAgentToDirectory(
	agentsDir: string,
	agent: AgentFixture,
): Promise<void> {
	await mkdir(agentsDir, { recursive: true });
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
	await writeFile(join(agentsDir, `${agent.id}.md`), lines.join("\n"));
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

/** Returns one registered subagent tool from the fake API. */
function getSubagentTool(
	pi: ExtensionApiFake,
	name: "run_subagent" | "resume_subagent",
): ToolDefinition {
	const tool = pi.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) {
		throw new Error(`expected ${name} tool to be registered`);
	}

	return tool;
}

/** Returns the registered new-session tool. */
function getRunSubagentTool(pi: ExtensionApiFake): ToolDefinition {
	return getSubagentTool(pi, "run_subagent");
}

/** Returns the registered continuation tool. */
function getResumeSubagentTool(pi: ExtensionApiFake): ToolDefinition {
	return getSubagentTool(pi, "resume_subagent");
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

/** Runs registered session-start handlers to restore session-scoped extension state. */
async function runSessionStartHandlers(
	pi: ExtensionApiFake,
	ctx: CommandContextFake,
): Promise<void> {
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "session_start",
	)) {
		if (typeof item.handler === "function") {
			await item.handler({ type: "session_start", reason: "startup" }, ctx);
		}
	}
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

/** Creates one complete assistant message for child RPC fixtures. */
function childAssistantMessage(
	text: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "openai",
		model: "model-a",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

/** Emits one JSONL RPC stdout message from a fake child process. */
function emitChildRpc(
	process: SpawnedProcessFake,
	message: Record<string, unknown>,
): void {
	process.stdout.emit("data", `${JSON.stringify(message)}\n`);
}

/** Completes one child after prompt preflight so concurrency tests stay focused on startup ordering. */
function completeChildRpcRun(
	process: SpawnedProcessFake,
	finalText: string,
): void {
	emitChildRpc(process, {
		type: "message_end",
		message: childAssistantMessage(finalText),
	});
	emitChildRpc(process, { type: "agent_end", messages: [] });
	process.emit("close", 0);
}

/** Extracts the first text block from a tool result fixture. */
function toolText(result: AgentToolResult<unknown>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

/** Formats the public tool text returned after a child session starts. */
function sessionToolText(text: string, sessionId = 1): string {
	return `Subagent session: ${sessionId}\n\n${text}`;
}

/** Writes Pi settings into the isolated agent directory used by child processes. */
async function writePiSettings(
	agentDir: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
}

/** Creates a fake that emits a distinct RPC transcript for each child attempt. */
function createSequentialSpawnFake(
	outputBatches: readonly (readonly string[])[],
): {
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
			const outputLines =
				outputBatches[calls.length] ?? outputBatches.at(-1) ?? [];
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

/** Creates manually controlled child processes and exposes each recorded spawn call. */
function createControlledSpawnFake(): {
	readonly calls: SpawnCall[];
	readonly spawnPi: (
		command: string,
		args: string[],
		options: SpawnCall["options"],
	) => SpawnedProcessFake;
	readonly waitForCall: (index: number) => Promise<SpawnCall>;
} {
	const calls: SpawnCall[] = [];
	const waiters = new Map<number, (call: SpawnCall) => void>();

	return {
		calls,
		spawnPi(
			command: string,
			args: string[],
			options: SpawnCall["options"],
		): SpawnedProcessFake {
			const process = new SpawnedProcessFakeImpl();
			const call = { command, args, options, process };
			calls.push(call);
			const callIndex = calls.length - 1;
			const resolveCall = waiters.get(callIndex);
			waiters.delete(callIndex);
			resolveCall?.(call);
			return process;
		},
		waitForCall(index: number): Promise<SpawnCall> {
			const call = calls[index];
			if (call !== undefined) {
				return Promise.resolve(call);
			}
			return new Promise((resolve) => {
				waiters.set(index, resolve);
			});
		},
	};
}

/** Loads run-subagent with the common callable agent used by startup behavior tests. */
async function createStartupTestHarness(
	agentDir: string,
	spawnPi: (
		command: string,
		args: string[],
		options: SpawnCall["options"],
	) => SpawnedProcessFake,
): Promise<{
	readonly pi: ExtensionApiFake;
	readonly ctx: CommandContextFake;
}> {
	await writeAgent(agentDir, {
		id: "helper",
		type: "subagent",
		description: "Helper",
		body: "Helper prompt",
	});
	const pi = createExtensionApiFake();
	const ctx = createContext("/tmp/project");
	await runSubagent(pi, { spawnPi });
	return { pi, ctx };
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

/** Executes the registered new-session tool through the fake ExtensionAPI. */
async function executeRunSubagent(
	pi: ExtensionApiFake,
	ctx: CommandContextFake,
	params: {
		readonly agentId: string;
		readonly taskName?: string;
		readonly prompt: string;
	},
	onUpdate?: (partial: AgentToolResult<unknown>) => void,
	signal?: AbortSignal,
): Promise<unknown> {
	return getRunSubagentTool(pi).execute(
		"tool-call-1",
		{
			...params,
			taskName: params.taskName ?? DEFAULT_TEST_TASK_NAME,
		},
		signal,
		onUpdate,
		ctx as never,
	);
}

/** Executes the registered continuation tool through the fake ExtensionAPI. */
async function executeResumeSubagent(
	pi: ExtensionApiFake,
	ctx: CommandContextFake,
	params: {
		readonly resumeSession: number;
		readonly taskName?: string;
		readonly prompt: string;
	},
	onUpdate?: (partial: AgentToolResult<unknown>) => void,
): Promise<unknown> {
	return getResumeSubagentTool(pi).execute(
		"tool-call-resume-1",
		{
			...params,
			taskName: params.taskName ?? DEFAULT_TEST_TASK_NAME,
		},
		undefined,
		onUpdate,
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
			expect(pi.tools.map((tool) => tool.name)).not.toContain(
				"resume_subagent",
			);
		});
	});

	test("registers two strict provider-visible parameter contracts", async () => {
		// Purpose: every calling model must receive one flat closed schema for each operation.
		// Input and expected output: each tool accepts only its own required identifier and rejects the other identifier, unknown fields, and invalid sessions.
		// Edge case: taskName bounds remain identical in both root object schemas without anyOf.
		// Dependencies: the test uses Pi's production validateToolArguments boundary with both registered schemas.
		const pi = createExtensionApiFake();
		await runSubagent(pi);
		const runTool = getRunSubagentTool(pi);
		const resumeTool = getResumeSubagentTool(pi);
		const validate = (
			tool: ToolDefinition,
			argumentsValue: Record<string, unknown>,
		): unknown =>
			validateToolArguments(tool as never, {
				type: "toolCall",
				id: "schema-call",
				name: tool.name,
				arguments: argumentsValue,
			});

		expect(() =>
			validate(runTool, {
				agentId: "Helper",
				taskName: "Inspect runtime behavior",
				prompt: "Inspect the runtime.",
			}),
		).not.toThrow();
		expect(() =>
			validate(resumeTool, {
				resumeSession: 1,
				taskName: "Continue runtime analysis",
				prompt: "Continue the analysis.",
			}),
		).not.toThrow();
		expect(() =>
			validate(runTool, {
				resumeSession: 1,
				taskName: "Continue runtime analysis",
				prompt: "Continue the analysis.",
			}),
		).toThrow();
		expect(() =>
			validate(resumeTool, {
				agentId: "Helper",
				taskName: "Inspect runtime behavior",
				prompt: "Inspect the runtime.",
			}),
		).toThrow();
		expect(() =>
			validate(runTool, {
				agentId: "Helper",
				taskName: "Inspect runtime behavior",
				prompt: "Inspect the runtime.",
				extra: true,
			}),
		).toThrow();
		expect(() =>
			validate(resumeTool, {
				resumeSession: 0,
				taskName: "Continue runtime analysis",
				prompt: "Continue the analysis.",
			}),
		).toThrow();

		const schemas = [
			{
				tool: runTool,
				required: ["agentId", "taskName", "prompt"],
				properties: ["agentId", "taskName", "prompt"],
			},
			{
				tool: resumeTool,
				required: ["resumeSession", "taskName", "prompt"],
				properties: ["resumeSession", "taskName", "prompt"],
			},
		] as const;
		for (const schemaCase of schemas) {
			const parameters = schemaCase.tool.parameters as unknown as {
				readonly additionalProperties: boolean;
				readonly anyOf?: unknown;
				readonly properties: Record<
					string,
					{ readonly minLength?: number; readonly maxLength?: number }
				>;
				readonly required: readonly string[];
			};
			expect(parameters.additionalProperties).toBe(false);
			expect(parameters.anyOf).toBeUndefined();
			expect(Object.keys(parameters.properties)).toEqual([
				...schemaCase.properties,
			]);
			expect(parameters.required).toEqual([...schemaCase.required]);
			expect(parameters.properties["taskName"]).toMatchObject({
				minLength: 3,
				maxLength: 60,
			});
		}
	});

	test("registers the subagent browser command and shortcut", async () => {
		// Purpose: users must be able to open the complete session list during interactive execution.
		// Input and expected output: extension load registers /subagents and Ctrl+Shift+G once.
		// Edge case: registration occurs before any subagent run exists.
		// Dependencies: the in-memory ExtensionAPI fake records command and shortcut metadata.
		const pi = createExtensionApiFake();

		await runSubagent(pi);

		expect(pi.commands.map((command) => command.name)).toContain("subagents");
		expect(pi.shortcuts.map((shortcut) => shortcut.shortcut)).toContain(
			"ctrl+shift+g",
		);
	});

	test("uses separate bundled descriptions when custom files are missing", async () => {
		// Purpose: both public tools must provide model-facing guidance without custom configuration.
		// Input and expected output: default extension load registers two non-empty descriptions, and the run-only description does not advertise continuation.
		// Edge case: tool identifiers define the capability boundary without asserting mutable prose.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake.
		const pi = createExtensionApiFake();

		await runSubagent(pi);

		expect(getRunSubagentTool(pi).description.trim().length).toBeGreaterThan(0);
		expect(getResumeSubagentTool(pi).description.trim().length).toBeGreaterThan(
			0,
		);
		expect(getRunSubagentTool(pi).description).not.toContain("resume_subagent");
		expect(getResumeSubagentTool(pi).description).toContain("resume_subagent");
	});

	test("uses independently configured absolute description files", async () => {
		// Purpose: each public tool must own its model-facing description source.
		// Input and expected output: two absolute prompt paths replace only their matching bundled descriptions.
		// Edge case: surrounding whitespace is removed from both custom prompts.
		// Dependencies: this test uses temporary prompt files and the in-memory ExtensionAPI fake.
		await withIsolatedEnvironment(async (agentDir) => {
			const runPromptFile = join(agentDir, "run-description.md");
			const resumePromptFile = join(agentDir, "resume-description.md");
			await writeFile(runPromptFile, "\nCustom run description\n\n");
			await writeFile(resumePromptFile, "\nCustom resume description\n\n");
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({
					runDescriptionPromptFile: runPromptFile,
					resumeDescriptionPromptFile: resumePromptFile,
				}),
			);
			const pi = createExtensionApiFake();

			await runSubagent(pi);

			expect(getRunSubagentTool(pi).description).toBe("Custom run description");
			expect(getResumeSubagentTool(pi).description).toBe(
				"Custom resume description",
			);
		});
	});

	test("rejects relative tool-description paths", async () => {
		// Purpose: both custom prompt file paths must follow the project absolute-path standard.
		// Input and expected output: each relative description path rejects extension startup with its field name.
		// Edge case: no prompt file is read after path validation fails.
		// Dependencies: this test uses isolated agent directories and the in-memory ExtensionAPI fake.
		for (const field of [
			"runDescriptionPromptFile",
			"resumeDescriptionPromptFile",
		] as const) {
			await withIsolatedEnvironment(async (agentDir) => {
				await writeRunSubagentConfig(
					agentDir,
					JSON.stringify({ [field]: "description.md" }),
				);

				await expect(runSubagent(createExtensionApiFake())).rejects.toThrow(
					`[run-subagent] ${field} must be an absolute path`,
				);
			});
		}
	});

	test("rejects a tilde runDescriptionPromptFile", async () => {
		// Purpose: custom prompt file paths must not use shell-specific expansion.
		// Input and expected output: a tilde runDescriptionPromptFile rejects extension startup.
		// Edge case: the path is treated as non-absolute instead of expanded.
		// Dependencies: this test uses an isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({ runDescriptionPromptFile: "~/description.md" }),
			);

			await expect(runSubagent(createExtensionApiFake())).rejects.toThrow(
				"[run-subagent] runDescriptionPromptFile must be an absolute path",
			);
		});
	});

	test("rejects empty and non-string runDescriptionPromptFile values", async () => {
		// Purpose: runDescriptionPromptFile must be absent or a non-empty absolute path string.
		// Input and expected output: empty and non-string values reject extension startup.
		// Edge case: invalid values must not fall back to the bundled description.
		// Dependencies: this test uses isolated agent directories and in-memory ExtensionAPI fake.
		for (const value of ["", 42] as const) {
			await withIsolatedEnvironment(async (agentDir) => {
				await writeRunSubagentConfig(
					agentDir,
					JSON.stringify({ runDescriptionPromptFile: value }),
				);

				await expect(runSubagent(createExtensionApiFake())).rejects.toThrow(
					"[run-subagent] runDescriptionPromptFile must be a non-empty string",
				);
			});
		}
	});

	test("rejects unreadable and empty configured description prompts", async () => {
		// Purpose: invalid custom description files must not silently fall back to the bundled description.
		// Input and expected output: missing and empty absolute files reject extension startup.
		// Edge case: unreadable file errors are matched without OS-specific details.
		// Dependencies: this test uses isolated prompt files and in-memory ExtensionAPI fake.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({
					runDescriptionPromptFile: join(agentDir, "missing.md"),
				}),
			);

			await expect(runSubagent(createExtensionApiFake())).rejects.toThrow(
				"[run-subagent] failed to read description prompt:",
			);
		});
		await withIsolatedEnvironment(async (agentDir) => {
			const promptFile = join(agentDir, "empty-description.md");
			await writeFile(promptFile, "\n\t ");
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({ runDescriptionPromptFile: promptFile }),
			);

			await expect(runSubagent(createExtensionApiFake())).rejects.toThrow(
				"[run-subagent] description prompt must not be empty",
			);
		});
	});

	test("does not validate tool-description paths when run-subagent is disabled", async () => {
		// Purpose: disabled run-subagent config must not validate unused prompt paths.
		// Input and expected output: enabled false with invalid paths registers neither subagent tool and does not throw.
		// Edge case: disabled config keeps its existing early-return behavior.
		// Dependencies: this test uses an isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeRunSubagentConfig(
				agentDir,
				JSON.stringify({
					enabled: false,
					runDescriptionPromptFile: "run.md",
					resumeDescriptionPromptFile: "resume.md",
				}),
			);
			const pi = createExtensionApiFake();

			await runSubagent(pi);

			expect(pi.tools.map((tool) => tool.name)).not.toContain("run_subagent");
			expect(pi.tools.map((tool) => tool.name)).not.toContain(
				"resume_subagent",
			);
		});
	});

	test("starts child pi with explicit model, thinking, tools, and subagent environment", async () => {
		// Purpose: a valid callable agent must start unrestricted child Pi and transport its tool patterns independently of the caller catalog.
		// Input and expected output: a caller without read or grep starts the child without tool CLI flags and passes the definition patterns as JSON.
		// Edge case: lowercase agentId input preserves stored agent ID casing in the child environment.
		// Dependencies: this test uses temp agent files, fake tool registry, and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Helper",
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
			const pi = createExtensionApiFake(["write"]);
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(spawn.calls).toHaveLength(1);
			const sessionIdIndex = spawn.calls[0]?.args.indexOf("--session-id") ?? -1;
			const childSessionId = spawn.calls[0]?.args[sessionIdIndex + 1];
			expect(childSessionId).toMatch(PI_SESSION_ID_PATTERN);
			expect(spawn.calls[0]).toMatchObject({
				command: "pi",
				args: [
					"--mode",
					"rpc",
					"--session-dir",
					join(agentDir, "agent-suite", "run-subagent", "sessions"),
					"--session-id",
					expect.any(String),
					"--model",
					"openai/child",
					"--thinking",
					"low",
				],
				options: {
					cwd: "/tmp/project",
					signal: undefined,
				},
			});
			expect(spawn.calls[0]?.options.env[CHILD_AGENT_PROCESS_ENV]).toBe(
				CHILD_AGENT_PROCESS_ENV_VALUE,
			);
			expect(spawn.calls[0]?.options.env[SUBAGENT_AGENT_ID_ENV]).toBe("Helper");
			expect(spawn.calls[0]?.options.env[SUBAGENT_DEPTH_ENV]).toBe("1");
			expect(spawn.calls[0]?.options.env[SUBAGENT_TOOL_PATTERNS_ENV]).toBe(
				JSON.stringify(["read", "grep*"]),
			);
			expect(spawn.calls[0]?.process.stdin.writes).toEqual([
				`${JSON.stringify({
					id: "run-subagent-prompt",
					type: "prompt",
					message: "Do work",
				})}\n`,
			]);
			expect(spawn.calls[0]?.process.stdin.ended).toBe(true);
			expect(result).toMatchObject({
				content: [{ type: "text", text: "Subagent session: 1\n\ndone" }],
			});
			const childSessionDir = join(
				agentDir,
				"agent-suite",
				"run-subagent",
				"sessions",
			);
			expect(result.details).toMatchObject({
				sessionId: 1,
				childSessionId,
				childSessionDir,
			});
			expect(pi.appendEntryCalls).toContainEqual({
				customType: "run-subagent-session",
				data: {
					sessionId: 1,
					childSessionId,
					childSessionDir,
					agentId: "Helper",
					cwd: "/tmp/project",
				},
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
			expect(renderedWidget.join("\n")).toContain("Subagents: 0 running");
			expect(renderedWidget.join("\n")).toContain("Helper #1 · Exec");
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

	test("uses the current project's agent override for prompt guidance and child execution", async () => {
		// Purpose: prompt guidance and run_subagent execution must resolve one project-local agent definition for the active cwd.
		// Input and expected output: local helper replaces global Helper and supplies the child model, transported tool patterns, and stored ID.
		// Edge case: the override and requested ID use different casing.
		// Dependencies: this test uses isolated global and project agent files plus fake child RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			const projectDir = join(agentDir, "project");
			await mkdir(projectDir);
			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Global helper",
				body: "Global helper prompt",
				model: { id: "openai/global", thinking: "low" },
				tools: ["read"],
			});
			await writeProjectAgent(projectDir, {
				id: "helper",
				type: "subagent",
				description: "Project helper",
				body: "Project helper prompt",
				model: { id: "openai/project", thinking: "high" },
				tools: ["bash"],
			});
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
					},
				}),
			);
			const pi = createExtensionApiFake([
				"run_subagent",
				"resume_subagent",
				"read",
				"bash",
			]);
			pi.setActiveTools(["run_subagent", "resume_subagent", "read", "bash"]);
			const ctx = createContext(projectDir);
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const promptResult = await runBeforeAgentStartHandlers(
				pi,
				{ systemPrompt: "Base" },
				ctx,
			);
			const result = await executeRunSubagent(pi, ctx, {
				agentId: "HELPER",
				prompt: "Do work",
			});

			expect(isPromptResult(promptResult)).toBe(true);
			expect(
				(promptResult as { readonly systemPrompt: string }).systemPrompt,
			).toContain("Project helper");
			expect(
				(promptResult as { readonly systemPrompt: string }).systemPrompt,
			).not.toContain("Global helper");
			expect(spawn.calls[0]?.args).toContain("openai/project");
			expect(spawn.calls[0]?.args).toContain("high");
			expect(spawn.calls[0]?.args).not.toContain("--tools");
			expect(spawn.calls[0]?.args).not.toContain("--no-tools");
			expect(spawn.calls[0]?.options.env[SUBAGENT_AGENT_ID_ENV]).toBe("helper");
			expect(spawn.calls[0]?.options.env[SUBAGENT_TOOL_PATTERNS_ENV]).toBe(
				JSON.stringify(["bash"]),
			);
			expect(result).toMatchObject({
				content: [{ type: "text", text: "Subagent session: 1\n\ndone" }],
			});
		});
	});

	test("resumes a saved child session by its short numeric id", async () => {
		// Purpose: review follow-up work must continue the original conversation using the current agent-definition snapshot.
		// Input and expected output: resumeSession 1 starts Pi with the existing JSONL path and transports newly configured grep* patterns.
		// Edge case: the caller catalog lacks grep, while the resumed run keeps the same public session ID and appends no second mapping.
		// Dependencies: this test uses a temporary child session file, two callable agents, and fake RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child", thinking: "low" },
			});
			await writeAgent(agentDir, {
				id: "Other",
				type: "subagent",
				description: "Other",
				body: "Other prompt",
				model: { id: "openai/other", thinking: "high" },
			});
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
					},
				}),
			);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await executeRunSubagent(pi, ctx, {
				agentId: "Helper",
				prompt: "Implement the change",
			});
			const sessionIdIndex = spawn.calls[0]?.args.indexOf("--session-id") ?? -1;
			const childSessionId = spawn.calls[0]?.args[sessionIdIndex + 1];
			const childSessionDir = join(
				agentDir,
				"agent-suite",
				"run-subagent",
				"sessions",
			);
			const childSessionPath = join(
				childSessionDir,
				`2026-07-14T00-00-00_${childSessionId}.jsonl`,
			);
			await mkdir(childSessionDir, { recursive: true });
			await writeFile(childSessionPath, "{}\n");
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const initialResumeHeader = getResumeSubagentTool(pi)
				.renderCall?.(
					{
						resumeSession: 1,
						taskName: "Repair review findings",
						prompt: "Apply the reviewer findings",
					},
					theme as never,
					{ state: {} } as never,
				)
				.render(120)[0];

			expect(initialResumeHeader).toBe("resume_subagent Helper · #1");

			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Helper",
				body: "Updated helper prompt",
				model: { id: "openai/child", thinking: "low" },
				tools: ["grep*"],
			});
			const resumeUpdates: AgentToolResult<unknown>[] = [];
			const result = (await executeResumeSubagent(
				pi,
				ctx,
				{
					taskName: "Repair review findings",
					prompt: "Apply the reviewer findings",
					resumeSession: 1,
				},
				(update) => resumeUpdates.push(update),
			)) as AgentToolResult<unknown>;

			expect(resumeUpdates[0]?.details).toMatchObject({
				sessionId: 1,
				isResume: true,
			});
			expect(spawn.calls).toHaveLength(2);
			expect(spawn.calls[1]?.args).toEqual([
				"--mode",
				"rpc",
				"--session-dir",
				childSessionDir,
				"--session",
				childSessionPath,
				"--model",
				"openai/child",
				"--thinking",
				"low",
			]);
			expect(spawn.calls[1]?.options.env[SUBAGENT_TOOL_PATTERNS_ENV]).toBe(
				JSON.stringify(["grep*"]),
			);
			expect(result).toMatchObject({
				content: [{ type: "text", text: "Subagent session: 1\n\ndone" }],
				details: {
					sessionId: 1,
					childSessionId,
					childSessionPath,
					agentId: "Helper",
					taskName: "Repair review findings",
					isResume: true,
				},
			});
			expect(
				pi.appendEntryCalls.filter(
					(entry) => entry.customType === "run-subagent-session",
				),
			).toHaveLength(1);
			expect(
				pi.appendEntryCalls.filter(
					(entry) => entry.customType === "run-subagent-widget-start",
				),
			).toHaveLength(2);
		});
	});

	test("restores short session ids after the main session restarts", async () => {
		// Purpose: the main agent must resume child sessions after Pi reloads persisted extension state.
		// Input and expected output: session_start restores alias 4, resume opens its JSONL file, and the next new run receives alias 5.
		// Edge case: gaps below the largest persisted alias are not reused.
		// Dependencies: this test uses one CustomEntry, a temporary JSONL file, and fake RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child", thinking: "low" },
			});
			const childSessionDir = join(
				agentDir,
				"agent-suite",
				"run-subagent",
				"sessions",
			);
			const childSessionId = "019f0000-0000-7000-8000-000000000004";
			const childSessionPath = join(
				childSessionDir,
				`2026-07-14T00-00-00_${childSessionId}.jsonl`,
			);
			await mkdir(childSessionDir, { recursive: true });
			await writeFile(childSessionPath, "{}\n");
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[],
				undefined,
				undefined,
				"tui",
				[
					persistedSubagentSession({
						sessionId: 4,
						childSessionId,
						childSessionDir,
						agentId: "Helper",
						cwd: "/tmp/project",
					}),
				],
			);
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
					},
				}),
			);
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: spawn.spawnPi });
			await runSessionStartHandlers(pi, ctx);

			const resumed = (await executeResumeSubagent(pi, ctx, {
				prompt: "Continue the work",
				resumeSession: 4,
			})) as AgentToolResult<unknown>;
			const created = (await executeRunSubagent(pi, ctx, {
				agentId: "Helper",
				prompt: "Start independent work",
			})) as AgentToolResult<unknown>;

			expect(spawn.calls[0]?.args).toContain("--session");
			expect(spawn.calls[0]?.args).toContain(childSessionPath);
			expect(resumed.details).toMatchObject({ sessionId: 4, childSessionId });
			expect(created.details).toMatchObject({ sessionId: 5 });
			const sessionEntries = pi.appendEntryCalls.filter(
				(entry) => entry.customType === "run-subagent-session",
			);
			expect(sessionEntries).toHaveLength(1);
			expect(sessionEntries[0]?.data).toMatchObject({ sessionId: 5 });
			expect(
				pi.appendEntryCalls.filter(
					(entry) => entry.customType === "run-subagent-widget-start",
				),
			).toHaveLength(2);
		});
	});

	test("restores logical widget sessions from the current branch", async () => {
		// Purpose: reopening a main session must rebuild one row per child session from persisted terminal results.
		// Input and expected output: a completed root with one descendant followed by a resumed terminal result becomes one updated root and retains the descendant.
		// Edge case: a no-details failure between terminal snapshots is ignored, and the resumed result has a new runId while omitting the completed descendant.
		// Dependencies: only current-branch tool results participate in widget reconstruction.
		await withIsolatedEnvironment(async () => {
			const childSessionId = "019f0000-0000-7000-8000-000000000010";
			const nestedSessionId = "019f0000-0000-7000-8000-000000000011";
			const initial = persistedSubagentRunDetails({
				runId: "initial-run",
				childSessionId,
				sessionId: 2,
				taskName: "Collect validation evidence",
				children: [
					persistedSubagentRunDetails({
						runId: "nested-run",
						childSessionId: nestedSessionId,
						sessionId: 1,
						taskName: "Review validation evidence",
					}),
				],
			});
			const resumed = persistedSubagentRunDetails({
				runId: "resumed-run",
				childSessionId,
				sessionId: 2,
				taskName: "Verify project quality gates",
				isResume: true,
			});
			const ctx = createContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				undefined,
				"tui",
				[],
				[
					persistedSubagentToolResult("run_subagent", initial),
					persistedSubagentToolResult("run_subagent", undefined),
					persistedSubagentToolResult("resume_subagent", resumed),
				],
			);
			const pi = createExtensionApiFake();
			await runSubagent(pi);

			await runSessionStartHandlers(pi, ctx);

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const rendered = (
				widgetFactory as () => { render(width: number): string[] }
			)()
				.render(160)
				.join("\n");
			expect(rendered).toContain("0 running · 0 failed · 2 done · 2/2 shown");
			expect(rendered).toContain("✓ Sage #2 · Verify project quality gates");
			expect(rendered).toContain("Sage #1 · Review validation evidence");
			expect(rendered).not.toContain("Collect validation evidence");
		});
	});

	test("restores unmatched invocation starts as aborted", async () => {
		// Purpose: a crash after launch must leave a visible terminal row instead of disappearing after restart.
		// Input and expected output: one valid start record without a terminal tool result restores as an aborted resumed session.
		// Edge case: the persisted start timestamp is older than the current extension runtime.
		// Dependencies: start records are UI-only CustomEntry values outside LLM context.
		await withIsolatedEnvironment(async () => {
			const ctx = createContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				undefined,
				"tui",
				[],
				[
					persistedSubagentStart({
						runId: "interrupted-run",
						childSessionId: "019f0000-0000-7000-8000-000000000012",
						sessionId: 7,
						taskName: "Continue interrupted review",
						isResume: true,
					}),
				],
			);
			const pi = createExtensionApiFake();
			await runSubagent(pi);

			await runSessionStartHandlers(pi, ctx);

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const rendered = (
				widgetFactory as () => { render(width: number): string[] }
			)()
				.render(120)
				.join("\n");
			expect(rendered).toContain("■ Sage #7 · Continue interrupted review");
		});
	});

	test("keeps a pin on the logical session across resume restoration", async () => {
		// Purpose: a browser pin must follow the logical child session when a later resume changes its invocation runId.
		// Input and expected output: an initial result, pin record, and resumed result restore the resumed session in focused mode.
		// Edge case: pin persistence precedes the resumed terminal result in branch order.
		// Dependencies: widget and browser identity use childSessionId rather than runId.
		await withIsolatedEnvironment(async () => {
			const childSessionId = "019f0000-0000-7000-8000-000000000013";
			const ctx = createContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				undefined,
				"tui",
				[],
				[
					persistedSubagentToolResult(
						"run_subagent",
						persistedSubagentRunDetails({
							runId: "initial-run",
							childSessionId,
							sessionId: 3,
							taskName: "Inspect initial state",
						}),
					),
					persistedSubagentPin(childSessionId),
					persistedSubagentToolResult(
						"resume_subagent",
						persistedSubagentRunDetails({
							runId: "resumed-run",
							childSessionId,
							sessionId: 3,
							taskName: "Inspect resumed state",
							isResume: true,
						}),
					),
				],
			);
			const pi = createExtensionApiFake();
			await runSubagent(pi);

			await runSessionStartHandlers(pi, ctx);

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const rendered = (
				widgetFactory as () => { render(width: number): string[] }
			)()
				.render(120)
				.join("\n");
			expect(rendered).toContain(
				"Root: SubAgentSage #3 · Inspect resumed state",
			);
			expect(rendered).not.toContain("Subagents:");
			expect(rendered).not.toContain("Inspect initial state");
		});
	});

	test("resets only affected widget recovery state for invalid records", async () => {
		// Purpose: malformed or unknown persisted UI formats must not fail startup or preserve stale presentation state.
		// Input and expected output: unknown terminal details and a malformed start clear prior runs, a later valid start rebuilds one aborted row, and an unknown pin version leaves automatic mode.
		// Edge case: valid records after the reset boundary remain recoverable.
		// Dependencies: session registry restoration remains independent from widget reconstruction.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "SubAgentSage",
				type: "subagent",
				description: "Sage",
				body: "Sage prompt",
			});
			const childSessionId = "019f0000-0000-7000-8000-000000000014";
			const childSessionDir = join(agentDir, "sessions");
			const childSessionPath = join(
				childSessionDir,
				`2026-07-14T00-00-00_${childSessionId}.jsonl`,
			);
			await mkdir(childSessionDir, { recursive: true });
			await writeFile(childSessionPath, "persisted child session\n");
			const originalChildSession = await readFile(childSessionPath, "utf8");
			const sessionEntry = persistedSubagentSession({
				sessionId: 9,
				childSessionId,
				childSessionDir,
				agentId: "SubAgentSage",
				cwd: "/tmp/project",
			});
			const ctx = createContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				undefined,
				"tui",
				[sessionEntry],
				[
					persistedSubagentToolResult(
						"run_subagent",
						persistedSubagentRunDetails({
							runId: "stale-run",
							childSessionId: "019f0000-0000-7000-8000-000000000015",
							sessionId: 1,
							taskName: "Stale recovered work",
						}),
					),
					persistedSubagentPin("019f0000-0000-7000-8000-000000000015"),
					persistedSubagentToolResult(
						"run_subagent",
						persistedSubagentRunDetails({
							formatVersion: 99,
							runId: "invalid-run",
							childSessionId: "019f0000-0000-7000-8000-000000000016",
							sessionId: 2,
							taskName: "Invalid recovered work",
						}),
					),
					{
						type: "custom",
						customType: "run-subagent-widget-start",
						data: { formatVersion: 1 },
					},
					persistedSubagentStart({
						runId: "fresh-run",
						childSessionId: "019f0000-0000-7000-8000-000000000017",
						sessionId: 4,
						taskName: "Fresh recovered work",
						isResume: false,
					}),
					persistedSubagentPin("019f0000-0000-7000-8000-000000000017", 99),
				],
			);
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "continued" }],
					},
				}),
			);
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			await expect(runSessionStartHandlers(pi, ctx)).resolves.toBeUndefined();

			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const rendered = (
				widgetFactory as () => { render(width: number): string[] }
			)()
				.render(120)
				.join("\n");
			expect(rendered).toContain("Subagents:");
			expect(rendered).toContain("■ Sage #4 · Fresh recovered work");
			expect(rendered).not.toContain("Stale recovered work");
			expect(rendered).not.toContain("Invalid recovered work");

			const resumed = (await executeResumeSubagent(pi, ctx, {
				resumeSession: 9,
				prompt: "Continue registered work",
			})) as AgentToolResult<unknown>;
			expect(toolText(resumed)).toBe("Subagent session: 9\n\ncontinued");
			expect(spawn.calls[0]?.args).toContain(childSessionPath);
			expect(await readFile(childSessionPath, "utf8")).toBe(
				originalChildSession,
			);
		});
	});

	test("rejects unknown and foreign-working-directory session ids", async () => {
		// Purpose: numeric aliases must resolve within the owning main session and working directory.
		// Input and expected output: unknown and different-cwd requests fail before spawning Pi.
		// Edge case: ownership checks run before looking for the child JSONL file.
		// Dependencies: this test restores one valid CustomEntry and its persisted agent identity.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child" },
			});
			const entry = persistedSubagentSession({
				sessionId: 4,
				childSessionId: "019f0000-0000-7000-8000-000000000004",
				childSessionDir: join(agentDir, "sessions"),
				agentId: "Helper",
				cwd: "/tmp/project",
			});
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[],
				undefined,
				undefined,
				"tui",
				[entry],
			);
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: spawn.spawnPi });
			await runSessionStartHandlers(pi, ctx);

			const unknown = (await executeResumeSubagent(pi, ctx, {
				prompt: "Continue",
				resumeSession: 9,
			})) as AgentToolResult<unknown>;
			const foreignCwd = (await executeResumeSubagent(
				pi,
				createContext("/tmp/other"),
				{
					prompt: "Continue",
					resumeSession: 4,
				},
			)) as AgentToolResult<unknown>;

			expect(toolText(unknown)).toBe("subagent session 9 was not found");
			expect(toolText(foreignCwd)).toContain(
				"belongs to working directory /tmp/project",
			);
			expect(spawn.calls).toHaveLength(0);
		});
	});

	test("rejects concurrent writes to the same resumed session", async () => {
		// Purpose: only one child process may append to a child JSONL session at a time.
		// Input and expected output: a second resume request fails while the first process is still active.
		// Edge case: the alias was restored from the main session rather than allocated in this process.
		// Dependencies: this test controls one fake child process and a temporary saved session file.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "Helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child" },
			});
			const childSessionDir = join(agentDir, "sessions");
			const childSessionId = "019f0000-0000-7000-8000-000000000001";
			const childSessionPath = join(
				childSessionDir,
				`2026-07-14T00-00-00_${childSessionId}.jsonl`,
			);
			await mkdir(childSessionDir, { recursive: true });
			await writeFile(childSessionPath, "{}\n");
			const ctx = createContext(
				"/tmp/project",
				createModel("openai", "parent"),
				[],
				undefined,
				undefined,
				"tui",
				[
					persistedSubagentSession({
						sessionId: 1,
						childSessionId,
						childSessionDir,
						agentId: "Helper",
						cwd: "/tmp/project",
					}),
				],
			);
			const processes: SpawnedProcessFake[] = [];
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const pi = createExtensionApiFake();
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					processes.push(process);
					resolveProcess(process);
					return process;
				},
			});
			await runSessionStartHandlers(pi, ctx);

			const firstResult = executeResumeSubagent(pi, ctx, {
				prompt: "Continue first",
				resumeSession: 1,
			});
			const process = await processReady;
			const secondResult = (await executeResumeSubagent(pi, ctx, {
				prompt: "Continue second",
				resumeSession: 1,
			})) as AgentToolResult<unknown>;

			expect(toolText(secondResult)).toBe(
				"subagent session 1 is already running",
			);
			expect(processes).toHaveLength(1);

			for (const line of rpcOutputLines({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				},
			})) {
				process.stdout.emit("data", `${line}\n`);
			}
			process.emit("close", 0);
			await expect(firstResult).resolves.toMatchObject({
				details: { sessionId: 1 },
			});
		});
	});

	test("keeps child session id within provider prompt cache key limit", async () => {
		// Purpose: child session persistence must use the UUIDv7 format expected by Codex subscription routing.
		// Input and expected output: a long tool call ID still produces a Pi-compatible UUIDv7 no longer than 64 characters.
		// Edge case: the child session ID remains independent from the parent tool call ID.
		// Dependencies: fake child process output and the run_subagent tool execution path.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/child" },
			});
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
					},
				}),
			);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });
			const longToolCallId = `call_${"very-long-segment_".repeat(12)}`;

			const result = (await getRunSubagentTool(pi).execute(
				longToolCallId,
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
				undefined,
				undefined,
				ctx as never,
			)) as AgentToolResult<unknown>;

			const sessionIdIndex = spawn.calls[0]?.args.indexOf("--session-id") ?? -1;
			const sessionId = spawn.calls[0]?.args[sessionIdIndex + 1];
			expect(sessionId).toBeString();
			expect(sessionId?.length).toBeLessThanOrEqual(64);
			expect(sessionId).toMatch(PI_SESSION_ID_PATTERN);
			expect(result.details).toMatchObject({ childSessionId: sessionId });
		});
	});

	test("renders child projection savings before child context usage in widget rows", async () => {
		// Purpose: widget rows must show the projection state published by the same child process.
		// Input and expected output: child setStatus(context-projection, ~65k) plus failed-run usage renders ~65k/155k/272k.
		// Edge case: parent/global statuses and unrelated child statuses must not be copied into the child row.
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
					id: "unrelated-status-1",
					method: "setStatus",
					statusKey: "unrelated-status",
					statusText: "262k",
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "error",
						errorMessage: "child failed",
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
			ctx.ui.setStatus("unrelated-status", "262k");
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
			expect(renderedWidget).toContain("~65k/155k/272k");
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

	test("clears and ignores non-positive child projection statuses in widget rows", async () => {
		// Purpose: widget rows must not show child projection states that do not represent positive savings.
		// Input and expected output: positive, error, ready, and clear statuses leave a failed-run row with plain 155k/272k usage.
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
						stopReason: "error",
						errorMessage: "child failed",
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
			expect(renderedWidget).toContain("155k/272k");
			expect(renderedWidget).not.toContain("~65k");
			expect(renderedWidget).not.toContain("~0");
			expect(renderedWidget).not.toContain("CP!");
		});
	});

	test("routes live progress to the TUI widget or non-TUI updates", async () => {
		// Purpose: interactive history receives one static runtime header while RPC parents retain every nested progress update.
		// Input and expected output: TUI receives one initial onUpdate plus widget updates, while RPC receives all progress updates.
		// Edge case: RPC reports hasUI true but still must not create a terminal widget.
		// Dependencies: the fake child process emits the normal prompt response and terminal agent events.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const tuiPi = createExtensionApiFake();
			const tuiContext = createContext("/tmp/project");
			const tuiUpdates: AgentToolResult<unknown>[] = [];
			await runSubagent(tuiPi, { spawnPi: createSpawnFake().spawnPi });

			await executeRunSubagent(
				tuiPi,
				tuiContext,
				{
					agentId: "helper",
					taskName: "Test TUI progress",
					prompt: "Do work",
				},
				(update) => tuiUpdates.push(update),
			);

			const rpcPi = createExtensionApiFake();
			const rpcContext = createContext(
				"/tmp/project",
				undefined,
				[],
				undefined,
				true,
				"rpc",
			);
			const rpcUpdates: AgentToolResult<unknown>[] = [];
			await runSubagent(rpcPi, { spawnPi: createSpawnFake().spawnPi });

			await executeRunSubagent(
				rpcPi,
				rpcContext,
				{
					agentId: "helper",
					taskName: "Test RPC progress",
					prompt: "Do work",
				},
				(update) => rpcUpdates.push(update),
			);

			expect(tuiUpdates).toHaveLength(1);
			const initialTuiDetails = tuiUpdates[0]?.details as
				| SubagentRunDetails
				| undefined;
			expect(initialTuiDetails).toMatchObject({
				sessionId: 1,
				isResume: false,
			});
			expect(initialTuiDetails?.runtime).toBeDefined();
			expect(tuiContext.widgets.length).toBeGreaterThan(0);
			expect(rpcUpdates.length).toBeGreaterThan(0);
			expect(rpcContext.widgets).toEqual([]);
		});
	});

	test("keeps widget state current when first activity arrives inside throttle window", async () => {
		// Purpose: widget state must not stay at starting when real child activity arrives before the next repaint is allowed.
		// Input and expected output: initial running update is followed by a tool call in the same throttle window, and the existing widget factory renders that activity.
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
									type: "tool_execution_start",
									toolName: "read",
									toolCallId: "call-1",
									args: { path: "README.md" },
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
				expect(renderedWidget).toContain('· read {"path":"README.md"}');
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

			expect(content).toBe(sessionToolText("prompt rejected"));
			expect(spawn.calls[0]?.process.stdin.ended).toBe(true);
		});
	});

	test("serializes child startup only until prompt preflight succeeds", async () => {
		// Purpose: concurrent subagents must not contend for startup auth while their full executions remain parallel.
		// Input and expected output: the second child waits for the first prompt success, then starts before the first child completes.
		// Edge case: both child executions remain active after the startup gate advances.
		// Dependencies: this test uses controlled fake child processes and concurrent tool execution.
		await withIsolatedEnvironment(async (agentDir) => {
			const spawn = createControlledSpawnFake();
			const { pi, ctx } = await createStartupTestHarness(
				agentDir,
				spawn.spawnPi,
			);

			const firstResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Run first child",
				prompt: "Do first work",
			});
			const firstCall = await spawn.waitForCall(0);
			const secondResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Run second child",
				prompt: "Do second work",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(spawn.calls).toHaveLength(1);
			emitChildRpc(firstCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: true,
			});
			const secondCall = await spawn.waitForCall(1);
			expect(spawn.calls).toHaveLength(2);
			expect(firstCall.process.stdin.ended).toBe(false);

			emitChildRpc(secondCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: true,
			});
			completeChildRpcRun(firstCall.process, "First complete");
			completeChildRpcRun(secondCall.process, "Second complete");

			expect(
				toolText((await firstResult) as AgentToolResult<unknown>),
			).toContain("First complete");
			expect(
				toolText((await secondResult) as AgentToolResult<unknown>),
			).toContain("Second complete");
		});
	});

	test("removes a cancelled child from the startup queue", async () => {
		// Purpose: cancelling a queued child must not spawn it or block later child startup.
		// Input and expected output: the second child is cancelled while the first owns startup, then the first releases normally.
		// Edge case: cancellation happens before the queued child creates any process or session file.
		// Dependencies: this test uses AbortController and one controlled fake child process.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createControlledSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const firstResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Run gate owner",
				prompt: "Hold startup",
			});
			const firstCall = await spawn.waitForCall(0);
			const controller = new AbortController();
			const cancelledResult = executeRunSubagent(
				pi,
				ctx,
				{
					agentId: "helper",
					taskName: "Cancel queued child",
					prompt: "Do not start",
				},
				undefined,
				controller.signal,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			controller.abort();

			expect(
				toolText((await cancelledResult) as AgentToolResult<unknown>),
			).toContain("subagent execution aborted");
			expect(spawn.calls).toHaveLength(1);

			emitChildRpc(firstCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: true,
			});
			completeChildRpcRun(firstCall.process, "Owner complete");
			await firstResult;
		});
	});

	test("advances the startup queue after prompt preflight rejection", async () => {
		// Purpose: a rejected prompt preflight must release startup ownership before the failed process exits.
		// Input and expected output: the second child starts after the first prompt rejection and completes normally.
		// Edge case: the rejected child remains alive briefly after its stdin closes.
		// Dependencies: this test uses controlled fake child processes and concurrent tool execution.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createControlledSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const rejectedResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Reject child preflight",
				prompt: "Reject this work",
			});
			const rejectedCall = await spawn.waitForCall(0);
			const successfulResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Run next child",
				prompt: "Do next work",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(spawn.calls).toHaveLength(1);

			emitChildRpc(rejectedCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: false,
				error: "prompt rejected",
			});
			const successfulCall = await spawn.waitForCall(1);
			expect(spawn.calls).toHaveLength(2);
			expect(rejectedCall.process.stdin.ended).toBe(true);
			rejectedCall.process.emit("close", 0);

			emitChildRpc(successfulCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: true,
			});
			completeChildRpcRun(successfulCall.process, "Next complete");

			expect(
				toolText((await rejectedResult) as AgentToolResult<unknown>),
			).toContain("prompt rejected");
			expect(
				toolText((await successfulResult) as AgentToolResult<unknown>),
			).toContain("Next complete");
		});
	});

	test("advances the startup queue when a child exits before preflight", async () => {
		// Purpose: a child that exits without an RPC response must not leave startup ownership locked.
		// Input and expected output: the second child starts after the first process closes and completes normally.
		// Edge case: the first child produces no stdout, session events, or prompt response.
		// Dependencies: this test uses controlled fake child processes and concurrent tool execution.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createControlledSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const exitedResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Exit during startup",
				prompt: "Exit before preflight",
			});
			const exitedCall = await spawn.waitForCall(0);
			const successfulResult = executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Run after exit",
				prompt: "Do work after exit",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(spawn.calls).toHaveLength(1);

			exitedCall.process.emit("close", 1);
			const successfulCall = await spawn.waitForCall(1);
			emitChildRpc(successfulCall.process, {
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: true,
			});
			completeChildRpcRun(successfulCall.process, "Recovered after exit");

			await exitedResult;
			expect(
				toolText((await successfulResult) as AgentToolResult<unknown>),
			).toContain("Recovered after exit");
		});
	});

	test("releases startup ownership when spawning child pi throws", async () => {
		// Purpose: a synchronous spawn failure must not poison later subagent startup.
		// Input and expected output: the first call rejects and the next call starts and completes normally.
		// Edge case: the failure occurs before child process handlers or prompt RPC are installed.
		// Dependencies: this test uses a spawn fake that throws only on its first call.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const successfulOutput = rpcOutputLines({
				type: "message_end",
				message: childAssistantMessage("Recovered after spawn failure"),
			});
			let spawnCount = 0;
			const spawnPi = (
				_command: string,
				_args: string[],
				_options: SpawnCall["options"],
			): SpawnedProcessFake => {
				spawnCount += 1;
				if (spawnCount === 1) {
					throw new Error("spawn failed");
				}
				const process = new SpawnedProcessFakeImpl();
				queueMicrotask(() => {
					for (const line of successfulOutput) {
						process.stdout.emit("data", `${line}\n`);
					}
					process.emit("close", 0);
				});
				return process;
			};
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi });

			await expect(
				executeRunSubagent(pi, ctx, {
					agentId: "helper",
					taskName: "Fail child spawn",
					prompt: "Fail to start",
				}),
			).rejects.toThrow("spawn failed");
			const recoveredResult = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				taskName: "Recover child spawn",
				prompt: "Start after failure",
			})) as AgentToolResult<unknown>;

			expect(spawnCount).toBe(2);
			expect(toolText(recoveredResult)).toContain(
				"Recovered after spawn failure",
			);
		});
	});

	test("retries a child startup auth race after parent auth succeeds", async () => {
		// Purpose: a child-only auth miss must recover after the parent resolves the same model credentials.
		// Input and expected output: the first child rejects auth, the second completes, and both attempts keep one session id.
		// Edge case: the failed child exits cleanly without creating execution events.
		// Dependencies: this test uses parent auth preflight and distinct fake RPC transcripts per attempt.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const authFailure = JSON.stringify({
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: false,
				error: NO_OPENAI_API_KEY_ERROR,
			});
			const spawn = createSequentialSpawnFake([
				[authFailure],
				rpcOutputLines({
					type: "message_end",
					message: childAssistantMessage("Recovered"),
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
			const sessionIds = spawn.calls.map((call) => {
				const index = call.args.indexOf("--session-id");
				return call.args[index + 1];
			});

			expect(content).toBe(sessionToolText("Recovered"));
			expect(spawn.calls).toHaveLength(2);
			expect(new Set(sessionIds).size).toBe(1);
		});
	});

	test("stops after three retries when the child auth race persists", async () => {
		// Purpose: transient auth recovery must remain bounded when every child startup misses credentials.
		// Input and expected output: four identical startup failures return the final auth error.
		// Edge case: all child processes exit with code zero and no execution events.
		// Dependencies: this test uses a successful parent preflight and a repeating fake transcript.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const authFailure = JSON.stringify({
				id: "run-subagent-prompt",
				type: "response",
				command: "prompt",
				success: false,
				error: NO_OPENAI_API_KEY_ERROR,
			});
			const spawn = createSequentialSpawnFake([[authFailure]]);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(sessionToolText(NO_OPENAI_API_KEY_ERROR));
			expect(spawn.calls).toHaveLength(4);
		});
	});

	test("does not start a child when parent model auth preflight fails", async () => {
		// Purpose: a real parent auth failure must not be classified as a transient child startup race.
		// Input and expected output: parent preflight rejects credentials and no child process starts.
		// Edge case: the failure uses the same wording that is retryable only after successful preflight.
		// Dependencies: this test uses an auth-aware context fake and no child RPC output.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContextWithAuthResult("/tmp/project", {
				ok: false,
				error: NO_OPENAI_API_KEY_ERROR,
			});
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(NO_OPENAI_API_KEY_ERROR);
			expect(spawn.calls).toHaveLength(0);
		});
	});

	test("does not retry a non-auth child startup failure", async () => {
		// Purpose: recovery must not repeat unrelated prompt or transport failures.
		// Input and expected output: child rejects the prompt for another reason and runs once.
		// Edge case: parent model auth preflight succeeds before the unrelated failure.
		// Dependencies: this test uses a fake child RPC process.
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

			expect(content).toBe(sessionToolText("prompt rejected"));
			expect(spawn.calls).toHaveLength(1);
		});
	});

	test("cancels child auth retries while waiting between attempts", async () => {
		// Purpose: parent cancellation must stop pending auth recovery without spawning another child.
		// Input and expected output: first startup misses auth, parent aborts during backoff, and result is aborted.
		// Edge case: no child process is active when cancellation arrives.
		// Dependencies: this test uses AbortController and a captured first child process.
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
			let spawnCount = 0;
			await runSubagent(pi, {
				spawnPi() {
					spawnCount += 1;
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					return process;
				},
			});

			const resultPromise = getRunSubagentTool(pi).execute(
				"tool-call-1",
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
				controller.signal,
				undefined,
				ctx as never,
			) as unknown as Promise<AgentToolResult<unknown>>;
			const process = await processReady;
			process.stdout.emit(
				"data",
				`${JSON.stringify({
					id: "run-subagent-prompt",
					type: "response",
					command: "prompt",
					success: false,
					error: NO_OPENAI_API_KEY_ERROR,
				})}\n`,
			);
			process.emit("close", 0);
			await new Promise((resolve) => queueMicrotask(resolve));
			controller.abort();

			const result = await resultPromise;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(sessionToolText("subagent execution aborted"));
			expect(spawnCount).toBe(1);
		});
	});

	test("does not start child pi when the parent signal is already aborted", async () => {
		// Purpose: cancellation before startup must not create a child process with no work to perform.
		// Input and expected output: an already-aborted signal returns the bounded abort error without spawning Pi.
		// Edge case: cancellation exists before authentication retry orchestration starts.
		// Dependencies: this test uses AbortController and a spawn fake that records process creation.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const controller = new AbortController();
			controller.abort();
			const spawn = createSpawnFake();
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project");
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await getRunSubagentTool(pi).execute(
				"tool-call-1",
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
				controller.signal,
				undefined,
				ctx as never,
			)) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(content).toBe(sessionToolText("subagent execution aborted"));
			expect(spawn.calls).toHaveLength(0);
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
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
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

			expect(content).toBe(sessionToolText("prompt rejected"));
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
					{
						agentId: "helper",
						taskName: DEFAULT_TEST_TASK_NAME,
						prompt: "Do work",
					},
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

				expect(content).toBe(sessionToolText("prompt rejected"));
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
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
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
					{
						agentId: "helper",
						taskName: DEFAULT_TEST_TASK_NAME,
						prompt: "Do work",
					},
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

			expect(content).toBe(
				sessionToolText("subagent exited before completing the task"),
			);
		});
	});

	test("terminates a child after a tool-policy startup extension error", async () => {
		// Purpose: child policy validation errors must fail the parent tool call before buffered prompt work can continue.
		// Input and expected output: a policy-specific session_start extension_error marks the run failed and sends SIGTERM.
		// Edge case: the extension error arrives before any prompt response or agent event.
		// Dependencies: this test uses fake Pi RPC output and the child-process termination boundary.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
			});
			const policyError =
				"run-subagent child tool policy: tool pattern yandex_* did not match any available tool";
			const spawn = createSpawnFake([
				JSON.stringify({
					type: "extension_error",
					event: "session_start",
					extensionPath: "/package/extensions/run-subagent/index.ts",
					error: policyError,
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

			expect(spawn.calls[0]?.process.killedSignals).toContain("SIGTERM");
			expect(content).toBe(sessionToolText(policyError));
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

			expect(content).toBe(
				sessionToolText("subagent completed without a final answer"),
			);
		});
	});

	test("uses the latest assistant message before RPC completion", async () => {
		// Purpose: final output must be the latest completed assistant message before agent_end.
		// Input and expected output: two assistant message_end events before completion return the second answer and record both child response costs.
		// Edge case: earlier completed text must be replaced only by another completed assistant text without double-counting cost after completion.
		// Dependencies: this test uses temp agent files, helper cost entries, and a fake child RPC process.
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
						message: childAssistantMessage("first answer", {
							usage: {
								cost: { total: 0.11 },
							},
						}),
					},
					{
						type: "message_end",
						message: childAssistantMessage("second answer", {
							usage: {
								cost: { total: 0.22 },
							},
						}),
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
				content: [{ type: "text", text: sessionToolText("second answer") }],
			});
			expect(
				pi.appendEntryCalls.filter(
					(entry) => entry.customType === HELPER_API_COST_CUSTOM_TYPE,
				),
			).toEqual([
				{
					customType: HELPER_API_COST_CUSTOM_TYPE,
					data: { source: "run-subagent", cost: 0.11 },
				},
				{
					customType: HELPER_API_COST_CUSTOM_TYPE,
					data: { source: "run-subagent", cost: 0.22 },
				},
			]);
		});
	});

	test("keeps child retry active after first retryable agent_end", async () => {
		// Purpose: child auto-retry emits a non-final agent_end before retry progress and final output.
		// Input and expected output: first retryable agent_end does not close stdin; final text comes from retry output.
		// Edge case: auto_retry_end(success=true) still waits for the later final agent_end.
		// Dependencies: isolated Pi settings and controlled child RPC stdout.
		await withIsolatedEnvironment(async (agentDir) => {
			await writePiSettings(agentDir, {
				retry: { enabled: true },
				compaction: { enabled: true },
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/model-a" },
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project", undefined, [
				createModel("openai", "model-a"),
			]);
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						emitChildRpc(process, {
							id: "run-subagent-prompt",
							type: "response",
							command: "prompt",
							success: true,
						});
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
			emitChildRpc(process, {
				type: "message_end",
				message: childAssistantMessage("temporary failure", {
					stopReason: "error",
					errorMessage: "server error 500",
				}),
			});
			emitChildRpc(process, { type: "agent_end" });
			await new Promise((resolve) => queueMicrotask(resolve));
			expect(process.stdin.ended).toBe(false);

			emitChildRpc(process, { type: "auto_retry_start", attempt: 1 });
			emitChildRpc(process, {
				type: "message_end",
				message: childAssistantMessage("retry success"),
			});
			emitChildRpc(process, { type: "auto_retry_end", success: true });
			expect(process.stdin.ended).toBe(false);
			emitChildRpc(process, { type: "agent_end" });
			process.emit("close", 0);

			const result = await resultPromise;
			expect(toolText(result)).toBe(sessionToolText("retry success"));
			expect(process.stdin.ended).toBe(true);
		});
	});

	test("fails child retry after auto_retry_end false", async () => {
		// Purpose: exhausted child auto-retry is a terminal child failure.
		// Input and expected output: retry failure closes stdin and returns the final retry error.
		// Edge case: the failing agent_end arrived before auto_retry_end(success=false).
		// Dependencies: isolated Pi settings and controlled child RPC stdout.
		await withIsolatedEnvironment(async (agentDir) => {
			await writePiSettings(agentDir, { retry: { enabled: true } });
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/model-a" },
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project", undefined, [
				createModel("openai", "model-a"),
			]);
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						emitChildRpc(process, {
							id: "run-subagent-prompt",
							type: "response",
							command: "prompt",
							success: true,
						});
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
			emitChildRpc(process, {
				type: "message_end",
				message: childAssistantMessage("temporary failure", {
					stopReason: "error",
					errorMessage: "server error 500",
				}),
			});
			emitChildRpc(process, { type: "agent_end" });
			emitChildRpc(process, {
				type: "auto_retry_end",
				success: false,
				finalError: "retry exhausted",
			});
			process.emit("close", 0);

			const result = await resultPromise;
			expect(toolText(result)).toContain("retry exhausted");
			expect(process.stdin.ended).toBe(true);
		});
	});

	test("renders estimated child context usage for zero-usage overflow", async () => {
		// Purpose: provider overflow errors with zero usage must not be displayed as real zero context usage.
		// Input and expected output: child message_end reports context overflow with totalTokens 0, and run_subagent details/rendering show approximate usage.
		// Edge case: compaction is unavailable, so the overflow message becomes the final failed child result.
		// Dependencies: isolated model registry, fake child RPC stdout, and run_subagent result renderer.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/model-a" },
			});
			const spawn = createSpawnFake(
				rpcOutputLines({
					type: "message_end",
					message: childAssistantMessage("", {
						content: [],
						stopReason: "error",
						errorMessage:
							"Codex error: Your input exceeds the context window of this model.",
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
					}),
				}),
			);
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project", undefined, [
				{ ...createModel("openai", "model-a"), contextWindow: 1_000 },
			]);
			await runSubagent(pi, { spawnPi: spawn.spawnPi });

			const result = (await executeRunSubagent(pi, ctx, {
				agentId: "helper",
				prompt: "Do work",
			})) as AgentToolResult<unknown>;

			expect(result.details).toMatchObject({
				contextUsage: {
					tokens: null,
					estimatedTokens: 1_000,
					contextWindow: 1_000,
				},
			});
			const widgetFactory = ctx.widgets.at(-1)?.content;
			expect(typeof widgetFactory).toBe("function");
			const renderedWidget = (
				widgetFactory as () => { render(width: number): string[] }
			)()
				.render(80)
				.join("\n");
			expect(renderedWidget).toContain("~/1k");
			expect(renderedWidget).not.toContain("0k/1k");
		});
	});

	test("keeps child overflow compaction active after first overflow agent_end", async () => {
		// Purpose: overflow compaction emits a non-final agent_end before recovery continuation.
		// Input and expected output: overflow agent_end does not close stdin; final text comes after compaction.
		// Edge case: silent stop overflow is classified from usage and contextWindow.
		// Dependencies: isolated Pi settings, model registry, and controlled child RPC stdout.
		await withIsolatedEnvironment(async (agentDir) => {
			await writePiSettings(agentDir, { compaction: { enabled: true } });
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper",
				body: "Helper prompt",
				model: { id: "openai/model-a" },
			});
			let resolveProcess: (process: SpawnedProcessFake) => void = () => {};
			const processReady = new Promise<SpawnedProcessFake>((resolve) => {
				resolveProcess = resolve;
			});
			const pi = createExtensionApiFake();
			const ctx = createContext("/tmp/project", undefined, [
				{ ...createModel("openai", "model-a"), contextWindow: 1_000 },
			]);
			await runSubagent(pi, {
				spawnPi() {
					const process = new SpawnedProcessFakeImpl();
					resolveProcess(process);
					queueMicrotask(() => {
						emitChildRpc(process, {
							id: "run-subagent-prompt",
							type: "response",
							command: "prompt",
							success: true,
						});
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
			emitChildRpc(process, {
				type: "message_end",
				message: childAssistantMessage("overflow", {
					usage: {
						input: 1_001,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_002,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				}),
			});
			emitChildRpc(process, { type: "agent_end" });
			await new Promise((resolve) => queueMicrotask(resolve));
			expect(process.stdin.ended).toBe(false);

			emitChildRpc(process, {
				type: "compaction_end",
				reason: "overflow",
				willRetry: true,
				aborted: false,
			});
			emitChildRpc(process, {
				type: "message_end",
				message: childAssistantMessage("after compaction"),
			});
			emitChildRpc(process, { type: "agent_end" });
			process.emit("close", 0);

			const result = await resultPromise;
			expect(toolText(result)).toBe(sessionToolText("after compaction"));
			expect(process.stdin.ended).toBe(true);
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
				content: [{ type: "text", text: sessionToolText("done after prompt") }],
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
				content: [{ type: "text", text: sessionToolText("completed answer") }],
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
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
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
				content: [{ type: "text", text: sessionToolText("completed answer") }],
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
				content: [{ type: "text", text: sessionToolText("completed answer") }],
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
				content: [{ type: "text", text: sessionToolText(finalAnswer) }],
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
				content: [{ type: "text", text: sessionToolText(finalAnswer) }],
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
				content: [{ type: "text", text: sessionToolText(streamedAnswer) }],
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
				content: [{ type: "text", text: sessionToolText(streamedAnswer) }],
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
				content: [{ type: "text", text: sessionToolText(streamedAnswer) }],
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
				content: [{ type: "text", text: sessionToolText("fresh answer") }],
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
				content: [{ type: "text", text: sessionToolText("completed answer") }],
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

			expect(content).toBe(
				sessionToolText("subagent completed without a final answer"),
			);
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

			expect(content).toBe(
				sessionToolText("subagent completed without a final answer"),
			);
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

			expect(content).toBe(
				sessionToolText("subagent exited before completing the task"),
			);
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
					{
						agentId: "helper",
						taskName: DEFAULT_TEST_TASK_NAME,
						prompt: "Do work",
					},
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
					{
						agentId: "helper",
						taskName: DEFAULT_TEST_TASK_NAME,
						prompt: "Do work",
					},
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
					{
						agentId: "helper",
						taskName: DEFAULT_TEST_TASK_NAME,
						prompt: "Do work",
					},
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
				{
					agentId: "helper",
					taskName: DEFAULT_TEST_TASK_NAME,
					prompt: "Do work",
				},
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
				content: [{ type: "text", text: sessionToolText("done 🙂") }],
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

			expect(content).toBe(sessionToolText(stderrText));
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
				content: [{ type: "text", text: sessionToolText(streamedAnswer) }],
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

			expect(content).toBe(
				sessionToolText("subagent completed without a final answer"),
			);
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
				sessionToolText(
					"child pi final response exceeded 100 MiB memory limit",
				),
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

	test("renders projection-aware header with an empty collapsed result", async () => {
		// Purpose: the historical header must stay static during execution and add final metrics only at completion.
		// Input and expected output: a partial result exposes model and thinking only; the final result adds projection, context, and elapsed time.
		// Edge case: retained events produce no collapsed result rows in either phase.
		// Dependencies: this test uses the registered run_subagent renderer and shared render state.
		await withIsolatedEnvironment(async () => {
			const pi = createExtensionApiFake();
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			const tool = getRunSubagentTool(pi);
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "done" }],
				details: {
					formatVersion: 1,
					runId: "helper:1:1",
					childSessionId: "019f0000-0000-7000-8000-000000000003",
					agentId: "SubAgentExtractor",
					taskName: "Extract runtime facts",
					sessionId: 3,
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
					contextProjectionStatus: "~159.7k",
					isResume: false,
					status: "succeeded",
					elapsedMs: 43900,
					exitCode: 0,
					finalOutput: "done",
					stderr: "",
					stopReason: undefined,
					errorMessage: undefined,
					events: [
						{
							kind: "assistant",
							title: "retained event",
							text: "retained text",
							timestampMs: 1,
						},
					],
					omittedEventCount: 0,
					children: [],
				},
			};

			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			const rendererState = {};
			const renderResultContext = {
				args: {
					taskName: "Extract runtime facts",
					prompt: "Do work",
				},
				state: rendererState,
				invalidate: () => {},
			} as never;
			const renderCall = (): string[] | undefined =>
				tool
					.renderCall?.(
						{
							agentId: "SubAgentExtractor",
							taskName: "Extract runtime facts",
							prompt: "Do work",
						},
						theme as never,
						{ state: rendererState } as never,
					)
					.render(120);

			tool
				.renderResult?.(
					result,
					{ expanded: false, isPartial: true },
					theme as never,
					renderResultContext,
				)
				.render(120);
			expect(renderCall()?.[0]).toBe(
				"run_subagent SubAgentExtractor · openai-codex/gpt-5.5/medium · #3",
			);

			const rendered = tool
				.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					theme as never,
					renderResultContext,
				)
				.render(120);
			const renderedCall = renderCall();

			expect(renderedCall?.[0]).toBe(
				"run_subagent SubAgentExtractor · openai-codex/gpt-5.5/medium · #3 · ~160k/36k/272k · 43.9s",
			);
			expect(renderedCall?.[0]).not.toContain("✓");
			expect(renderedCall?.every((line) => visibleWidth(line) <= 120)).toBe(
				true,
			);
			expect(rendered).toEqual([]);
		});
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
						{
							agentId: "SubAgentExtractor",
							taskName: "Render Unicode preview",
							prompt,
						},
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

	test("transports an explicit empty tools list without pruning the catalog", async () => {
		// Purpose: an explicit empty child tool list must disable active tools without pruning the child catalog.
		// Input and expected output: empty tools frontmatter produces no tool CLI flags and transports JSON [].
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

			expect(spawn.calls[0]?.args).not.toContain("--no-tools");
			expect(spawn.calls[0]?.args).not.toContain("--tools");
			expect(spawn.calls[0]?.options.env[SUBAGENT_TOOL_PATTERNS_ENV]).toBe(
				"[]",
			);
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
				const pi = createExtensionApiFake(["run_subagent", "resume_subagent"]);
				pi.setActiveTools(["run_subagent", "resume_subagent"]);
				const ctx = createContext("/tmp/project");

				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

				const result = await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base" },
					ctx,
				);
				if (!isPromptResult(result)) {
					throw new Error("before_agent_start did not return a system prompt");
				}
				expect(result.systemPrompt).toContain("Base");
				expect(result.systemPrompt).toContain("Helper prompt");
				expect(result.systemPrompt).toContain("run_subagent");
				expect(result.systemPrompt).toContain("helper");
				expect(result.systemPrompt).toContain("Helper");
			},
			"0",
			"helper",
		);
	});

	test("resolves child tool patterns when selected main-agent state exists", async () => {
		// Purpose: a child process must resolve transported patterns against its own catalog instead of restoring parent main-agent tools.
		// Input and expected output: patterns ["read", "ba*"] activate read and bash while stale parent selection remains ignored.
		// Edge case: the same cwd has persisted parent state and a disjoint main-agent tool set.
		// Dependencies: this test uses environment transport, temp selected-agent state, main-agent-selection, and run-subagent composition.
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
				process.env[SUBAGENT_TOOL_PATTERNS_ENV] = JSON.stringify([
					"read",
					"ba*",
				]);

				mainAgentSelection(pi);
				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
				for (const item of pi.handlers.filter(
					(handler) => handler.eventName === "session_start",
				)) {
					if (typeof item.handler === "function") {
						await item.handler({ type: "session_start" }, ctx);
					}
				}

				expect(pi.activeToolCalls).toEqual([["read", "bash"]]);
				const promptResult = await runBeforeAgentStartHandlers(
					pi,
					{ systemPrompt: "Base" },
					ctx,
				);
				expect(isPromptResult(promptResult)).toBe(true);
				expect(
					(promptResult as { readonly systemPrompt: string }).systemPrompt,
				).toContain("Extractor prompt");
				expect(pi.activeToolCalls).toEqual([["read", "bash"]]);
			},
			"0",
			"SubAgentExtractor",
		);
	});

	test("applies an explicit empty child tool policy", async () => {
		// Purpose: an explicit empty definition must disable every active child tool without pruning the catalog.
		// Input and expected output: JSON [] in the child policy environment produces one setActiveTools([]) call.
		// Edge case: an explicit empty policy differs from an absent policy, which preserves Pi defaults.
		// Dependencies: this test uses the session_start boundary and a fake child tool catalog.
		await withIsolatedEnvironment(
			async () => {
				process.env[SUBAGENT_TOOL_PATTERNS_ENV] = "[]";
				const pi = createExtensionApiFake(["read", "bash"]);
				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

				await runSessionStartHandlers(pi, createContext("/tmp/project"));

				expect(pi.activeToolCalls).toEqual([[]]);
			},
			"0",
			"Helper",
		);
	});

	test("fails closed on malformed child tool-pattern transport", async () => {
		// Purpose: malformed process-boundary data must not leave default child tools active.
		// Input and expected output: non-JSON transport clears active tools and rejects session startup with a policy error.
		// Edge case: diagnostics must not include the malformed raw value.
		// Dependencies: this test uses the session_start boundary and environment parsing.
		await withIsolatedEnvironment(
			async () => {
				process.env[SUBAGENT_TOOL_PATTERNS_ENV] = "not-json";
				const pi = createExtensionApiFake(["read"]);
				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

				await expect(
					runSessionStartHandlers(pi, createContext("/tmp/project")),
				).rejects.toThrow("child tool policy environment is invalid");
				expect(pi.activeToolCalls).toEqual([[]]);
			},
			"0",
			"Helper",
		);
	});

	test("fails closed when a child tool pattern has no catalog match", async () => {
		// Purpose: unknown child tool patterns must fail explicitly against the child catalog.
		// Input and expected output: yandex_* with only read available clears active tools and rejects startup.
		// Edge case: the exact unmatched pattern remains visible in the actionable error.
		// Dependencies: this test uses the shared wildcard resolver at the child session_start boundary.
		await withIsolatedEnvironment(
			async () => {
				process.env[SUBAGENT_TOOL_PATTERNS_ENV] = JSON.stringify(["yandex_*"]);
				const pi = createExtensionApiFake(["read"]);
				await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });

				await expect(
					runSessionStartHandlers(pi, createContext("/tmp/project")),
				).rejects.toThrow(
					"tool pattern yandex_* did not match any available tool",
				);
				expect(pi.activeToolCalls).toEqual([[]]);
			},
			"0",
			"Helper",
		);
	});

	test("omits child tool flags and patterns when tools are missing", async () => {
		// Purpose: missing tools must let child Pi use its default active-tool state.
		// Input and expected output: no tools frontmatter produces no tool CLI flags or child tool-pattern environment value.
		// Edge case: a stale parent tool-pattern value must not leak into the child process.
		// Dependencies: this test uses temp agent files and fake child process output.
		await withIsolatedEnvironment(async (agentDir) => {
			process.env[SUBAGENT_TOOL_PATTERNS_ENV] = "stale-patterns";
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
				expect(
					SUBAGENT_TOOL_PATTERNS_ENV in (spawn.calls[0]?.options.env ?? {}),
				).toBe(false);
			} finally {
				delete process.env[SUBAGENT_TOOL_PATTERNS_ENV];
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

	test("transports full wildcard patterns for child-side rejection", async () => {
		// Purpose: the parent must not validate a child policy against its restricted catalog.
		// Input and expected output: tools ["**"] starts unrestricted child Pi and transports the pattern unchanged.
		// Edge case: the child session_start boundary remains responsible for rejecting the unsafe full wildcard.
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

			expect(spawn.calls).toHaveLength(1);
			expect(spawn.calls[0]?.args).not.toContain("--tools");
			expect(spawn.calls[0]?.args).not.toContain("--no-tools");
			expect(spawn.calls[0]?.options.env[SUBAGENT_TOOL_PATTERNS_ENV]).toBe(
				JSON.stringify(["**"]),
			);
			expect(result).toMatchObject({ content: [{ type: "text" }] });
		});
	});

	test("restores selected main-agent allowlist before exposing callable agents", async () => {
		// Purpose: callable-agent prompt must use the persisted selected main agent after session_start restores it.
		// Input and expected output: persisted TestAgent allows only SubAgentExtractor through a lowercase allowlist, so other callable agents and TestAgent itself are omitted.
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
				agents: ["subagentextractor"],
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "TestAgent");
			const pi = createExtensionApiFake(["run_subagent", "resume_subagent"]);
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

			if (!isPromptResult(result)) {
				throw new Error("before_agent_start did not return a system prompt");
			}
			expect(result.systemPrompt).toContain("Base");
			expect(result.systemPrompt).toContain("Test agent prompt");
			expect(result.systemPrompt).toContain("run_subagent");
			expect(result.systemPrompt).not.toContain("resume_subagent");
			expect(pi.getActiveTools()).toEqual(["run_subagent"]);
			expect(result.systemPrompt).toContain("SubAgentExtractor");
			expect(result.systemPrompt).toContain("Extractor");
			expect(result.systemPrompt).not.toContain("SubAgentCoder");
			expect(result.systemPrompt).not.toContain("SubAgentSage");
			expect(result.systemPrompt).not.toContain("TestAgent");
		});
	});

	test("aligns callable-agent guidance with the final active tool set", async () => {
		// Purpose: system guidance must describe only delegation tools that remain active after runtime filtering.
		// Input and expected output: neither, run-only, both, and resume-only active sets produce matching tools and guidance.
		// Edge case: resume_subagent without the master run_subagent is removed and contributes no prompt.
		// Dependencies: runtime composition filters active tools before building the dynamic prompt.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			const cases = [
				{
					initialTools: ["read"],
					expectedTools: ["read"],
					expectRunGuidance: false,
					expectResumeGuidance: false,
				},
				{
					initialTools: ["run_subagent"],
					expectedTools: ["run_subagent"],
					expectRunGuidance: true,
					expectResumeGuidance: false,
				},
				{
					initialTools: ["run_subagent", "resume_subagent"],
					expectedTools: ["run_subagent", "resume_subagent"],
					expectRunGuidance: true,
					expectResumeGuidance: true,
				},
				{
					initialTools: ["resume_subagent"],
					expectedTools: [],
					expectRunGuidance: false,
					expectResumeGuidance: false,
				},
			] as const;

			for (const item of cases) {
				const pi = createExtensionApiFake([
					"read",
					"run_subagent",
					"resume_subagent",
				]);
				pi.setActiveTools([...item.initialTools]);
				await runSubagent(pi);

				const result = await getBeforeAgentStartHandler(pi)(
					{ systemPrompt: "Base" },
					createContext("/tmp/project"),
				);
				const systemPrompt = isPromptResult(result) ? result.systemPrompt : "";

				expect(pi.getActiveTools()).toEqual([...item.expectedTools]);
				expect(
					systemPrompt.includes(
						"Use run_subagent with agentId to start an independent child session.",
					),
				).toBe(item.expectRunGuidance);
				expect(
					systemPrompt.includes(
						"Use resume_subagent with resumeSession to continue an existing child session.",
					),
				).toBe(item.expectResumeGuidance);
				expect(systemPrompt.includes("Helper agent")).toBe(
					item.expectRunGuidance,
				);
			}
		});
	});

	test("keeps both subagent tools when both are explicitly allowed", async () => {
		// Purpose: explicit policy must expose continuation without widening any narrower allowlist.
		// Input and expected output: a main agent that lists both tools keeps both active and receives guidance for each operation.
		// Edge case: the selected agent and callable-agent guidance are restored through session_start composition.
		// Dependencies: main-agent-selection owns the explicit tool list before the removal-only subagent filter runs.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["run_subagent", "resume_subagent"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "main");
			const pi = createExtensionApiFake(["run_subagent", "resume_subagent"]);
			const ctx = createContext("/tmp/project");
			mainAgentSelection(pi);
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			await runSessionStartHandlers(pi, ctx);

			const result = await runBeforeAgentStartHandlers(
				pi,
				{ systemPrompt: "Base" },
				ctx,
			);

			if (!isPromptResult(result)) {
				throw new Error("before_agent_start did not return a system prompt");
			}
			expect(pi.getActiveTools()).toEqual(["run_subagent", "resume_subagent"]);
			expect(result.systemPrompt).toContain("Use run_subagent with agentId");
			expect(result.systemPrompt).toContain(
				"Use resume_subagent with resumeSession",
			);
			expect(result.systemPrompt).toContain("Helper agent");
		});
	});

	test("removes resume_subagent when run_subagent is not allowed", async () => {
		// Purpose: run_subagent must remain the master capability for all delegation.
		// Input and expected output: a resume-only main-agent allowlist produces no active subagent tools or callable-agent guidance.
		// Edge case: resume_subagent exists in the global tool registry and is explicitly listed by the selected agent.
		// Dependencies: runtime composition applies selected-agent policy before the run-subagent removal-only filter.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["resume_subagent", "read"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "main");
			const pi = createExtensionApiFake([
				"run_subagent",
				"resume_subagent",
				"read",
			]);
			const ctx = createContext("/tmp/project");
			mainAgentSelection(pi);
			await runSubagent(pi, { spawnPi: createSpawnFake().spawnPi });
			await runSessionStartHandlers(pi, ctx);

			const result = await runBeforeAgentStartHandlers(
				pi,
				{ systemPrompt: "Base" },
				ctx,
			);

			if (!isPromptResult(result)) {
				throw new Error("before_agent_start did not return a system prompt");
			}
			expect(pi.getActiveTools()).toEqual(["read"]);
			expect(result.systemPrompt).not.toContain("run_subagent");
			expect(result.systemPrompt).not.toContain("resume_subagent");
			expect(result.systemPrompt).not.toContain("Helper agent");
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

	test("hides both subagent tools and prompt when current depth reaches maxDepth", async () => {
		// Purpose: an agent at maxDepth must not see either delegation tool or callable-agent guidance.
		// Input and expected output: depth 1 with maxDepth 1 keeps the selected main prompt, removes both tools, and omits callable-agent guidance.
		// Edge case: session_start restores both tools before composition, so the depth filter must run after restoration.
		// Dependencies: this test uses temp agent files, selected-agent state, main-agent-selection, and run-subagent composition.
		await withIsolatedEnvironment(async (agentDir) => {
			await writeAgent(agentDir, {
				id: "main",
				type: "main",
				description: "Main agent",
				body: "Main prompt",
				tools: ["run_subagent", "resume_subagent", "read"],
				agents: ["helper"],
			});
			await writeAgent(agentDir, {
				id: "helper",
				type: "subagent",
				description: "Helper agent",
				body: "Helper prompt",
			});
			await writeSelectedAgentState(agentDir, "/tmp/project", "main");
			const pi = createExtensionApiFake([
				"run_subagent",
				"resume_subagent",
				"read",
			]);
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

			if (!isPromptResult(result)) {
				throw new Error("before_agent_start did not return a system prompt");
			}
			expect(result.systemPrompt).toContain("Base");
			expect(result.systemPrompt).toContain("Main prompt");
			expect(result.systemPrompt).not.toContain("run_subagent");
			expect(result.systemPrompt).not.toContain("resume_subagent");
			expect(result.systemPrompt).not.toContain("helper");
			expect(pi.getActiveTools()).toEqual(["read"]);
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
			if (!isPromptResult(first.promptResult)) {
				throw new Error("before_agent_start did not return a system prompt");
			}
			expect(first.promptResult.systemPrompt).toContain("Base");
			expect(first.promptResult.systemPrompt).toContain("Main prompt");
			expect(first.promptResult.systemPrompt).toContain("run_subagent");
			expect(first.promptResult.systemPrompt).toContain("helper");
			expect(first.promptResult.systemPrompt).toContain("Helper agent");
			expect(first.promptResult.systemPrompt).not.toContain("blocked");
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
