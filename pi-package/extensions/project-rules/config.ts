import { readFileSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";

export const PROJECT_RULES_EXTENSION_DIR = "project-rules";

const ENABLED_CONFIG_KEY = "enabled";
const RULES_DIR_CONFIG_KEY = "rulesDir";
const CONFIG_KEYS = [ENABLED_CONFIG_KEY, RULES_DIR_CONFIG_KEY] as const;
const DEFAULT_RULES_DIR = ".pi";
const PATH_PART_SEPARATOR = /[\\/]+/;

interface ProjectRulesRawConfig {
	readonly enabled?: boolean;
	readonly rulesDir?: string;
}

export interface ProjectRulesConfig {
	readonly enabled: boolean;
	readonly rulesDir: string;
}

export type ProjectRulesConfigResult =
	| { readonly kind: "valid"; readonly config: ProjectRulesConfig }
	| { readonly kind: "invalid"; readonly issue: string };

type UnknownRecord = Record<string, unknown>;

/** Reads suite-owned config and applies project-rules defaults when config is absent. */
export function readProjectRulesConfig(): ProjectRulesConfigResult {
	const configLocation = getSuiteConfigLocation(PROJECT_RULES_EXTENSION_DIR);
	let content: string;
	try {
		content = readFileSync(configLocation.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return parseProjectRulesConfig({});
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		return parseProjectRulesConfig(JSON.parse(content));
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses unknown JSON before file loading uses user-controlled paths. */
export function parseProjectRulesConfig(
	config: unknown,
): ProjectRulesConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) => !CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number]),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const rawConfig = parseProjectRulesFields(config);
	if (rawConfig.kind === "invalid") {
		return rawConfig;
	}

	return {
		kind: "valid",
		config: buildProjectRulesConfig(rawConfig.config),
	};
}

/** Parses supported fields after object shape and key ownership are known. */
function parseProjectRulesFields(
	config: UnknownRecord,
):
	| { readonly kind: "valid"; readonly config: ProjectRulesRawConfig }
	| { readonly kind: "invalid"; readonly issue: string } {
	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	const rulesDir = config[RULES_DIR_CONFIG_KEY];
	if (rulesDir !== undefined && typeof rulesDir !== "string") {
		return invalidConfig("rulesDir must be a string");
	}
	if (rulesDir !== undefined) {
		const validationIssue = validateRulesDir(rulesDir);
		if (validationIssue !== undefined) {
			return invalidConfig(validationIssue);
		}
	}

	return {
		kind: "valid",
		config: {
			...(enabled === undefined ? {} : { enabled }),
			...(rulesDir === undefined ? {} : { rulesDir }),
		},
	};
}

/** Keeps the configured entry point relative to cwd before symlinks are followed. */
function validateRulesDir(rulesDir: string): string | undefined {
	if (rulesDir.trim().length === 0) {
		return "rulesDir must not be empty";
	}
	if (isAbsolute(rulesDir)) {
		return "rulesDir must be a relative path";
	}

	const rawParts = rulesDir.split(PATH_PART_SEPARATOR);
	if (rawParts.includes("..")) {
		return "rulesDir must not contain parent directory traversal";
	}

	const normalizedParts = normalize(rulesDir).split(sep);
	if (normalizedParts.includes("..")) {
		return "rulesDir must not contain parent directory traversal";
	}

	return undefined;
}

/** Builds effective config by applying extension defaults to omitted fields. */
function buildProjectRulesConfig(
	config: ProjectRulesRawConfig,
): ProjectRulesConfig {
	return {
		enabled: config.enabled ?? true,
		rulesDir: config.rulesDir ?? DEFAULT_RULES_DIR,
	};
}

/** Builds fail-closed config results with messages safe for UI warnings. */
function invalidConfig(
	issue: string,
): ProjectRulesConfigResult & { readonly kind: "invalid" } {
	return { kind: "invalid", issue };
}

/** Returns true when dynamic property reads are safe. */
function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown failures into short diagnostics without exposing file contents. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
