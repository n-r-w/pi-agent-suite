import { describe, expect, test } from "bun:test";
import { type McpClientLike, McpClientManager } from "./client-manager.ts";
import type { McpServerConfig, McpWrapperTimeouts } from "./config.ts";

const DEFAULT_TIMEOUTS: McpWrapperTimeouts = {
	startupSeconds: 30,
	listToolsSeconds: 15,
	callSeconds: 120,
	maxTotalSeconds: 180,
};

const STDIO_SERVER: McpServerConfig = {
	type: "stdio",
	command: "node",
	args: [],
	env: {},
};

class FakeMcpClient implements McpClientLike {
	readonly closeCalls: string[] = [];
	connectCalls = 0;
	listToolsCalls: Array<{
		readonly cursor: string | undefined;
		readonly timeout: number | undefined;
		readonly maxTotalTimeout: number | undefined;
	}> = [];
	callToolCalls: Array<{
		readonly name: string;
		readonly arguments: Record<string, unknown>;
		readonly timeout: number | undefined;
		readonly maxTotalTimeout: number | undefined;
	}> = [];
	listPages: Array<{
		readonly tools: Array<{
			readonly name: string;
			readonly inputSchema: unknown;
		}>;
		readonly nextCursor?: string;
	}> = [];
	callResult: unknown = { content: [{ type: "text", text: "ok" }] };
	instructions: string | undefined;

	async connect(_options?: {
		readonly signal?: AbortSignal;
		readonly timeout?: number;
	}): Promise<void> {
		this.connectCalls += 1;
	}

	async listTools(
		params: { readonly cursor?: string } | undefined,
		options: {
			readonly signal?: AbortSignal;
			readonly timeout?: number;
			readonly maxTotalTimeout?: number;
		},
	): Promise<{
		readonly tools: Array<{
			readonly name: string;
			readonly inputSchema: unknown;
		}>;
		readonly nextCursor?: string;
	}> {
		this.listToolsCalls.push({
			cursor: params?.cursor,
			timeout: options.timeout,
			maxTotalTimeout: options.maxTotalTimeout,
		});
		const page = this.listPages.shift();
		if (page === undefined) {
			return { tools: [] };
		}
		return page;
	}

	async callTool(
		params: {
			readonly name: string;
			readonly arguments: Record<string, unknown>;
		},
		options: {
			readonly signal?: AbortSignal;
			readonly timeout?: number;
			readonly maxTotalTimeout?: number;
		},
	): Promise<unknown> {
		this.callToolCalls.push({
			name: params.name,
			arguments: params.arguments,
			timeout: options.timeout,
			maxTotalTimeout: options.maxTotalTimeout,
		});
		return this.callResult;
	}

	getInstructions(): string | undefined {
		return this.instructions;
	}

	async close(): Promise<void> {
		this.closeCalls.push("close");
	}
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

describe("mcp-wrapper client manager", () => {
	test("discovers paginated tools and applies startup/list timeouts", async () => {
		const client = new FakeMcpClient();
		client.listPages = [
			{
				tools: [{ name: "read", inputSchema: { type: "object" } }],
				nextCursor: "next",
			},
			{ tools: [{ name: "write", inputSchema: { type: "object" } }] },
		];
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: DEFAULT_TIMEOUTS,
		});

		const result = await manager.discoverServers({ files: STDIO_SERVER });

		expect(result.failures).toEqual([]);
		expect(result.serverToolLists).toEqual([
			{
				serverKey: "files",
				tools: [
					{ name: "read", inputSchema: { type: "object" } },
					{ name: "write", inputSchema: { type: "object" } },
				],
			},
		]);
		expect(client.connectCalls).toBe(1);
		expect(client.listToolsCalls).toEqual([
			{ cursor: undefined, timeout: 15_000, maxTotalTimeout: 180_000 },
			{ cursor: "next", timeout: 15_000, maxTotalTimeout: 180_000 },
		]);
	});

	test("returns initialize instructions discovered from connected servers", async () => {
		const client = new FakeMcpClient();
		client.instructions = "Use this server for file access.";
		client.listPages = [
			{ tools: [{ name: "read", inputSchema: { type: "object" } }] },
		];
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: DEFAULT_TIMEOUTS,
		});

		const result = await manager.discoverServers({ files: STDIO_SERVER });

