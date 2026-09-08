import { describe, expect, test } from "bun:test";
import type { McpRequestOptions } from "./client-manager.ts";
import type { McpServerConfig } from "./config.ts";
import { createSdkMcpClient } from "./sdk-client-factory.ts";

const UNIX_ENV_PLACEHOLDER = "$" + "{TOKEN}";
const POWERSHELL_ENV_PLACEHOLDER = "$env:TOKEN";

class FakeSdkClient {
	readonly clientInfo: unknown;
	readonly options: unknown;
	readonly connectedTransports: unknown[] = [];
	connectOptions: McpRequestOptions | undefined;
	listRequest:
		| { params: unknown; options: McpRequestOptions | undefined }
		| undefined;
	closeCalls = 0;
	readonly calls: {
		params: unknown;
		options: McpRequestOptions | undefined;
	}[] = [];

	constructor(clientInfo: unknown, options?: unknown) {
		this.clientInfo = clientInfo;
		this.options = options;
	}

	async connect(
		transport: unknown,
		options?: McpRequestOptions,
	): Promise<void> {
		this.connectedTransports.push(transport);
		this.connectOptions = options;
	}

	async listTools(
		params?: { readonly cursor?: string },
		options?: McpRequestOptions,
	): Promise<{ readonly tools: [] }> {
		this.listRequest = { params, options };
		return { tools: [] };
	}

	async callTool(
		params: unknown,
		options?: McpRequestOptions,
	): Promise<unknown> {
		this.calls.push({ params, options });
		return { content: [] };
	}

	getInstructions(): string {
		return "Use this server for documentation lookup.";
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

class FakeStdioTransport {
	readonly params: unknown;
	closeCalls = 0;

	constructor(params: unknown) {
		this.params = params;
	}

	async start(): Promise<void> {}
	async send(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

class FakeHttpTransport {
	readonly url: URL;
	readonly options: unknown;
	closeCalls = 0;

	constructor(url: URL, options?: unknown) {
		this.url = url;
		this.options = options;
	}

	async start(): Promise<void> {}
	async send(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

describe("mcp-wrapper SDK client factory", () => {
	// Purpose: preserve request parameters at the SDK boundary for both transports.
	// Inputs: cursor, tool arguments, signal, timeout, and total timeout; expect exact forwarding.
	// Edge: v2 receives call options in the second argument. Dependencies: constructor fakes only.
	test.each<McpServerConfig>([
		{ type: "stdio", command: "fixture", args: [], env: {} },
		{ type: "streamableHttp", url: "https://example.com/mcp", headers: {} },
	])("forwards call arguments and request options with $type", async (config) => {
		const client = createSdkMcpClient("echo", config, {
			client: FakeSdkClient,
			stdioClientTransport: FakeStdioTransport,
			streamableHttpClientTransport: FakeHttpTransport,
		});
		const params = { name: "echo", arguments: { text: "hello" } };
		const options = {
			signal: new AbortController().signal,
			timeout: 1234,
			maxTotalTimeout: 5678,
		};
		await client.connect(options);
		try {
			const sdkClient = client.sdkClient as FakeSdkClient;
			expect(sdkClient.connectOptions).toBe(options);
			expect(await client.listTools({ cursor: "next" }, options)).toEqual({
				tools: [],
			});
			expect(sdkClient.listRequest).toEqual({
				params: { cursor: "next" },
				options,
			});
			expect(await client.callTool(params, options)).toEqual({ content: [] });
			expect((client.sdkClient as FakeSdkClient).calls).toEqual([
				{ params, options },
			]);
		} finally {
			await client.close();
		}
	});
	test("creates stdio transport without command rewriting and with merged literal env", async () => {
		const previousEnv = process.env["MCP_WRAPPER_TEST_TOKEN"];
		process.env["MCP_WRAPPER_TEST_TOKEN"] = "inherited";
		try {
			const config: McpServerConfig = {
				type: "stdio",
				command: "npx",
				args: ["-y", "server"],
				env: {
					MCP_WRAPPER_TEST_TOKEN: "configured",
					LITERAL: UNIX_ENV_PLACEHOLDER,
				},
				cwd: "/tmp",
			};

			const client = createSdkMcpClient("files", config, {
				client: FakeSdkClient,
				stdioClientTransport: FakeStdioTransport,
				streamableHttpClientTransport: FakeHttpTransport,
			});
			await client.connect();

			const transport = (client.sdkClient as FakeSdkClient)
				.connectedTransports[0] as FakeStdioTransport;
			expect(transport.params).toMatchObject({
				command: "npx",
				args: ["-y", "server"],
				cwd: "/tmp",
				env: {
					MCP_WRAPPER_TEST_TOKEN: "configured",
					LITERAL: UNIX_ENV_PLACEHOLDER,
				},
			});
		} finally {
			if (previousEnv === undefined) {
				delete process.env["MCP_WRAPPER_TEST_TOKEN"];
			} else {
				process.env["MCP_WRAPPER_TEST_TOKEN"] = previousEnv;
			}
		}
	});

	test("creates streamable HTTP transport with literal headers", async () => {
		const config: McpServerConfig = {
			type: "streamableHttp",
			url: "https://example.com/mcp",
			headers: { Authorization: POWERSHELL_ENV_PLACEHOLDER },
		};

		const client = createSdkMcpClient("docs", config, {
			client: FakeSdkClient,
			stdioClientTransport: FakeStdioTransport,
			streamableHttpClientTransport: FakeHttpTransport,
		});
		await client.connect();

		const transport = (client.sdkClient as FakeSdkClient)
			.connectedTransports[0] as FakeHttpTransport;
		expect(transport.url.href).toBe("https://example.com/mcp");
		expect(transport.options).toEqual({
			requestInit: { headers: { Authorization: POWERSHELL_ENV_PLACEHOLDER } },
		});
	});

	test("exposes MCP initialize instructions from the SDK client", () => {
		const config: McpServerConfig = {
			type: "streamableHttp",
			url: "https://example.com/mcp",
			headers: {},
		};
		const client = createSdkMcpClient("docs", config, {
			client: FakeSdkClient,
			stdioClientTransport: FakeStdioTransport,
			streamableHttpClientTransport: FakeHttpTransport,
		});

		expect(
			(
				client as {
					readonly getInstructions?: () => string | undefined;
				}
			).getInstructions?.(),
		).toBe("Use this server for documentation lookup.");
	});

	test("closes SDK client and transport", async () => {
		const config: McpServerConfig = {
			type: "streamableHttp",
			url: "https://example.com/mcp",
			headers: {},
		};
		const client = createSdkMcpClient("docs", config, {
			client: FakeSdkClient,
			stdioClientTransport: FakeStdioTransport,
			streamableHttpClientTransport: FakeHttpTransport,
		});

		await client.connect();
		const sdkClient = client.sdkClient as FakeSdkClient;
		const transport = sdkClient.connectedTransports[0] as FakeHttpTransport;
		await client.close();

		expect(sdkClient.closeCalls).toBe(1);
		expect(transport.closeCalls).toBe(1);
	});
});
