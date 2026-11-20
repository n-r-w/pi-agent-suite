import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";

/** Suite directory owned only by this extension. */
const EXTENSION_DIRECTORY = "openai-websocket";

/** Config keys accepted by this extension. */
const CONFIG_KEYS = new Set(["enabled", "handshakeRetry"]);

/** Retry policy for opening a WebSocket before the first send. */
export interface HandshakeRetry {
	readonly maxRetries: number;
	readonly delayMs: number;
}

/** Retry policy when neither field is configured. */
const DEFAULT_HANDSHAKE_RETRY: HandshakeRetry = {
	maxRetries: 2,
	delayMs: 500,
};

/** Result of reading the configuration; an invalid configuration disables the extension. */
export type OpenAIWebSocketConfigResult =
	| { readonly kind: "enabled"; readonly handshakeRetry: HandshakeRetry }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string };

/** Reads and strictly validates the suite-owned configuration; a missing file enables the extension. */
export function readOpenAIWebSocketConfig(): OpenAIWebSocketConfigResult {
	const readResult = readSuiteConfigFileSync(EXTENSION_DIRECTORY);
	if (readResult.kind === "missing") {
		return { kind: "enabled", handshakeRetry: DEFAULT_HANDSHAKE_RETRY };
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
	const handshakeRetry = parseHandshakeRetry(config["handshakeRetry"]);
	if (typeof handshakeRetry === "string") {
		return invalid(handshakeRetry);
	}
	return enabled === false
		? { kind: "disabled" }
		: { kind: "enabled", handshakeRetry };
}

/** Returns the validated retry policy or the issue that prevents it from loading. */
function parseHandshakeRetry(value: unknown): HandshakeRetry | string {
	if (value === undefined) {
		return DEFAULT_HANDSHAKE_RETRY;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "handshakeRetry must be a JSON object";
	}

	let { maxRetries, delayMs } = DEFAULT_HANDSHAKE_RETRY;
	for (const [key, setting] of Object.entries(value)) {
		if (key !== "maxRetries" && key !== "delayMs") {
			return `unsupported config field: handshakeRetry.${key}`;
		}
		if (
			typeof setting !== "number" ||
			!Number.isSafeInteger(setting) ||
			setting < 0
		) {
			return `handshakeRetry.${key} must be a non-negative safe integer`;
		}
		if (key === "maxRetries") {
			maxRetries = setting;
		} else {
			delayMs = setting;
		}
	}
	return { maxRetries, delayMs };
}

/** Builds the result for a configuration problem described by `issue`. */
function invalid(issue: string): OpenAIWebSocketConfigResult {
	return { kind: "invalid", issue };
}
