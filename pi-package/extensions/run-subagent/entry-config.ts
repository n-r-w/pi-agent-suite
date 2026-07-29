import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSuiteConfigFile } from "../../shared/agent-suite-storage";
import {
	isReasoningLevel,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
import { hasExactKeys } from "./boundary-validation";
import { readSubagentDepth } from "./environment";
import { errorMessage } from "./error-message";

export const SUBAGENTS_V2_EXTENSION_DIR = "run-subagent";
const DEFAULT_MAX_DEPTH = 1;
const CANONICAL_DEPTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const DESCRIPTION_PROMPT_FILE_KEYS = [
	"extensionDescriptionPromptFile",
	"startDescriptionPromptFile",
	"steerDescriptionPromptFile",
	"waitDescriptionPromptFile",
] as const;
const CONFIG_KEYS = new Set<string>([
	"enabled",
	"maxDepth",
	"query",
	...DESCRIPTION_PROMPT_FILE_KEYS,
]);

type DescriptionPromptFileKey = (typeof DESCRIPTION_PROMPT_FILE_KEYS)[number];

/** Selects optional caller-local model overrides for subagent queries. */
export interface SubagentQueryModelConfig {
	readonly id?: string;
	readonly thinking?: ReasoningLevel;
}

/** Holds query settings resolved during atomic extension configuration. */
export interface SubagentQueryConfig {
	readonly model?: SubagentQueryModelConfig;
	readonly systemPrompt?: string;
}

export interface SubagentsV2Config {
	readonly enabled: boolean;
	readonly maxDepth: number;
	readonly query?: SubagentQueryConfig;
	readonly extensionDescription?: string;
	readonly startDescription?: string;
	readonly steerDescription?: string;
	readonly waitDescription?: string;
	readonly issue?: string;
}

/** Parses the supported configuration keys and rejects unknown input. */
export async function readConfig(): Promise<SubagentsV2Config> {
	const result = await readSuiteConfigFile(SUBAGENTS_V2_EXTENSION_DIR);
	if (result.kind === "missing") {
		return { enabled: true, maxDepth: DEFAULT_MAX_DEPTH };
	}
	if (result.kind === "read-error") {
		return {
			enabled: false,
			maxDepth: DEFAULT_MAX_DEPTH,
			issue: `[subagents-v2] could not read ${result.location.displayPath}: ${errorMessage(result.error)}`,
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(result.file.content);
	} catch (error) {
		return {
			enabled: false,
			maxDepth: DEFAULT_MAX_DEPTH,
			issue: `[subagents-v2] invalid JSON in ${result.file.displayPath}: ${errorMessage(error)}`,
		};
	}
	return parseConfigValue(value);
}

/** Validates parsed configuration and resolves all descriptions as one result. */
function parseConfigValue(value: unknown): SubagentsV2Config {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalidConfig("configuration must be an object");
	}
	const keys = Object.keys(value);
	if (keys.some((key) => !CONFIG_KEYS.has(key))) {
		return invalidConfig("configuration contains an unsupported key");
	}
	let enabled: boolean;
	let maxDepth: number;
	let query: SubagentQueryConfig | undefined;
	let extensionDescription: string | undefined;
	let startDescription: string | undefined;
	let steerDescription: string | undefined;
	let waitDescription: string | undefined;
	try {
		({ enabled, maxDepth } = readBaseConfig(value));
		query = readQueryConfig(Reflect.get(value, "query"));
		extensionDescription = readConfiguredDescription(
			value,
			"extensionDescriptionPromptFile",
		);
		startDescription = readConfiguredDescription(
			value,
			"startDescriptionPromptFile",
		);
		steerDescription = readConfiguredDescription(
			value,
			"steerDescriptionPromptFile",
		);
		waitDescription = readConfiguredDescription(
			value,
			"waitDescriptionPromptFile",
		);
	} catch (error) {
		return invalidConfig(errorMessage(error));
	}
	return {
		enabled,
		maxDepth,
		...(query === undefined ? {} : { query }),
		...(extensionDescription === undefined ? {} : { extensionDescription }),
		...(startDescription === undefined ? {} : { startDescription }),
		...(steerDescription === undefined ? {} : { steerDescription }),
		...(waitDescription === undefined ? {} : { waitDescription }),
	};
}

/** Resolves enabled and depth defaults after validating their primitive values. */
function readBaseConfig(
	value: object,
): Pick<SubagentsV2Config, "enabled" | "maxDepth"> {
	const enabled = Reflect.get(value, "enabled");
	const maxDepth = Reflect.get(value, "maxDepth");
	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new Error("enabled must be boolean");
	}
	if (
		maxDepth !== undefined &&
		(typeof maxDepth !== "number" ||
			!Number.isSafeInteger(maxDepth) ||
			maxDepth < 0)
	) {
		throw new Error("maxDepth must be a non-negative safe integer");
	}
	return {
		enabled: enabled ?? true,
		maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
	};
}

