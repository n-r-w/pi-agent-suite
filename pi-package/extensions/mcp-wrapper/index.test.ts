import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage.ts";
import type { McpClientManager } from "./client-manager.ts";
import type { McpServerConfig } from "./config.ts";
import mcpWrapper from "./index.ts";
import {
	computeMcpServerConfigHash,
	loadMcpWrapperCache,
	saveMcpWrapperCache,
} from "./metadata-cache.ts";

const FILES_READ_TOOL_NAME = "files_read";
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<unknown> | unknown;
}

interface NotificationRecord {
	readonly message: string;
	readonly type: "info" | "warning" | "error" | undefined;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function managerWithCleanup<
	T extends Pick<McpClientManager, "discoverServers" | "callTool">,
>(
	manager: T & Partial<Pick<McpClientManager, "closeAll">>,
): T & Pick<McpClientManager, "closeAll"> {
	return {
		...manager,
		closeAll: manager.closeAll ?? (async () => {}),
	};
}

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const tools: ToolDefinition[] = [];
	let activeTools: readonly string[] = [];

	return {
		handlers,
		tools,
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
		on(eventName: string, handler: RegisteredHandler["handler"]): void {
			handlers.push({ eventName, handler });
		},
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		registerCompletionProvider(): void {},
		registerResourceProvider(): void {},
		registerCustomProvider(): void {},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(toolNames: readonly string[]): void {
			activeTools = [...toolNames];
		},
		getModel(): undefined {
			return undefined;
		},
		setModel(): void {},
		getThinkingLevel(): undefined {
			return undefined;
		},
		setThinkingLevel(): void {},
		appendEntry(): void {},
		getSessionHistory() {
			return [];
		},
		getSessionTree() {
			return undefined;
		},
		getActiveBranch() {
			return [];
		},
	} as unknown as ExtensionApiFake;
}

async function runSessionStart(
	pi: ExtensionApiFake,
	notifications: NotificationRecord[] = [],
	statuses: Array<{ readonly key: string; readonly text: string }> = [],
): Promise<void> {
	const sessionStart = pi.handlers.find(
		(handler) => handler.eventName === "session_start",
	);
	expect(sessionStart).toBeDefined();
	await sessionStart?.handler({ type: "session_start", reason: "startup" }, {
		hasUI: true,
		ui: {
			notify(message: string, type?: "info" | "warning" | "error"): void {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string): void {
				statuses.push({ key, text });
			},
		},
	} as ExtensionContext);
}

async function runSessionShutdown(pi: ExtensionApiFake): Promise<void> {
	const sessionShutdown = pi.handlers.find(
		(handler) => handler.eventName === "session_shutdown",
	);
	expect(sessionShutdown).toBeDefined();
	await sessionShutdown?.handler(
		{ type: "session_shutdown" },
		{} as ExtensionContext,
	);
}

async function prepareSuiteCacheDir(): Promise<string> {
	const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-index-"));
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	return suiteDir;
}

function restoreSuiteDir(): void {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
		return;
	}
	process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
}

async function resolvesWithin(
	promise: Promise<unknown>,
	milliseconds: number,
): Promise<boolean> {
	return (await Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) =>
			setTimeout(() => resolve(false), milliseconds),
		),
	])) as boolean;
}

async function runBeforeAgentStart(
	pi: ExtensionApiFake,
	systemPrompt = "Base prompt",
): Promise<string> {
	let currentPrompt = systemPrompt;
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "before_agent_start",
	)) {
		const result = await item.handler(
			{
				type: "before_agent_start",
				prompt: "work",
				images: [],
				systemPrompt: currentPrompt,
				systemPromptOptions: {},
			},
			{} as ExtensionContext,
		);
		if (
			typeof result === "object" &&
			result !== null &&
			"systemPrompt" in result &&
			typeof result.systemPrompt === "string"
		) {
			currentPrompt = result.systemPrompt;
		}
	}

	return currentPrompt;
}

beforeEach(async () => {
	await prepareSuiteCacheDir();
});

afterEach(() => {
	restoreSuiteDir();
});

