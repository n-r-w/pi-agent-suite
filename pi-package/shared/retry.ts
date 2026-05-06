import pRetry, { AbortError, type RetryContext } from "p-retry";

/** Runtime retry config accepted by shared retry helpers after extension-local parsing. */
export interface RetryConfig {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

export type RetryFailureContext = RetryContext;

/** Default retry config used by extensions that do not need custom defaults. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2_000,
};

/** Retry config keys accepted by extension-local retry objects. */
const RETRY_CONFIG_KEYS = ["enabled", "maxRetries", "baseDelayMs"] as const;

/** Provider and transport failures that are transient enough for bounded retry. */
const RETRYABLE_EXTERNAL_ERROR_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|websocket closed|websocket stream closed before response\.completed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** Error marker for provider responses that report a retryable failure without throwing. */
class RetryableExternalError extends Error {
	constructor(message: string, cause: unknown | undefined) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RetryableExternalError";
	}
}

export interface WithRetryOptions {
	readonly retry: RetryConfig;
	readonly signal?: AbortSignal | undefined;
	readonly shouldRetry?: (error: Error) => boolean;
	readonly onFailedAttempt?: (
		context: RetryFailureContext,
	) => void | Promise<void>;
	readonly factor?: number;
}

/** Builds a retry config from a validated extension-local raw object. */
export function buildRetryConfig(
	value: unknown,
	defaults: Partial<RetryConfig> = {},
): RetryConfig {
	const config = isRecord(value) ? value : {};
	const mergedDefaults = { ...DEFAULT_RETRY_CONFIG, ...defaults };
	return {
		enabled:
			typeof config["enabled"] === "boolean"
				? config["enabled"]
				: mergedDefaults.enabled,
		maxRetries:
			typeof config["maxRetries"] === "number"
				? config["maxRetries"]
				: mergedDefaults.maxRetries,
		baseDelayMs:
			typeof config["baseDelayMs"] === "number"
				? config["baseDelayMs"]
				: mergedDefaults.baseDelayMs,
	};
}

/** Validates a retry config object at an extension-owned field path. */
export function validateRetryConfig(
	value: unknown,
	fieldPath: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return `${fieldPath} must be an object`;
	}
	if (!hasOnlyKeys(value, RETRY_CONFIG_KEYS)) {
		return `${fieldPath} contains unsupported keys`;
	}

	if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") {
		return `${fieldPath}.enabled must be a boolean`;
	}
	if (!isOptionalNonNegativeInteger(value["maxRetries"])) {
		return `${fieldPath}.maxRetries must be a non-negative integer`;
	}
	if (!isOptionalNonNegativeInteger(value["baseDelayMs"])) {
		return `${fieldPath}.baseDelayMs must be a non-negative integer`;
	}

	return undefined;
}

/** Returns true when an operation stopped because the user or runtime aborted it. */
export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

/** Returns true when an external failure is transient enough for retry. */
export function isRetryableExternalError(error: Error): boolean {
	if (isAbortError(error)) {
		return false;
	}

	return (
		error instanceof RetryableExternalError ||
		RETRYABLE_EXTERNAL_ERROR_PATTERN.test(error.message)
	);
}

/** Creates an error marker for retryable non-throwing provider error responses. */
export function createRetryableExternalError(
	message: string,
	cause?: unknown,
): Error {
	return new RetryableExternalError(message, cause);
}

/** Runs an external operation with p-retry using common abort and transient-failure rules. */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: WithRetryOptions,
): Promise<T> {
	const shouldRetry = options.shouldRetry ?? isRetryableExternalError;
	return pRetry(
		async () => {
			try {
				return await operation();
			} catch (error) {
				if (isAbortError(error)) {
					throw new AbortError(error instanceof Error ? error : String(error));
				}

				throw error;
			}
		},
		{
			retries: options.retry.enabled ? options.retry.maxRetries : 0,
			minTimeout: options.retry.baseDelayMs,
			factor: options.factor ?? 2,
			randomize: false,
			signal: options.signal,
			unref: true,
			...(options.onFailedAttempt === undefined
				? {}
				: { onFailedAttempt: options.onFailedAttempt }),
			shouldRetry: ({ error }) => !isAbortError(error) && shouldRetry(error),
		},
	);
}

/** Returns true when an object contains only keys from a finite set. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a runtime value is absent or a non-negative integer. */
function isOptionalNonNegativeInteger(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isInteger(value) && value >= 0)
	);
}
