import { env } from "node:process";
import {
	Client,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpClientLike, McpRequestOptions } from "./client-manager.ts";
import type { McpServerConfig } from "./config.ts";
import { McpStdioLogWriter } from "./stdio-log.ts";

const CLIENT_VERSION = "1.0.0";

interface SdkClientInstance {
	connect(transport: Transport, options?: McpRequestOptions): Promise<void>;
	listTools(
		params?: { readonly cursor?: string },
		options?: McpRequestOptions,
	): Promise<{
		readonly tools: Array<{
			readonly name: string;
			readonly description?: string | undefined;
			readonly inputSchema: unknown;
		}>;
		readonly nextCursor?: string | undefined;
	}>;
	callTool(
		params: {
			readonly name: string;
			readonly arguments: Record<string, unknown>;
		},
		options?: McpRequestOptions,
	): Promise<unknown>;
	getInstructions(): string | undefined;
	getServerVersion(): { readonly name: string } | undefined;
	close(): Promise<void>;
}

type SdkClientConstructor = new (
	clientInfo: { readonly name: string; readonly version: string },
	options?: ConstructorParameters<typeof Client>[1],
) => SdkClientInstance;

interface StdioDiagnosticStream {
	on(event: "data", listener: (chunk: unknown) => void): unknown;
}

type StdioTransportConstructor = new (params: {
	readonly command: string;
	readonly args?: string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly stderr?: "pipe";
}) => Transport & { readonly stderr?: StdioDiagnosticStream | null };

type HttpTransportConstructor = new (
	url: URL,
	options?: {
		readonly requestInit?: {
			readonly headers?: Readonly<Record<string, string>>;
		};
	},
) => Transport;

export interface SdkMcpClientConstructors {
	readonly client?: SdkClientConstructor;
	readonly stdioClientTransport?: StdioTransportConstructor;
	readonly streamableHttpClientTransport?: HttpTransportConstructor;
}

export interface SdkMcpClient extends McpClientLike {
	readonly sdkClient: unknown;
}

/** Creates an MCP client backed by the official SDK transports. */
export function createSdkMcpClient(
	serverKey: string,
	config: McpServerConfig,
	constructors: SdkMcpClientConstructors = {},
): SdkMcpClient {
	const ClientCtor = constructors.client ?? Client;
	const client = new ClientCtor({
		name: `pi-mcp-wrapper-${serverKey}`,
		version: CLIENT_VERSION,
	});

	return new SdkMcpClientAdapter(serverKey, client, config, constructors);
}

class SdkMcpClientAdapter implements SdkMcpClient {
	readonly sdkClient: unknown;
	private readonly serverKey: string;
	private readonly client: SdkClientInstance;
	private readonly config: McpServerConfig;
	private readonly constructors: SdkMcpClientConstructors;
	private transport: Transport | undefined;
	private stdioLogWriter: McpStdioLogWriter | undefined;

	constructor(
		serverKey: string,
		client: SdkClientInstance,
		config: McpServerConfig,
		constructors: SdkMcpClientConstructors,
	) {
		this.serverKey = serverKey;
		this.client = client;
		this.sdkClient = client;
		this.config = config;
		this.constructors = constructors;
	}

	async connect(options?: McpRequestOptions): Promise<void> {
		this.transport = this.createTransport();
		await this.client.connect(this.transport, options);
		this.stdioLogWriter?.setServerName(
			this.client.getServerVersion()?.name ?? "unnamed",
		);
	}

	async listTools(
		params?: { readonly cursor?: string },
		options?: McpRequestOptions,
	): ReturnType<McpClientLike["listTools"]> {
		return this.client.listTools(params, options);
	}

	async callTool(
		params: {
			readonly name: string;
			readonly arguments: Record<string, unknown>;
		},
		options?: McpRequestOptions,
	): Promise<unknown> {
		return this.client.callTool(params, options);
	}

	getInstructions(): string | undefined {
		return this.client.getInstructions();
	}

	async close(): Promise<void> {
		await this.client.close().catch(() => {});
		await this.transport?.close().catch(() => {});
		await this.stdioLogWriter?.flush();
	}

	private createTransport(): Transport {
		if (this.config.type === "stdio") {
			const TransportCtor =
				this.constructors.stdioClientTransport ?? StdioClientTransport;
			const transport = new TransportCtor({
				command: this.config.command,
				args: [...this.config.args],
				env: mergeProcessEnv(this.config.env),
				...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
				stderr: "pipe",
			});
			const stderr = transport.stderr;
			if (stderr !== undefined && stderr !== null) {
				const writer = new McpStdioLogWriter(this.serverKey);
				this.stdioLogWriter = writer;
				stderr.on("data", (chunk) => writer.write(chunk));
			}
			return transport;
		}

		const TransportCtor =
			this.constructors.streamableHttpClientTransport ??
			StreamableHTTPClientTransport;
		return new TransportCtor(new URL(this.config.url), {
			requestInit: { headers: this.config.headers },
		});
	}
}

function mergeProcessEnv(
	configuredEnv: Readonly<Record<string, string>>,
): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") {
			inherited[key] = value;
		}
	}

	return { ...inherited, ...configuredEnv };
}
