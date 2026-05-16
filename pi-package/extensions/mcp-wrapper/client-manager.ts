import type { McpServerConfig, McpWrapperTimeouts } from "./config.ts";
import type {
	McpServerToolList,
	McpToolSummary,
	PiToolRoute,
} from "./tool-catalog.ts";

const MILLISECONDS_PER_SECOND = 1_000;
const TIMEOUT_ERROR_PATTERN = /time(?:d)? out|timeout/i;

export interface McpRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly maxTotalTimeout?: number;
}

export interface McpClientLike {
	connect(options?: McpRequestOptions): Promise<void>;
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
	close(): Promise<void>;
}

interface McpClientManagerOptions {
	readonly createClient: (
		serverKey: string,
		config: McpServerConfig,
	) => McpClientLike;
	readonly timeouts: McpWrapperTimeouts;
}

interface McpConnection {
	readonly client: McpClientLike;
	readonly config: McpServerConfig;
}

interface ServerFailure {
	readonly serverKey: string;
	readonly issue: string;
}

export interface ServerInstructions {
	readonly serverKey: string;
	readonly instructions: string;
}

type ServerDiscoveryResult =
	| {
			readonly kind: "valid";
			readonly serverToolList: McpServerToolList;
			readonly serverInstructions?: ServerInstructions;
	  }
	| { readonly kind: "failure"; readonly failure: ServerFailure };

/** Manages MCP clients, tool discovery, routing, and timeout cleanup. */
export class McpClientManager {
	private readonly connections = new Map<string, McpConnection>();
	private readonly connectPromises = new Map<string, Promise<McpConnection>>();
	private readonly createClient: McpClientManagerOptions["createClient"];
	private readonly timeouts: McpWrapperTimeouts;

	constructor(options: McpClientManagerOptions) {
		this.createClient = options.createClient;
		this.timeouts = options.timeouts;
	}

	async discoverServers(
		servers: Readonly<Record<string, McpServerConfig>>,
	): Promise<{
		readonly serverToolLists: readonly McpServerToolList[];
		readonly serverInstructions: readonly ServerInstructions[];
		readonly failures: readonly ServerFailure[];
	}> {
		const results = await Promise.all(
			Object.entries(servers).map(([serverKey, config]) =>
				this.discoverServer(serverKey, config),
			),
		);

		return {
			serverToolLists: results.flatMap((result) =>
				result.kind === "valid" ? [result.serverToolList] : [],
			),
			serverInstructions: results.flatMap((result) =>
				result.kind === "valid" && result.serverInstructions !== undefined
					? [result.serverInstructions]
					: [],
			),
			failures: results.flatMap((result) =>
				result.kind === "failure" ? [result.failure] : [],
			),
		};
	}

	async getConnection(
		serverKey: string,
		config: McpServerConfig,
	): Promise<McpClientLike> {
		return (await this.getOrCreateConnection(serverKey, config)).client;
	}

	async callTool(
		route: PiToolRoute,
		config: McpServerConfig,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const connection = await this.getOrCreateConnection(
			route.serverKey,
			config,
		);
		try {
			return await withAbortTimeout(
				this.timeouts.callSeconds,
				(signal) =>
					connection.client.callTool(
						{ name: route.mcpToolName, arguments: args },
						{
							signal,
							timeout: secondsToMilliseconds(this.timeouts.callSeconds),
							maxTotalTimeout: secondsToMilliseconds(
								this.timeouts.maxTotalSeconds,
							),
						},
					),
				async () => {
					await this.closeConnection(route.serverKey, connection);
				},
			);
		} catch (error) {
			if (isAbortError(error) || isTimeoutError(error)) {
				await this.closeConnection(route.serverKey, connection);
			}
			throw error;
		}
	}

	private async discoverServer(
		serverKey: string,
		config: McpServerConfig,
	): Promise<ServerDiscoveryResult> {
		try {
			const connection = await this.getOrCreateConnection(serverKey, config);
			const instructions = connection.client.getInstructions();
			return {
				kind: "valid",
				serverToolList: {
					serverKey,
					tools: await this.fetchAllTools(connection.client),
				},
				...(instructions !== undefined && instructions.trim().length > 0
					? { serverInstructions: { serverKey, instructions } }
					: {}),
			};
		} catch (error) {
			await this.closeStoredConnection(serverKey);
			return {
				kind: "failure",
				failure: { serverKey, issue: formatError(error) },
			};
		}
	}

	private async getOrCreateConnection(
		serverKey: string,
		config: McpServerConfig,
	): Promise<McpConnection> {
		const existing = this.connections.get(serverKey);
		if (existing !== undefined) {
			return existing;
		}

		const pending = this.connectPromises.get(serverKey);
		if (pending !== undefined) {
			return pending;
		}

		const promise = this.createConnection(serverKey, config);
		this.connectPromises.set(serverKey, promise);
		try {
			const connection = await promise;
			this.connections.set(serverKey, connection);
			return connection;
		} finally {
			this.connectPromises.delete(serverKey);
		}
	}

	private async createConnection(
		serverKey: string,
		config: McpServerConfig,
	): Promise<McpConnection> {
		const client = this.createClient(serverKey, config);
		try {
			await withAbortTimeout(
				this.timeouts.startupSeconds,
				(signal) =>
					client.connect({
						signal,
						timeout: secondsToMilliseconds(this.timeouts.startupSeconds),
					}),
				async () => {
					await client.close();
				},
			);
			return { client, config };
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	}

	private async fetchAllTools(
		client: McpClientLike,
	): Promise<readonly McpToolSummary[]> {
		return this.fetchToolPage(client, undefined, []);
	}

	private async fetchToolPage(
		client: McpClientLike,
		cursor: string | undefined,
		collected: readonly McpToolSummary[],
	): Promise<readonly McpToolSummary[]> {
		const page = await withAbortTimeout(
			this.timeouts.listToolsSeconds,
			(signal) =>
				client.listTools(cursor === undefined ? undefined : { cursor }, {
					signal,
					timeout: secondsToMilliseconds(this.timeouts.listToolsSeconds),
					maxTotalTimeout: secondsToMilliseconds(this.timeouts.maxTotalSeconds),
				}),
			async () => {},
		);
		const tools = [...collected, ...page.tools];
		return page.nextCursor === undefined
			? tools
			: this.fetchToolPage(client, page.nextCursor, tools);
	}

	private async closeStoredConnection(serverKey: string): Promise<void> {
		const connection = this.connections.get(serverKey);
		if (connection === undefined) {
			return;
		}
		await this.closeConnection(serverKey, connection);
	}

	private async closeConnection(
		serverKey: string,
		connection: McpConnection,
	): Promise<void> {
		if (this.connections.get(serverKey) !== connection) {
			return;
		}
		this.connections.delete(serverKey);
		await connection.client.close().catch(() => {});
	}
}

async function withAbortTimeout<T>(
	seconds: number,
	operation: (signal: AbortSignal) => Promise<T>,
	onTimeout: () => Promise<void>,
): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, secondsToMilliseconds(seconds));

	try {
		return await operation(controller.signal);
	} catch (error) {
		if (timedOut) {
			await onTimeout();
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function secondsToMilliseconds(seconds: number): number {
	return seconds * MILLISECONDS_PER_SECOND;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && TIMEOUT_ERROR_PATTERN.test(error.message);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
