import { readSuiteConfigFileSync } from "./agent-suite-storage";

/** Suite directory that owns the shared child startup configuration. */
const CHILD_STARTUP_CONFIG_DIR = "child-startup";
/** Allowed top-level fields in the closed child startup schema. */
const ROOT_CONFIG_KEYS = new Set(["authRetry"]);
/** Allowed fields in the authentication retry policy. */
const AUTH_RETRY_CONFIG_KEYS = new Set(["maxRetries", "delayMs"]);

/** Fixed retry settings for child authentication startup recovery. */
export interface ChildStartupAuthRetryConfig {
	readonly maxRetries: number;
	readonly delayMs: number;
}

/** Process-wide child startup configuration loaded by child-launching extensions. */
export interface ChildStartupConfig {
	readonly authRetry: ChildStartupAuthRetryConfig;
}

/** Default child startup configuration used when the config file is absent. */
export const DEFAULT_CHILD_STARTUP_CONFIG: ChildStartupConfig = {
	authRetry: {
		maxRetries: 10,
		delayMs: 2_000,
	},
};

/** Reads and validates the shared child startup configuration. */
export function readChildStartupConfig(): ChildStartupConfig {
	const file = readSuiteConfigFileSync(CHILD_STARTUP_CONFIG_DIR);
	if (file.kind === "missing") {
		return DEFAULT_CHILD_STARTUP_CONFIG;
	}
	if (file.kind === "read-error") {
		throw new Error(
			`${file.location.displayPath}: failed to read configuration: ${errorMessage(file.error)}`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(file.file.content);
	} catch (error) {
		throw new Error(
			`${file.file.displayPath}: failed to parse configuration: ${errorMessage(error)}`,
		);
	}
	return parseChildStartupConfig(value, file.file.displayPath);
}

/** Validates the closed child startup schema and applies field defaults. */
function parseChildStartupConfig(
	value: unknown,
	displayPath: string,
): ChildStartupConfig {
	if (!isRecord(value)) {
		throw invalidConfig(displayPath, "configuration must be an object");
	}
	if (!hasOnlyKeys(value, ROOT_CONFIG_KEYS)) {
		throw invalidConfig(displayPath, "configuration contains unsupported keys");
	}

	const authRetry = value["authRetry"];
	if (authRetry === undefined) {
		return DEFAULT_CHILD_STARTUP_CONFIG;
	}
	if (!isRecord(authRetry)) {
		throw invalidConfig(displayPath, "authRetry must be an object");
	}
	if (!hasOnlyKeys(authRetry, AUTH_RETRY_CONFIG_KEYS)) {
		throw invalidConfig(displayPath, "authRetry contains unsupported keys");
	}

	return {
		authRetry: {
			maxRetries: readNonNegativeInteger(
				authRetry["maxRetries"],
				DEFAULT_CHILD_STARTUP_CONFIG.authRetry.maxRetries,
				displayPath,
				"authRetry.maxRetries",
			),
			delayMs: readPositiveInteger(
				authRetry["delayMs"],
				DEFAULT_CHILD_STARTUP_CONFIG.authRetry.delayMs,
				displayPath,
				"authRetry.delayMs",
			),
		},
	};
}

/** Reads an optional non-negative safe integer or returns its documented default. */
function readNonNegativeInteger(
	value: unknown,
	defaultValue: number,
	displayPath: string,
	field: string,
): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw invalidConfig(displayPath, `${field} must be a non-negative integer`);
	}
	return value as number;
}

/** Reads an optional positive safe integer or returns its documented default. */
function readPositiveInteger(
	value: unknown,
	defaultValue: number,
	displayPath: string,
	field: string,
): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw invalidConfig(displayPath, `${field} must be a positive integer`);
	}
	return value as number;
}

/** Creates one path-qualified configuration error. */
function invalidConfig(displayPath: string, issue: string): Error {
	return new Error(`${displayPath}: ${issue}`);
}

/** Returns true for plain JSON object values. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Restricts one configuration object to its documented field set. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
): boolean {
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

/** Normalizes unknown filesystem and parser failures for startup diagnostics. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
