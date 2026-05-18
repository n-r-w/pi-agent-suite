import { readFile } from "node:fs/promises";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage.ts";

const MCP_WRAPPER_EXTENSION_DIR = "mcp-wrapper";

const DEFAULT_TIMEOUTS: McpWrapperTimeouts = {
	startupSeconds: 30,
	listToolsSeconds: 15,
	callSeconds: 120,
	maxTotalSeconds: 180,
};

const TOP_LEVEL_KEYS = ["settings", "mcpServers"] as const;
const SETTINGS_KEYS = ["enabled", "timeouts"] as const;
const TIMEOUT_KEYS = [
	"startupSeconds",
	"listToolsSeconds",
	"callSeconds",
	"maxTotalSeconds",
] as const;
const STDIO_SERVER_KEYS = ["type", "command", "args", "env", "cwd"] as const;
const STREAMABLE_HTTP_SERVER_KEYS = ["type", "url", "headers"] as const;

export interface McpWrapperTimeouts {
	readonly startupSeconds: number;
	readonly listToolsSeconds: number;
	readonly callSeconds: number;
	readonly maxTotalSeconds: number;
}

export type McpServerConfig =
	| {
			readonly type: "stdio";
			readonly command: string;
			readonly args: readonly string[];
			readonly env: Readonly<Record<string, string>>;
			readonly cwd?: string;
	  }
	| {
			readonly type: "streamableHttp";
			readonly url: string;
			readonly headers: Readonly<Record<string, string>>;
	  };

