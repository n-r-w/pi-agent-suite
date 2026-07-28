import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSuiteConfigFile } from "../../shared/agent-suite-storage";
import { readSubagentDepth } from "./environment";
import { errorMessage } from "./error-message";

export const SUBAGENTS_V2_EXTENSION_DIR = "run-subagent";
const DEFAULT_MAX_DEPTH = 1;
const CANONICAL_DEPTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const DESCRIPTION_PROMPT_FILE_KEYS = [
	"startDescriptionPromptFile",
	"steerDescriptionPromptFile",
	"waitDescriptionPromptFile",
] as const;
const CONFIG_KEYS = new Set<string>([
	"enabled",
	"maxDepth",
	...DESCRIPTION_PROMPT_FILE_KEYS,
]);

type DescriptionPromptFileKey = (typeof DESCRIPTION_PROMPT_FILE_KEYS)[number];

export interface SubagentsV2Config {
	readonly enabled: boolean;
	readonly maxDepth: number;
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
	const enabled = Reflect.get(value, "enabled");
	const maxDepth = Reflect.get(value, "maxDepth");
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be boolean");
	}
	if (
		maxDepth !== undefined &&
		(typeof maxDepth !== "number" ||
			!Number.isSafeInteger(maxDepth) ||
			maxDepth < 0)
	) {
		return invalidConfig("maxDepth must be a non-negative safe integer");
	}
	let startDescription: string | undefined;
	let steerDescription: string | undefined;
	let waitDescription: string | undefined;
	try {
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
		enabled: enabled ?? true,
		maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
		...(startDescription === undefined ? {} : { startDescription }),
		...(steerDescription === undefined ? {} : { steerDescription }),
		...(waitDescription === undefined ? {} : { waitDescription }),
	};
}

/** Reads one optional absolute description file and rejects unusable content. */
function readConfiguredDescription(
	config: object,
	key: DescriptionPromptFileKey,
): string | undefined {
	const filePath = Reflect.get(config, key);
	if (filePath === undefined) {
		return undefined;
	}
	if (
		typeof filePath !== "string" ||
		filePath.trim().length === 0 ||
		!isAbsolute(filePath)
	) {
		throw new Error(`${key} must be a non-empty absolute path`);
	}
	let description: string;
	try {
		description = readFileSync(filePath, "utf8").trim();
	} catch (error) {
		throw new Error(`${key} could not be read: ${errorMessage(error)}`);
	}
	if (description.length === 0) {
		throw new Error(`${key} must reference a non-empty file`);
	}
	return description;
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