		expect(result).toMatchObject({
			serverInstructions: [
				{
					serverKey: "files",
					instructions: "Use this server for file access.",
				},
			],
		});
	});

	test("continues discovery for healthy servers when another server fails", async () => {
		const healthy = new FakeMcpClient();
		healthy.listPages = [
			{ tools: [{ name: "search", inputSchema: { type: "object" } }] },
		];
		const failing = new FakeMcpClient();
		failing.connect = async () => {
			throw new Error("connection failed");
		};
		const clients = new Map([
			["docs", healthy],
			["bad", failing],
		]);
		const manager = new McpClientManager({
			createClient: (serverKey) =>
				clients.get(serverKey) ?? new FakeMcpClient(),
			timeouts: DEFAULT_TIMEOUTS,
		});

		const result = await manager.discoverServers({
			docs: STDIO_SERVER,
			bad: STDIO_SERVER,
		});

		expect(result.serverToolLists).toEqual([
			{
				serverKey: "docs",
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			},
		]);
		expect(result.failures).toEqual([
			{ serverKey: "bad", issue: "connection failed" },
		]);
		expect(failing.closeCalls).toEqual(["close"]);
	});

	test("closes and removes the affected connection after list timeout", async () => {
		const client = new FakeMcpClient();
		client.listTools = async (_params, options) =>
			new Promise((_, reject) => {
				options.signal?.addEventListener("abort", () => {
					reject(new Error("operation timed out"));
				});
			});
		let createCalls = 0;
		let currentClient = client;
		const manager = new McpClientManager({
			createClient: () => {
				createCalls += 1;
				return currentClient;
			},
			timeouts: { ...DEFAULT_TIMEOUTS, listToolsSeconds: 0.001 },
		});

		const first = await manager.discoverServers({ files: STDIO_SERVER });
		const secondClient = new FakeMcpClient();
		secondClient.listPages = [{ tools: [] }];
		currentClient = secondClient;
		const second = await manager.discoverServers({ files: STDIO_SERVER });

		expect(first.failures).toEqual([
			{ serverKey: "files", issue: "operation timed out" },
		]);
		expect(client.closeCalls).toEqual(["close"]);
		expect(second.failures).toEqual([]);
		expect(second.serverToolLists).toEqual([{ serverKey: "files", tools: [] }]);
		expect(createCalls).toBe(2);
	});

	test("deduplicates concurrent connection attempts for the same server", async () => {
		const client = new FakeMcpClient();
		client.listPages = [{ tools: [] }];
		let createCalls = 0;
		const manager = new McpClientManager({
			createClient: () => {
				createCalls += 1;
				return client;
			},
			timeouts: DEFAULT_TIMEOUTS,
		});

		await Promise.all([
			manager.getConnection("files", STDIO_SERVER),
			manager.getConnection("files", STDIO_SERVER),
		]);

		expect(createCalls).toBe(1);
		expect(client.connectCalls).toBe(1);
	});

	test("closes all active connections and allows repeated cleanup", async () => {
		// Purpose: session cleanup must release every live MCP client and stay safe when called more than once.
		// Input and expected output: two connected servers are closed once each, and a second cleanup call does not close them again.
		// Edge case: repeated lifecycle cleanup must be idempotent.
		// Dependencies: this test uses only McpClientManager and fake MCP clients.
		const filesClient = new FakeMcpClient();
		const docsClient = new FakeMcpClient();
		const clients = new Map([
			["files", filesClient],
			["docs", docsClient],
		]);
		const manager = new McpClientManager({
			createClient: (serverKey) =>
				clients.get(serverKey) ?? new FakeMcpClient(),
			timeouts: DEFAULT_TIMEOUTS,
		});

		await Promise.all([
			manager.getConnection("files", STDIO_SERVER),
			manager.getConnection("docs", STDIO_SERVER),
		]);
		await manager.closeAll();
		await manager.closeAll();

		expect(filesClient.closeCalls).toEqual(["close"]);
		expect(docsClient.closeCalls).toEqual(["close"]);
	});

	test("closes a pending connection during cleanup and rejects later use", async () => {
		// Purpose: lifecycle cleanup must reach a client whose startup connect call has not finished yet.
		// Input and expected output: one pending connection is closed during cleanup, then the pending getConnection call rejects after connect resolves.
		// Edge case: connection creation can complete after cleanup starts.
		// Dependencies: this test uses only McpClientManager, a deferred fake client, and no real process.
		const connected = deferred<void>();
		const client = new FakeMcpClient();
		client.connect = async () => connected.promise;
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: DEFAULT_TIMEOUTS,
		});

		const connectionPromise = manager.getConnection("files", STDIO_SERVER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await manager.closeAll();
		connected.resolve();

		await expect(connectionPromise).rejects.toThrow(
			"MCP client manager is closed",
		);
		expect(client.closeCalls).toEqual(["close", "close"]);
		await expect(manager.getConnection("files", STDIO_SERVER)).rejects.toThrow(
			"MCP client manager is closed",
		);
	});

	test("calls the routed MCP tool with call and total timeouts", async () => {
		const client = new FakeMcpClient();
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: DEFAULT_TIMEOUTS,
		});

		const result = await manager.callTool(
			{ serverKey: "files", mcpToolName: "read" },
			STDIO_SERVER,
			{ path: "/tmp/a" },
		);

		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(client.callToolCalls).toEqual([
			{
				name: "read",
				arguments: { path: "/tmp/a" },
				timeout: 120_000,
				maxTotalTimeout: 180_000,
			},
		]);
	});

	test("closes the affected connection after SDK timeout rejection", async () => {
		const client = new FakeMcpClient();
		client.callTool = async () => {
			throw new Error("Request timed out");
		};
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: DEFAULT_TIMEOUTS,
		});

		await expect(
			manager.callTool(
				{ serverKey: "files", mcpToolName: "read" },
				STDIO_SERVER,
				{},
			),
		).rejects.toThrow("Request timed out");
		expect(client.closeCalls).toEqual(["close"]);
	});

	test("closes the affected connection after call timeout", async () => {
		const client = new FakeMcpClient();
		client.callTool = async (_params, options) =>
			new Promise((_, reject) => {
				options.signal?.addEventListener("abort", () => {
					reject(new Error("operation timed out"));
				});
			});
		const manager = new McpClientManager({
			createClient: () => client,
			timeouts: { ...DEFAULT_TIMEOUTS, callSeconds: 0.001 },
		});

		await expect(
			manager.callTool(
				{ serverKey: "files", mcpToolName: "read" },
				STDIO_SERVER,
				{},
			),
		).rejects.toThrow("operation timed out");
		expect(client.closeCalls).toEqual(["close"]);
	});
});
