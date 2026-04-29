import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readExtensionConfigFile } from "../../shared/agent-suite-storage";

/** Suite directory owned only by this extension. */
const ENABLE_TOOLS_EXTENSION_DIR = "enable-tools";

/** Legacy config file name supported for existing installations. */
const ENABLE_TOOLS_LEGACY_CONFIG_FILE = "enable-tools.json";

/** Default tools enabled when config is missing or omits include. */
const DEFAULT_INCLUDED_TOOLS = ["grep", "find", "ls"] as const;

/** Config key that disables all behavior owned by this extension. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key listing tools that this extension should add to active tools. */
const INCLUDE_CONFIG_KEY = "include";

/** Config key listing tools that must not be added even when included. */
const EXCLUDE_CONFIG_KEY = "exclude";

/** Config keys accepted by the enable-tools config object. */
const ENABLE_TOOLS_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	INCLUDE_CONFIG_KEY,
	EXCLUDE_CONFIG_KEY,
] as const;

interface EnableToolsConfig {
	readonly enabled: boolean;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
}

type EnableToolsConfigResult =
	| { readonly kind: "valid"; readonly config: EnableToolsConfig }
	| { readonly kind: "invalid"; readonly issue: string };

interface EnableToolsSessionContext {
	readonly hasUI?: boolean;
	readonly ui?: {
		notify(message: string, type: "warning"): void;
	};
}

export default function enableSearchTools(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const config = await readEnableToolsConfig();
		if (config.kind === "invalid") {
			reportConfigIssue(ctx as EnableToolsSessionContext, config.issue);
			return;
		}

		if (!config.config.enabled) {
			return;
		}

		const availableToolNames = new Set(
			pi.getAllTools().map((tool) => tool.name),
		);
		const excludedToolNames = new Set(config.config.exclude);
		const activeToolNames = new Set(pi.getActiveTools());

		for (const toolName of config.config.include) {
			if (
				availableToolNames.has(toolName) &&
				!excludedToolNames.has(toolName)
			) {
				activeToolNames.add(toolName);
			}
		}

		pi.setActiveTools([...activeToolNames]);
	});
}

/** Reads and validates enable-tools config while missing config keeps default search tools enabled. */
async function readEnableToolsConfig(): Promise<EnableToolsConfigResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: ENABLE_TOOLS_EXTENSION_DIR,
		legacyConfigFileName: ENABLE_TOOLS_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return {
			kind: "valid",
			config: buildEnableToolsConfig({}),
		};
	}
	if (configFile.kind === "read-error") {
		return invalidConfig(
			`failed to read config: ${formatError(configFile.error)}`,
		);
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);

		return parseEnableToolsConfig(config);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses config JSON before session lifecycle logic uses it to mutate active tools. */
function parseEnableToolsConfig(config: unknown): EnableToolsConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!ENABLE_TOOLS_CONFIG_KEYS.includes(
				key as (typeof ENABLE_TOOLS_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	const include = config[INCLUDE_CONFIG_KEY];
	if (include !== undefined && !isToolNameArray(include)) {
		return invalidConfig("include must be an array of non-empty strings");
	}

	const exclude = config[EXCLUDE_CONFIG_KEY];
	if (exclude !== undefined && !isToolNameArray(exclude)) {
		return invalidConfig("exclude must be an array of non-empty strings");
	}

	return {
		kind: "valid",
		config: buildEnableToolsConfig({
			...(enabled !== undefined ? { enabled } : {}),
			...(include !== undefined ? { include } : {}),
			...(exclude !== undefined ? { exclude } : {}),
		}),
	};
}

/** Builds effective config by applying defaults to omitted fields. */
function buildEnableToolsConfig(config: {
	readonly enabled?: boolean;
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
}): EnableToolsConfig {
	return {
		enabled: config.enabled ?? true,
		include: config.include ?? DEFAULT_INCLUDED_TOOLS,
		exclude: config.exclude ?? [],
	};
}

/** Builds fail-closed config result with an isolated extension issue. */
function invalidConfig(issue: string): EnableToolsConfigResult {
	return {
		kind: "invalid",
		issue,
	};
}

/** Reports invalid config without interrupting other extensions. */
function reportConfigIssue(
	ctx: EnableToolsSessionContext,
	issue: string,
): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`[enable-tools] ${issue}`, "warning");
}

/** Returns true when a value is a JSON object suitable for strict config parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a config value is a list of tool names accepted by pi. */
function isToolNameArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item) => typeof item === "string" && item.length > 0)
	);
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
