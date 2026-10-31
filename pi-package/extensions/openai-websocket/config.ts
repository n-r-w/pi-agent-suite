import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";

/** Suite directory owned only by this extension. */
const EXTENSION_DIRECTORY = "openai-websocket";

/** Config keys accepted by this extension. */
const CONFIG_KEYS = new Set(["enabled"]);

/** Result of reading the configuration; an invalid configuration disables the extension. */
export type OpenAIWebSocketConfigResult =
	| { readonly kind: "enabled" }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string };

/** Reads and strictly validates the suite-owned configuration; a missing file enables the extension. */
export function readOpenAIWebSocketConfig(): OpenAIWebSocketConfigResult {
	const readResult = readSuiteConfigFileSync(EXTENSION_DIRECTORY);
	if (readResult.kind === "missing") {
		return { kind: "enabled" };
	}
	if (readResult.kind === "read-error") {
		return invalid(`failed to read ${readResult.location.displayPath}`);
	}

	let rawConfig: unknown;
	try {
		rawConfig = JSON.parse(readResult.file.content);
	} catch (error) {
		return invalid(
			`failed to parse config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof rawConfig !== "object" ||
		rawConfig === null ||
		Array.isArray(rawConfig)
	) {
		return invalid("config must be a JSON object");
	}
	const config = rawConfig as Record<string, unknown>;
	const unsupportedKey = Object.keys(config).find(
		(key) => !CONFIG_KEYS.has(key),
	);
	if (unsupportedKey !== undefined) {
		return invalid(`unsupported config field: ${unsupportedKey}`);
	}
	const enabled = config["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalid("enabled must be a boolean");
	}
	return enabled === false ? { kind: "disabled" } : { kind: "enabled" };
}

/** Builds the result for a configuration problem described by `issue`. */
function invalid(issue: string): OpenAIWebSocketConfigResult {
	return { kind: "invalid", issue };
}
