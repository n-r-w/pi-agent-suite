import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getSuiteExtensionDir,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage.ts";
import type { McpServerConfig } from "./config.ts";
import type { McpServerToolList, McpToolSummary } from "./tool-catalog.ts";

const MCP_WRAPPER_EXTENSION_DIR = "mcp-wrapper";
const CACHE_FILE = "cache.json";
const CACHE_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;

export interface CachedMcpServerMetadata {
	readonly configHash: string;
	readonly cachedAt: number;
	readonly tools: readonly McpToolSummary[];
	readonly instructions?: string;
}

export interface McpWrapperMetadataCache {
	readonly version: 1;
	readonly servers: Readonly<Record<string, CachedMcpServerMetadata>>;
}

/** Returns the suite-owned metadata cache path for MCP wrapper discovery snapshots. */
export function getMcpWrapperCachePath(): string {
	return join(getSuiteExtensionDir(MCP_WRAPPER_EXTENSION_DIR), CACHE_FILE);
}

/** Reads and validates the MCP wrapper metadata cache from disk. */
export async function loadMcpWrapperCache(): Promise<McpWrapperMetadataCache | null> {
	let raw: string;
	try {
		raw = await readFile(getMcpWrapperCachePath(), "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return null;
		}
		return null;
	}

	try {
		return parseMcpWrapperCache(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/** Atomically writes the MCP wrapper metadata cache with user-only permissions. */
export async function saveMcpWrapperCache(
	cache: McpWrapperMetadataCache,
): Promise<void> {
	const path = getMcpWrapperCachePath();
	const directory = getSuiteExtensionDir(MCP_WRAPPER_EXTENSION_DIR);
	await mkdir(directory, { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	const content = `${JSON.stringify(cache, null, "\t")}\n`;
	await writeFile(tempPath, content, {
		encoding: "utf8",
		mode: PRIVATE_FILE_MODE,
	});
	await rename(tempPath, path);
}

/** Builds a stable hash from fields that define one MCP server's discovered tools. */
export function computeMcpServerConfigHash(config: McpServerConfig): string {
	const { onDemand: _onDemand, ...connectionConfig } = config;
	return createHash("sha256")
		.update(stableStringify(connectionConfig))
		.digest("hex");
}

/** Converts cached server entries to the discovery shape used by the tool catalog. */
export function cachedServerToolList(
	serverKey: string,
	server: CachedMcpServerMetadata,
): McpServerToolList {
	return { serverKey, tools: server.tools };
}

function parseMcpWrapperCache(value: unknown): McpWrapperMetadataCache | null {
	if (!isRecord(value) || value["version"] !== CACHE_VERSION) {
		return null;
	}
	const serversValue = value["servers"];
	if (!isRecord(serversValue)) {
		return null;
	}

	const servers: Record<string, CachedMcpServerMetadata> = {};
	for (const [serverKey, serverValue] of Object.entries(serversValue)) {
		const server = parseCachedServer(serverValue);
		if (server === null) {
			return null;
		}
		servers[serverKey] = server;
	}

	return { version: CACHE_VERSION, servers };
}

function parseCachedServer(value: unknown): CachedMcpServerMetadata | null {
	if (!isRecord(value)) {
		return null;
	}
	const configHash = value["configHash"];
	const cachedAt = value["cachedAt"];
	const tools = value["tools"];
	const instructions = value["instructions"];
	if (typeof configHash !== "string" || configHash.length === 0) {
		return null;
	}
	if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt)) {
		return null;
	}
	if (!Array.isArray(tools)) {
		return null;
	}
	if (instructions !== undefined && typeof instructions !== "string") {
		return null;
	}

	const parsedTools: McpToolSummary[] = [];
	for (const tool of tools) {
		const parsedTool = parseCachedTool(tool);
		if (parsedTool === null) {
			return null;
		}
		parsedTools.push(parsedTool);
	}

	return {
		configHash,
		cachedAt,
		tools: parsedTools,
		...(instructions !== undefined ? { instructions } : {}),
	};
}

function parseCachedTool(value: unknown): McpToolSummary | null {
	if (!isRecord(value)) {
		return null;
	}
	const name = value["name"];
	const description = value["description"];
	if (typeof name !== "string" || name.length === 0) {
		return null;
	}
	if (description !== undefined && typeof description !== "string") {
		return null;
	}

	return {
		name,
		...(description !== undefined ? { description } : {}),
		inputSchema: value["inputSchema"],
	};
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}

	const objectValue = value as Record<string, unknown>;
	return `{${Object.keys(objectValue)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