describe("mcp-wrapper extension", () => {
	test("registers no tools and reports no warning when config is missing", async () => {
		const pi = createExtensionApiFake();
		const notifications: NotificationRecord[] = [];

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {},
				},
			}),
		});

		await runSessionStart(pi, notifications);

		expect(pi.tools).toHaveLength(0);
		expect(notifications).toEqual([]);
	});

	test("reports invalid config without registering tools", async () => {
		const pi = createExtensionApiFake();
		const notifications: NotificationRecord[] = [];

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "invalid",
				issue: "config must be an object",
			}),
		});

		await runSessionStart(pi, notifications);

		expect(pi.tools).toHaveLength(0);
		expect(notifications).toEqual([
			{ message: "[mcp-wrapper] config must be an object", type: "warning" },
		]);
	});

	test("discovers MCP tools, registers Pi tools, and routes execution", async () => {
		const pi = createExtensionApiFake();
		const callResults: unknown[] = [];
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [
							{
								name: "read",
								description: "Read a file",
								inputSchema: { type: "object", title: "Read arguments" },
							},
						],
					},
				],
				serverInstructions: [],
				failures: [],
			}),
			callTool: async (route, _config, args) => {
				callResults.push({ route, args });
				return { content: [{ type: "text", text: "ok" }] };
			},
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		const notifications: NotificationRecord[] = [];
		await runSessionStart(pi, notifications);
		const tool = pi.tools[0];
		expect(tool?.name).toBe(FILES_READ_TOOL_NAME);
		expect(tool?.description).toBe('Tool from MCP server "files": Read a file');
		expect(tool?.promptSnippet).toBe(
			'Tool from MCP server "files": Read a file',
		);
		const result = await tool?.execute(
			"call-1",
			{ path: "/tmp/a" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(callResults).toEqual([
			{
				route: { serverKey: "files", mcpToolName: "read" },
				args: { path: "/tmp/a" },
			},
		]);
		expect(result?.content).toEqual([{ type: "text", text: "ok" }]);
		expect(notifications).toEqual([
			{
				message:
					"[mcp-wrapper] MCP cache is empty. Discovering MCP tools before startup continues: files",
				type: "info",
			},
			{
				message: "[mcp-wrapper] MCPs: connected: files; tools: files_read",
				type: "info",
			},
		]);
	});

	test("registers tools from complete cache without waiting for discovery", async () => {
		await prepareSuiteCacheDir();
		const pi = createExtensionApiFake();
		const serverConfig: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: [],
			env: {},
		};
		await saveMcpWrapperCache({
			version: 1,
			servers: {
				files: {
					configHash: computeMcpServerConfigHash(serverConfig),
					cachedAt: Date.now(),
					tools: [
						{
							name: "read",
							description: "Read cached file",
							inputSchema: { type: "object" },
						},
					],
					instructions: "Use cached file instructions.",
				},
			},
		});
		const manager = {
			discoverServers: async () => new Promise<never>(() => {}),
			callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: { files: serverConfig },
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		expect(await resolvesWithin(runSessionStart(pi), 25)).toBe(true);
		expect(pi.tools[0]?.name).toBe(FILES_READ_TOOL_NAME);
		pi.setActiveTools([FILES_READ_TOOL_NAME]);
		expect(await runBeforeAgentStart(pi, "Base prompt")).toContain(
			"Use cached file instructions.",
		);
	});

	test("closes the active manager and clears instructions on session shutdown", async () => {
		// Purpose: Pi lifecycle cleanup must release live MCP clients and remove prompt-visible server instructions.
		// Input and expected output: startup registers one server with instructions, then shutdown calls closeAll once and the prompt returns to its base text.
		// Edge case: active tools may still contain old tool names after shutdown.
		// Dependencies: this test uses the mcp-wrapper entry point, an in-memory manager fake, and the ExtensionAPI fake.
		const pi = createExtensionApiFake();
		let closeAllCalls = 0;
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [
					{ serverKey: "files", instructions: "Use this server for files." },
				],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
			closeAll: async () => {
				closeAllCalls += 1;
			},
		};

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);
		pi.setActiveTools([FILES_READ_TOOL_NAME]);
		expect(await runBeforeAgentStart(pi, "Base prompt")).toContain(
			"Use this server for files.",
		);

		await runSessionShutdown(pi);

		expect(closeAllCalls).toBe(1);
		expect(await runBeforeAgentStart(pi, "Base prompt")).toBe("Base prompt");
	});

	test("closes startup manager and keeps instructions cleared when shutdown happens during discovery", async () => {
		// Purpose: shutdown during startup discovery must not leave a live manager or restore MCP instructions after shutdown.
		// Input and expected output: discovery completes after shutdown, closeAll runs once, and the prompt stays unchanged.
		// Edge case: shutdown can happen before session_start handler finishes.
		// Dependencies: this test uses the mcp-wrapper entry point, a deferred manager fake, and the ExtensionAPI fake.
		const pi = createExtensionApiFake();
		const discovery = deferred<{
			readonly serverToolLists: readonly {
				readonly serverKey: string;
				readonly tools: readonly {
					readonly name: string;
					readonly inputSchema: unknown;
				}[];
			}[];
			readonly serverInstructions: readonly {
				readonly serverKey: string;
				readonly instructions: string;
			}[];
			readonly failures: readonly [];
		}>();
		let closeAllCalls = 0;
		const manager = {
			discoverServers: async () => discovery.promise,
			callTool: async () => ({ content: [] }),
			closeAll: async () => {
				closeAllCalls += 1;
			},
		};

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		const startup = runSessionStart(pi);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await runSessionShutdown(pi);
		discovery.resolve({
			serverToolLists: [
				{
					serverKey: "files",
					tools: [{ name: "read", inputSchema: { type: "object" } }],
				},
			],
			serverInstructions: [
				{ serverKey: "files", instructions: "Use this server for files." },
			],
			failures: [],
		});
		await startup;
		pi.setActiveTools([FILES_READ_TOOL_NAME]);

		expect(closeAllCalls).toBe(1);
		expect(await runBeforeAgentStart(pi, "Base prompt")).toBe("Base prompt");
	});

	test("closes the background refresh manager after cached-server discovery", async () => {
		// Purpose: cache refresh must not leave a discovery-only MCP connection alive after metadata update.
		// Input and expected output: startup uses cached metadata, background refresh uses a separate manager and closes it after discovery.
		// Edge case: cached startup registers tools without waiting for live discovery.
		// Dependencies: this test uses the mcp-wrapper entry point, metadata cache, and manager fakes.
		await prepareSuiteCacheDir();
		const pi = createExtensionApiFake();
		const serverConfig: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: [],
			env: {},
		};
		await saveMcpWrapperCache({
			version: 1,
			servers: {
				files: {
					configHash: computeMcpServerConfigHash(serverConfig),
					cachedAt: Date.now(),
					tools: [{ name: "read", inputSchema: { type: "object" } }],
				},
			},
		});
		let refreshCloseCalls = 0;
		const startupManager = {
			discoverServers: async () => {
				throw new Error("startup manager must not refresh cached servers");
			},
			callTool: async () => ({ content: [] }),
		};
		const refreshManager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
			closeAll: async () => {
				refreshCloseCalls += 1;
			},
		};
		const managers = [startupManager, refreshManager];
		const nextManager = () => {
			const manager = managers.shift();
			if (manager === undefined) {
				throw new Error("expected a manager fake");
			}
			return managerWithCleanup(manager);
		};

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: { files: serverConfig },
				},
			}),
			createManager: nextManager,
		});

		await runSessionStart(pi);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(pi.tools[0]?.name).toBe(FILES_READ_TOOL_NAME);
		expect(refreshCloseCalls).toBe(1);
	});

	test("closes the background refresh manager after cached-server discovery failure", async () => {
		// Purpose: failed cache refresh must still release the temporary MCP connection manager.
		// Input and expected output: background discovery rejects and closeAll still runs once.
		// Edge case: cleanup must run through the failure path.
		// Dependencies: this test uses the mcp-wrapper entry point, metadata cache, and manager fakes.
		await prepareSuiteCacheDir();
		const pi = createExtensionApiFake();
		const notifications: NotificationRecord[] = [];
		const serverConfig: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: [],
			env: {},
		};
		await saveMcpWrapperCache({
			version: 1,
			servers: {
				files: {
					configHash: computeMcpServerConfigHash(serverConfig),
					cachedAt: Date.now(),
					tools: [{ name: "read", inputSchema: { type: "object" } }],
				},
			},
		});
		let refreshCloseCalls = 0;
		const startupManager = {
			discoverServers: async () => ({
				serverToolLists: [],
				serverInstructions: [],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		};
		const refreshManager = {
			discoverServers: async () => {
				throw new Error("refresh failed");
			},
			callTool: async () => ({ content: [] }),
			closeAll: async () => {
				refreshCloseCalls += 1;
			},
		};
		const managers = [startupManager, refreshManager];
		const nextManager = () => {
			const manager = managers.shift();
			if (manager === undefined) {
				throw new Error("expected a manager fake");
			}
			return managerWithCleanup(manager);
		};

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: { files: serverConfig },
				},
			}),
			createManager: nextManager,
		});

		await runSessionStart(pi, notifications);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(refreshCloseCalls).toBe(1);
		expect(notifications).toContainEqual({
			message:
				"[mcp-wrapper] failed to refresh MCP metadata cache: refresh failed",
			type: "warning",
		});
	});

	test("waits for servers missing from partial cache and notifies the user", async () => {
		await prepareSuiteCacheDir();
		const pi = createExtensionApiFake();
		const cachedConfig: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: ["cached.js"],
			env: {},
		};
		const missingConfig: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: ["missing.js"],
			env: {},
		};
		await saveMcpWrapperCache({
			version: 1,
			servers: {
				cached: {
					configHash: computeMcpServerConfigHash(cachedConfig),
					cachedAt: Date.now(),
					tools: [{ name: "read", inputSchema: { type: "object" } }],
				},
			},
		});
		const backgroundRefreshSaved = deferred<void>();
		const discoveredServerMaps: Readonly<Record<string, McpServerConfig>>[] =
			[];
		let saveCount = 0;
		const manager = {
			discoverServers: async (servers) => {
				discoveredServerMaps.push(servers);
				if (servers["cached"] !== undefined) {
					return {
						serverToolLists: [
							{
								serverKey: "cached",
								tools: [{ name: "read", inputSchema: { type: "object" } }],
							},
						],
						serverInstructions: [],
						failures: [],
					};
				}
				return {
					serverToolLists: [
						{
							serverKey: "missing",
							tools: [{ name: "search", inputSchema: { type: "object" } }],
						},
					],
					serverInstructions: [
						{ serverKey: "missing", instructions: "Use missing server." },
					],
					failures: [],
				};
			},
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;
		const notifications: NotificationRecord[] = [];

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: { cached: cachedConfig, missing: missingConfig },
				},
			}),
			createManager: () => managerWithCleanup(manager),
			saveCache: async (cache) => {
				saveCount += 1;
				await saveMcpWrapperCache(cache);
				if (saveCount === 2) {
					backgroundRefreshSaved.resolve();
				}
			},
		});

		await runSessionStart(pi, notifications);

		expect(discoveredServerMaps[0]).toEqual({ missing: missingConfig });
		expect(pi.tools.map((tool) => tool.name)).toEqual([
			"cached_read",
			"missing_search",
		]);
		expect(notifications).toContainEqual({
			message:
				"[mcp-wrapper] MCP cache is missing for 1 server. Discovering MCP tools before startup continues: missing",
			type: "info",
		});
		expect(discoveredServerMaps[1]).toEqual({ cached: cachedConfig });
		expect(await resolvesWithin(backgroundRefreshSaved.promise, 25)).toBe(true);
		const cache = await loadMcpWrapperCache();
		expect(Object.keys(cache?.servers ?? {}).sort()).toEqual([
			"cached",
			"missing",
		]);
	});

	test("uses fallback prompt snippet when MCP tool has no description", async () => {
		const pi = createExtensionApiFake();
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);

		expect(pi.tools[0]?.description).toBe('Tool from MCP server "files".');
		expect(pi.tools[0]?.promptSnippet).toBe('Tool from MCP server "files".');
	});

	test("truncates long prompt snippets at a word boundary", async () => {
		const pi = createExtensionApiFake();
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [
							{
								name: "read",
								description: "alpha ".repeat(20),
								inputSchema: { type: "object" },
							},
						],
					},
				],
				serverInstructions: [],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);

		expect(pi.tools[0]?.description).toBe(
			`Tool from MCP server "files": ${"alpha ".repeat(20).trim()}`,
		);
		expect(pi.tools[0]?.promptSnippet).toBe(
			'Tool from MCP server "files": alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha...',
		);
	});

	test("appends MCP initialize instructions only for servers with active Pi tools", async () => {
		const pi = createExtensionApiFake();
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "docs&server",
						tools: [{ name: "search", inputSchema: { type: "object" } }],
					},
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
					{
						serverKey: "empty",
						tools: [{ name: "!!!", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [
					{
						serverKey: "docs&server",
						instructions: "Use this server. Do not call <private>.",
					},
					{
						serverKey: "files",
						instructions: "Use this server for files.",
					},
					{
						serverKey: "empty",
						instructions: "This server has no registered tools.",
					},
				],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						"docs&server": {
							type: "stdio",
							command: "node",
							args: [],
							env: {},
						},
						files: { type: "stdio", command: "node", args: [], env: {} },
						empty: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);
		pi.setActiveTools(["docs_server_search"]);

		expect(await runBeforeAgentStart(pi, "Base prompt")).toBe(`Base prompt

<mcp_instructions>
  <server name="docs&amp;server">
Use this server. Do not call &lt;private>.
  </server>
</mcp_instructions>`);
	});

	test("omits MCP initialize instructions when no registered MCP tool is active", async () => {
		// Purpose: MCP instructions must not expose server guidance when the active agent cannot call that server.
		// Input and expected output: a server registers one Pi tool and one instruction, but active tools are empty, so the prompt stays unchanged.
		// Edge case: registration alone is not enough to expose instructions.
		// Dependencies: this test uses only the mcp-wrapper entry point, an in-memory manager fake, and the ExtensionAPI fake.
		const pi = createExtensionApiFake();
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [
					{ serverKey: "files", instructions: "Use this server for files." },
				],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						files: { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);

		expect(await runBeforeAgentStart(pi, "Base prompt")).toBe("Base prompt");
	});

	test("clears MCP initialize instructions when a later startup registers no tools", async () => {
		const pi = createExtensionApiFake();
		let enabled = true;
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [
					{ serverKey: "files", instructions: "Use this server for files." },
				],
				failures: [],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: enabled
						? {
								files: {
									type: "stdio",
									command: "node",
									args: [],
									env: {},
								},
							}
						: {},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi);
		pi.setActiveTools([FILES_READ_TOOL_NAME]);
		expect(await runBeforeAgentStart(pi, "Base prompt")).toContain(
			"<mcp_instructions>",
		);

		enabled = false;
		await runSessionStart(pi);

		expect(await runBeforeAgentStart(pi, "Base prompt")).toBe("Base prompt");
	});

	test("reports discovery failures and catalog rejections at startup", async () => {
		const pi = createExtensionApiFake();
		const notifications: NotificationRecord[] = [];
		const statuses: Array<{ readonly key: string; readonly text: string }> = [];
		const manager = {
			discoverServers: async () => ({
				serverToolLists: [
					{
						serverKey: "123-files",
						tools: [{ name: "read", inputSchema: { type: "object" } }],
					},
				],
				serverInstructions: [],
				failures: [{ serverKey: "bad/server", issue: "connection failed" }],
			}),
			callTool: async () => ({ content: [] }),
		} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: true,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {
						"123-files": { type: "stdio", command: "node", args: [], env: {} },
						"bad/server": { type: "stdio", command: "node", args: [], env: {} },
					},
				},
			}),
			createManager: () => managerWithCleanup(manager),
		});

		await runSessionStart(pi, notifications, statuses);

		expect(pi.tools).toHaveLength(0);
		expect(statuses).toEqual([
			{ key: "mcp-bad-server", text: "bad/server: connection failed" },
			{
				key: "mcp-123-files",
				text: "123-files: server key slug must start with an ASCII letter or underscore",
			},
		]);
		expect(notifications).toEqual([
			{
				message:
					"[mcp-wrapper] MCP cache is empty. Discovering MCP tools before startup continues: 123-files, bad/server",
				type: "info",
			},
			{
				message:
					"[mcp-wrapper] MCPs: connected: 123-files; failed: bad/server (connection failed); rejected: 123-files (server key slug must start with an ASCII letter or underscore)",
				type: "warning",
			},
		]);
	});

	test("registers no tools when config disables the extension", async () => {
		const pi = createExtensionApiFake();

		mcpWrapper(pi, {
			readConfig: async () => ({
				kind: "valid",
				config: {
					enabled: false,
					timeouts: {
						startupSeconds: 30,
						listToolsSeconds: 15,
						callSeconds: 120,
						maxTotalSeconds: 180,
					},
					mcpServers: {},
				},
			}),
		});

		await runSessionStart(pi);

		expect(pi.tools).toHaveLength(0);
	});
});