export interface McpWrapperConfig {
	readonly enabled: boolean;
	readonly timeouts: McpWrapperTimeouts;
	readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

interface InvalidConfigResult {
	readonly kind: "invalid";
	readonly issue: string;
}

export type McpWrapperConfigResult =
	| { readonly kind: "valid"; readonly config: McpWrapperConfig }
	| InvalidConfigResult;

export async function readMcpWrapperConfig(): Promise<McpWrapperConfigResult> {
	const location = getSuiteConfigLocation(MCP_WRAPPER_EXTENSION_DIR);
	let content: string;
	try {
		content = await readFile(location.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return parseMcpWrapperConfig({ mcpServers: {} });
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		return parseMcpWrapperConfig(JSON.parse(content) as unknown);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses the MCP wrapper config at the file boundary before runtime code uses it. */
export function parseMcpWrapperConfig(config: unknown): McpWrapperConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const topLevelIssue = findUnsupportedKey(config, TOP_LEVEL_KEYS);
	if (topLevelIssue !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const settingsResult = parseSettings(config["settings"]);
	if (settingsResult.kind === "invalid") {
		return settingsResult;
	}

	const serversResult = parseMcpServers(config["mcpServers"]);
	if (serversResult.kind === "invalid") {
		return serversResult;
	}

	return {
		kind: "valid",
		config: {
			enabled: settingsResult.settings.enabled,
			timeouts: settingsResult.settings.timeouts,
			mcpServers: serversResult.mcpServers,
		},
	};
}

/** Parses optional settings and applies defaults to omitted fields. */
function parseSettings(value: unknown):
	| {
			readonly kind: "valid";
			readonly settings: {
				readonly enabled: boolean;
				readonly timeouts: McpWrapperTimeouts;
			};
	  }
	| InvalidConfigResult {
	if (value === undefined) {
		return {
			kind: "valid",
			settings: { enabled: true, timeouts: DEFAULT_TIMEOUTS },
		};
	}
	if (!isRecord(value)) {
		return invalidConfig("settings must be an object");
	}

	const unsupportedKey = findUnsupportedKey(value, SETTINGS_KEYS);
	if (unsupportedKey !== undefined) {
		return invalidConfig("settings contains unsupported keys");
	}

	const enabled = value["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("settings.enabled must be a boolean");
	}

	const timeoutsResult = parseTimeouts(value["timeouts"]);
	if (timeoutsResult.kind === "invalid") {
		return timeoutsResult;
	}

	return {
		kind: "valid",
		settings: {
			enabled: enabled ?? true,
			timeouts: timeoutsResult.timeouts,
		},
	};
}

/** Parses optional timeout overrides and rejects non-positive durations. */
function parseTimeouts(
	value: unknown,
):
	| { readonly kind: "valid"; readonly timeouts: McpWrapperTimeouts }
	| InvalidConfigResult {
	if (value === undefined) {
		return { kind: "valid", timeouts: DEFAULT_TIMEOUTS };
	}
	if (!isRecord(value)) {
		return invalidConfig("settings.timeouts must be an object");
	}

	const unsupportedKey = findUnsupportedKey(value, TIMEOUT_KEYS);
	if (unsupportedKey !== undefined) {
		return invalidConfig("settings.timeouts contains unsupported keys");
	}

	const parsedTimeouts = { ...DEFAULT_TIMEOUTS };
	for (const key of TIMEOUT_KEYS) {
		const timeout = value[key];
		if (timeout === undefined) {
			continue;
		}
		if (!isPositiveInteger(timeout)) {
			return invalidConfig(
				`settings.timeouts.${key} must be a positive integer`,
			);
		}
		parsedTimeouts[key] = timeout;
	}

	return { kind: "valid", timeouts: parsedTimeouts };
}

/** Parses the MCP server map while preserving the configured server keys. */
function parseMcpServers(value: unknown):
	| {
			readonly kind: "valid";
			readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
	  }
	| InvalidConfigResult {
	if (!isRecord(value)) {
		return invalidConfig("mcpServers must be an object");
	}

	const mcpServers: Record<string, McpServerConfig> = {};
	for (const [serverKey, serverConfig] of Object.entries(value)) {
		if (serverKey.trim().length === 0) {
			return invalidConfig("mcpServers keys must be non-empty");
		}
		const serverResult = parseMcpServerConfig(serverConfig);
		if (serverResult.kind === "invalid") {
			return serverResult;
		}
		mcpServers[serverKey] = serverResult.serverConfig;
	}

	return { kind: "valid", mcpServers };
}

/** Parses one MCP server config based on its explicit or inferred transport type. */
function parseMcpServerConfig(
	value: unknown,
):
	| { readonly kind: "valid"; readonly serverConfig: McpServerConfig }
	| InvalidConfigResult {
	if (!isRecord(value)) {
		return invalidConfig("mcpServers entries must be objects");
	}

	const serverType = value["type"];
	if (serverType === undefined || serverType === "stdio") {
		return parseStdioServerConfig(value);
	}
	if (serverType === "streamableHttp") {
		return parseStreamableHttpServerConfig(value);
	}

	return invalidConfig("mcpServers type must be stdio or streamableHttp");
}

/** Parses a stdio MCP server config without rewriting command or args values. */
function parseStdioServerConfig(
	value: Record<string, unknown>,
):
	| { readonly kind: "valid"; readonly serverConfig: McpServerConfig }
	| InvalidConfigResult {
	const unsupportedKey = findUnsupportedKey(value, STDIO_SERVER_KEYS);
	if (unsupportedKey !== undefined) {
		return invalidConfig("stdio server config contains unsupported keys");
	}

	const command = value["command"];
	const args = value["args"];
	const env = value["env"];
	const cwd = value["cwd"];

	if (typeof command !== "string" || command.length === 0) {
		return invalidConfig("stdio.command must be a non-empty string");
	}
	if (args !== undefined && !isStringArray(args)) {
		return invalidConfig("stdio.args must be an array of strings");
	}
	if (env !== undefined && !isStringRecord(env)) {
		return invalidConfig("stdio.env must be an object with string values");
	}
	if (cwd !== undefined && typeof cwd !== "string") {
		return invalidConfig("stdio.cwd must be a string");
	}

	return {
		kind: "valid",
		serverConfig: {
			type: "stdio",
			command,
			args: args ?? [],
			env: env ?? {},
			...(cwd !== undefined ? { cwd } : {}),
		},
	};
}

/** Parses a Streamable HTTP MCP server config with literal headers. */
function parseStreamableHttpServerConfig(
	value: Record<string, unknown>,
):
	| { readonly kind: "valid"; readonly serverConfig: McpServerConfig }
	| InvalidConfigResult {
	const unsupportedKey = findUnsupportedKey(value, STREAMABLE_HTTP_SERVER_KEYS);
	if (unsupportedKey !== undefined) {
		return invalidConfig(
			"streamableHttp server config contains unsupported keys",
		);
	}

	const url = value["url"];
	const headers = value["headers"];

	if (typeof url !== "string" || url.length === 0) {
		return invalidConfig("streamableHttp.url must be a non-empty string");
	}
	if (headers !== undefined && !isStringRecord(headers)) {
		return invalidConfig(
			"streamableHttp.headers must be an object with string values",
		);
	}

	return {
		kind: "valid",
		serverConfig: {
			type: "streamableHttp",
			url,
			headers: headers ?? {},
		},
	};
}

/** Builds a fail-closed parser result with a safe diagnostic. */
function invalidConfig(issue: string): InvalidConfigResult {
	return { kind: "invalid", issue };
}

/** Finds the first object key outside the allowed config contract. */
function findUnsupportedKey<const T extends readonly string[]>(
	value: Record<string, unknown>,
	allowedKeys: T,
): string | undefined {
	return Object.keys(value).find(
		(key) => !allowedKeys.includes(key as T[number]),
	);
}

/** Returns true when a value is a JSON object suitable for strict parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a value is a positive integer duration in seconds. */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Returns true when a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/** Returns true when a value is an object whose keys and values are strings. */
function isStringRecord(
	value: unknown,
): value is Readonly<Record<string, string>> {
	if (!isRecord(value)) {
		return false;
	}

	return Object.values(value).every((item) => typeof item === "string");
}

/** Converts unknown failures into safe config diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
