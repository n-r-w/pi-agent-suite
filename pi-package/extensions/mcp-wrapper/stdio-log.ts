import {
	appendFile as appendFileDefault,
	mkdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage.ts";

const MCP_WRAPPER_EXTENSION_DIR = "mcp-wrapper";
const MCP_STDIO_LOG_FILE = "stdio.log";
const BYTES_PER_KIBIBYTE = 1024;
const MCP_STDIO_LOG_MAX_MIBIBYTES = 5;
export const MCP_STDIO_LOG_MAX_BYTES =
	MCP_STDIO_LOG_MAX_MIBIBYTES * BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;

export interface McpStdioLogWriterOptions {
	readonly logPath?: string;
	readonly appendFile?: (
		path: string,
		data: string,
		options: { readonly encoding: "utf8" },
	) => Promise<void>;
}

/** Returns the shared stdio MCP server log path. */
export function getMcpStdioLogPath(): string {
	return join(
		getSuiteExtensionDir(MCP_WRAPPER_EXTENSION_DIR),
		MCP_STDIO_LOG_FILE,
	);
}

/** Queues stderr chunks for one stdio MCP server. */
export class McpStdioLogWriter {
	private readonly serverKey: string;
	private readonly logPath: string;
	private readonly appendFile: NonNullable<
		McpStdioLogWriterOptions["appendFile"]
	>;
	private serverName = "initializing";
	private pending: Promise<void> = Promise.resolve();

	constructor(serverKey: string, options: McpStdioLogWriterOptions = {}) {
		this.serverKey = serverKey;
		this.logPath = options.logPath ?? getMcpStdioLogPath();
		this.appendFile = options.appendFile ?? appendFileDefault;
	}

	write(chunk: unknown): void {
		const serverName = this.serverName;
		this.pending = this.pending.then(() => this.appendChunk(chunk, serverName));
	}

	setServerName(serverName: string): void {
		this.serverName = serverName;
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	private async appendChunk(chunk: unknown, serverName: string): Promise<void> {
		try {
			await mkdir(dirname(this.logPath), { recursive: true });
			await this.rotateIfNeeded();
			const text = Buffer.isBuffer(chunk)
				? chunk.toString("utf8")
				: String(chunk);
			const suffix = text.endsWith("\n") ? "" : "\n";
			const record = `[${new Date().toISOString()}] [${this.serverKey}] [${serverName}] ${text}${suffix}`;
			await this.appendWithRetry(record);
		} catch {
			// MCP diagnostics must not change server behavior when local logging fails.
		}
	}

	private async rotateIfNeeded(): Promise<void> {
		try {
			if ((await stat(this.logPath)).size <= MCP_STDIO_LOG_MAX_BYTES) {
				return;
			}
			await rm(`${this.logPath}.1`, { force: true });
			await rename(this.logPath, `${this.logPath}.1`);
		} catch {
			// Concurrent writers can rotate or recreate the shared file first.
		}
	}

	private async appendWithRetry(record: string): Promise<void> {
		try {
			await this.appendFile(this.logPath, record, { encoding: "utf8" });
		} catch {
			await this.appendFile(this.logPath, record, { encoding: "utf8" });
		}
	}
}
