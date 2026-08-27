import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";

const EXTENSION_DIRECTORY = "model-response-timeout";
const CONFIG_KEYS = new Set(["enabled", "timeoutSeconds"]);
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
export const MILLISECONDS_PER_SECOND = 1_000;

export interface ModelResponseTimeoutConfig {
	readonly timeoutSeconds: number;
}

export type ModelResponseTimeoutConfigResult =
	| { readonly kind: "enabled"; readonly config: ModelResponseTimeoutConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string };

const DEFAULT_CONFIG: ModelResponseTimeoutConfig = {
	timeoutSeconds: 300,
};

/** Reads and strictly validates the suite-owned timeout configuration once. */
export function readModelResponseTimeoutConfig(): ModelResponseTimeoutConfigResult {
	const readResult = readSuiteConfigFileSync(EXTENSION_DIRECTORY);
	if (readResult.kind === "missing") {
		return { kind: "enabled", config: DEFAULT_CONFIG };
	}
	if (readResult.kind === "read-error") {
		return invalid(`failed to read ${readResult.location.displayPath}`);
	}

	let rawConfig: unknown;
	try {
		rawConfig = JSON.parse(readResult.file.content);
	} catch (error) {
		return invalid(`failed to parse config: ${formatError(error)}`);
	}
	if (!isRecord(rawConfig)) {
		return invalid("config must be a JSON object");
	}

	const unsupportedKey = Object.keys(rawConfig).find(
		(key) => !CONFIG_KEYS.has(key),
	);
	if (unsupportedKey !== undefined) {
		return invalid(`unsupported config field: ${unsupportedKey}`);
	}
	if (
		rawConfig["enabled"] !== undefined &&
		typeof rawConfig["enabled"] !== "boolean"
	) {
		return invalid("enabled must be a boolean");
	}
	const timeoutSeconds =
		rawConfig["timeoutSeconds"] ?? DEFAULT_CONFIG.timeoutSeconds;
	if (
		typeof timeoutSeconds !== "number" ||
		!Number.isFinite(timeoutSeconds) ||
		timeoutSeconds <= 0 ||
		timeoutSeconds * MILLISECONDS_PER_SECOND > MAX_TIMER_MILLISECONDS
	) {
		return invalid(
			`timeoutSeconds must be a positive finite number no greater than ${MAX_TIMER_MILLISECONDS / MILLISECONDS_PER_SECOND}`,
		);
	}

	if (rawConfig["enabled"] === false) {
		return { kind: "disabled" };
	}
	return {
		kind: "enabled",
		config: { timeoutSeconds },
	};
}

function invalid(issue: string): ModelResponseTimeoutConfigResult {
	return { kind: "invalid", issue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
