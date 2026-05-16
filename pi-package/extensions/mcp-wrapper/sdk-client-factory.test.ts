import { describe, expect, test } from "bun:test";
import type { McpServerConfig } from "./config.ts";
import { createSdkMcpClient } from "./sdk-client-factory.ts";

const UNIX_ENV_PLACEHOLDER = "$" + "{TOKEN}";
const POWERSHELL_ENV_PLACEHOLDER = "$env:TOKEN";

class FakeSdkClient {
	readonly clientInfo: unknown;
	readonly options: unknown;
	readonly connectedTransports: unknown[] = [];
	closeCalls = 0;

	constructor(clientInfo: unknown, options?: unknown) {
		this.clientInfo = clientInfo;
		this.options = options;
	}

	async connect(transport: unknown): Promise<void> {
		this.connectedTransports.push(transport);
	}

	async listTools(): Promise<{ readonly tools: [] }> {
		return { tools: [] };
	}

	async callTool(): Promise<unknown> {
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

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

describe("mcp-wrapper SDK client factory", () => {
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
