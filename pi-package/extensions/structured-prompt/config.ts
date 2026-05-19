import { readFileSync } from "node:fs";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage.ts";

const STRUCTURED_PROMPT_EXTENSION_DIR = "structured-prompt";
const ENABLED_CONFIG_KEY = "enabled";
const PROMPT_CONFIG_KEYS = [ENABLED_CONFIG_KEY] as const;

export interface PromptConfig {
	readonly enabled: boolean;
}

export type PromptConfigResult =
	| { readonly kind: "valid"; readonly config: PromptConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Parses the structured-prompt config and rejects every unsupported public key. */
export function parsePromptConfig(config: unknown): PromptConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!PROMPT_CONFIG_KEYS.includes(key as (typeof PROMPT_CONFIG_KEYS)[number]),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	return {
		kind: "valid",
		config: { enabled: enabled ?? true },
	};
}

/** Reads the suite-owned prompt config once during extension load. */
export function readPromptConfig(): PromptConfigResult {
	const configLocation = getSuiteConfigLocation(
		STRUCTURED_PROMPT_EXTENSION_DIR,
	);

	let content: string;
	try {
		content = readFileSync(configLocation.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "valid", config: { enabled: true } };
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		return parsePromptConfig(JSON.parse(content) as unknown);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

function invalidConfig(issue: string): PromptConfigResult {
	return { kind: "invalid", issue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
