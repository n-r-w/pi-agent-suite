import { isAbsolute } from "node:path";
import {
	readSuiteConfigFile,
	type StorageFileReadResult,
} from "./agent-suite-storage";
import {
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "./reasoning-levels";
import {
	buildRetryConfig,
	type RetryConfig,
	validateRetryConfig,
} from "./retry";

/** Suite directory that owns custom-compaction configuration. */
const CUSTOM_COMPACTION_EXTENSION_DIR = "custom-compaction";

/** Prompt-file fields retained by adaptive custom compaction. */
const PROMPT_FILE_KEYS = [
	"systemPromptFile",
	"historyPromptFile",
	"updatePromptFile",
] as const;

/** Accepted public custom-compaction configuration keys. */
const CUSTOM_COMPACTION_CONFIG_KEYS = [
	"enabled",
	...PROMPT_FILE_KEYS,
	"model",
	"reasoning",
	"retry",
] as const;

/** Validated custom-compaction configuration shared across extensions. */
export interface CustomCompactionConfig {
	readonly systemPromptFile?: string;
	readonly historyPromptFile?: string;
	readonly updatePromptFile?: string;
	readonly model?: string;
	readonly reasoning?: ReasoningLevel;
	readonly retry: RetryConfig;
}

/** Result of reading and validating custom-compaction configuration. */
export type CustomCompactionConfigResult =
	| { readonly kind: "disabled" }
	| { readonly kind: "valid"; readonly config: CustomCompactionConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Reads and validates custom-compaction configuration for extension consumers. */
export async function readCustomCompactionConfig(): Promise<CustomCompactionConfigResult> {
	const configFile = await readSuiteConfigFile(CUSTOM_COMPACTION_EXTENSION_DIR);
	if (configFile.kind === "missing") {
		return { kind: "valid", config: buildCustomCompactionConfig({}) };
	}
	if (configFile.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${configFile.location.displayPath}: ${formatError(configFile.error)}`,
		};
	}

	return parseCustomCompactionFile(configFile.file);
}

/** Parses one located custom-compaction JSON file into its runtime contract. */
function parseCustomCompactionFile(
	file: StorageFileReadResult,
): CustomCompactionConfigResult {
	try {
		const config: unknown = JSON.parse(file.content);
		return parseCustomCompactionConfig(config, file.displayPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse ${file.displayPath}: ${formatError(error)}`,
		};
	}
}

/** Validates unknown JSON and returns disabled or normalized configuration. */
function parseCustomCompactionConfig(
	value: unknown,
	configDisplayPath: string,
): CustomCompactionConfigResult {
	if (!isRecord(value)) {
		return {
			kind: "invalid",
			issue: `${configDisplayPath} must contain a JSON object`,
		};
	}

	const unsupportedKey = Object.keys(value).find(
		(key) =>
			!(CUSTOM_COMPACTION_CONFIG_KEYS as readonly string[]).includes(key),
	);
	if (unsupportedKey !== undefined) {
		return {
			kind: "invalid",
			issue: `unsupported key "${unsupportedKey}" in ${configDisplayPath}`,
		};
	}

	const enabled = value["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid", issue: "enabled must be a boolean" };
	}
	if (enabled === false) {
		return { kind: "disabled" };
	}

	const promptFileIssue = validatePromptFiles(value);
	if (promptFileIssue !== undefined) {
		return { kind: "invalid", issue: promptFileIssue };
	}

	const model = value["model"];
	if (model !== undefined && !isModelId(model)) {
		return { kind: "invalid", issue: "model must use provider/model" };
	}

	const reasoning = value["reasoning"];
	if (reasoning !== undefined && !isReasoningLevel(reasoning)) {
		return {
			kind: "invalid",
			issue: `reasoning must be one of ${REASONING_LEVELS.join(", ")}`,
		};
	}

	const retryIssue = validateRetryConfig(value["retry"], "retry");
	if (retryIssue !== undefined) {
		return { kind: "invalid", issue: retryIssue };
	}

	return { kind: "valid", config: buildCustomCompactionConfig(value) };
}

/** Builds the normalized internal configuration after validation succeeds. */
function buildCustomCompactionConfig(
	value: Record<string, unknown>,
): CustomCompactionConfig {
	const systemPromptFile = value["systemPromptFile"];
	const historyPromptFile = value["historyPromptFile"];
	const updatePromptFile = value["updatePromptFile"];
	const model = value["model"];
	const reasoning = value["reasoning"];

	return {
		...(typeof systemPromptFile === "string" ? { systemPromptFile } : {}),
		...(typeof historyPromptFile === "string" ? { historyPromptFile } : {}),
		...(typeof updatePromptFile === "string" ? { updatePromptFile } : {}),
		...(typeof model === "string" ? { model } : {}),
		...(isReasoningLevel(reasoning) ? { reasoning } : {}),
		retry: buildRetryConfig(value["retry"]),
	};
}

/** Validates optional prompt paths as non-empty absolute file names. */
function validatePromptFiles(
	value: Record<string, unknown>,
): string | undefined {
	for (const key of PROMPT_FILE_KEYS) {
		const path = value[key];
		if (
			path !== undefined &&
			(typeof path !== "string" || path.trim().length === 0)
		) {
			return `${key} must be a non-empty string`;
		}
		if (typeof path === "string" && !isAbsolute(path)) {
			return `${key} must be an absolute path`;
		}
	}
	return undefined;
}

/** Returns whether a value uses the required provider/model identifier shape. */
function isModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.indexOf("/") > 0 &&
		value.indexOf("/") < value.length - 1
	);
}

/** Returns whether unknown JSON is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats unknown failures without leaking raw configuration contents. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
