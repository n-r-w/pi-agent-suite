import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";

const EXTENSION_DIRECTORY = "usage";
const CONFIG_KEYS = new Set(["enabled"]);

export interface UsageConfig {
	readonly enabled: true;
}

export type UsageConfigResult =
	| { readonly kind: "enabled"; readonly config: UsageConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string };

export type UsageConfigReader = () =>
	| { readonly kind: "missing" }
	| { readonly kind: "found"; readonly file: { readonly content: string } }
	| {
			readonly kind: "read-error";
			readonly location: { readonly displayPath: string };
			readonly error: unknown;
	  };

/** Reads and strictly validates the suite-owned usage configuration. */
export function readUsageConfig(
	read: UsageConfigReader = () => readSuiteConfigFileSync(EXTENSION_DIRECTORY),
): UsageConfigResult {
	const result = read();
	if (result.kind === "missing") {
		return { kind: "enabled", config: { enabled: true } };
	}
	if (result.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${result.location.displayPath}`,
		};
	}

	let value: unknown;
	try {
		value = JSON.parse(result.file.content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse config: ${formatError(error)}`,
		};
	}
	if (!isRecord(value)) {
		return { kind: "invalid", issue: "config must be a JSON object" };
	}

	const unsupportedKey = Object.keys(value).find(
		(key) => !CONFIG_KEYS.has(key),
	);
	if (unsupportedKey !== undefined) {
		return {
			kind: "invalid",
			issue: `unsupported config field: ${unsupportedKey}`,
		};
	}
	if (
		!Object.hasOwn(value, "enabled") ||
		typeof value["enabled"] !== "boolean"
	) {
		return { kind: "invalid", issue: "enabled must be an own boolean field" };
	}
	if (value["enabled"] === false) {
		return { kind: "disabled" };
	}

	return { kind: "enabled", config: { enabled: true } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