/** Parses one optional query object without applying caller-local defaults. */
function readQueryConfig(value: unknown): SubagentQueryConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!hasExactKeys(value, [], ["model", "systemPromptFile"])) {
		throw new Error("query must contain only model and systemPromptFile");
	}
	const model = readQueryModelConfig(Reflect.get(value, "model"));
	const systemPrompt = readConfiguredTextFile(
		Reflect.get(value, "systemPromptFile"),
		"query.systemPromptFile",
	);
	return {
		...(model === undefined ? {} : { model }),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
	};
}

/** Parses optional query model overrides while preserving caller defaults. */
function readQueryModelConfig(
	value: unknown,
): SubagentQueryModelConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!hasExactKeys(value, [], ["id", "thinking"])) {
		throw new Error("query.model must contain only id and thinking");
	}
	const id = Reflect.get(value, "id");
	const thinking = Reflect.get(value, "thinking");
	if (id !== undefined && !hasProviderModelShape(id)) {
		throw new Error("query.model.id must use provider/model format");
	}
	if (thinking !== undefined && !isReasoningLevel(thinking)) {
		throw new Error("query.model.thinking is invalid");
	}
	return {
		...(id === undefined ? {} : { id }),
		...(thinking === undefined ? {} : { thinking }),
	};
}

/** Reads one optional absolute description file and rejects unusable content. */
function readConfiguredDescription(
	config: object,
	key: DescriptionPromptFileKey,
): string | undefined {
	return readConfiguredTextFile(Reflect.get(config, key), key);
}

/** Reads one optional absolute text file and returns non-empty trimmed content. */
function readConfiguredTextFile(
	filePath: unknown,
	field: string,
): string | undefined {
	if (filePath === undefined) {
		return undefined;
	}
	if (
		typeof filePath !== "string" ||
		filePath.trim().length === 0 ||
		!isAbsolute(filePath)
	) {
		throw new Error(`${field} must be a non-empty absolute path`);
	}
	let content: string;
	try {
		content = readFileSync(filePath, "utf8").trim();
	} catch (error) {
		throw new Error(`${field} could not be read: ${errorMessage(error)}`);
	}
	if (content.length === 0) {
		throw new Error(`${field} must reference a non-empty file`);
	}
	return content;
}

/** Requires a non-empty provider and model component around the first slash. */
function hasProviderModelShape(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	const separator = value.indexOf("/");
	return separator > 0 && separator < value.length - 1;
}

/** Returns a fail-closed V2 configuration. */
function invalidConfig(issue: string): SubagentsV2Config {
	return {
		enabled: false,
		maxDepth: DEFAULT_MAX_DEPTH,
		issue: `[subagents-v2] ${issue}`,
	};
}

/** Reads one canonical root-relative delegation depth. */
export function readCurrentDepth(): number {
	const raw = readSubagentDepth();
	if (raw === undefined) {
		return 0;
	}
	if (!CANONICAL_DEPTH_PATTERN.test(raw)) {
		throw new Error(
			"PI_SUBAGENT_DEPTH must be a canonical non-negative integer",
		);
	}
	const depth = Number(raw);
	if (!Number.isSafeInteger(depth)) {
		throw new Error("PI_SUBAGENT_DEPTH must be a safe integer");
	}
	return depth;
}

/** Reads one bundled model-facing description. */
export function readPrompt(fileName: string): string {
	return readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "prompts", fileName),
		"utf8",
	).trim();
}
