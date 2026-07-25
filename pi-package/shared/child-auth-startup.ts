import { withRetry } from "./retry";

const CHILD_AUTH_STARTUP_MAX_RETRIES = 3;
const CHILD_AUTH_STARTUP_BASE_DELAY_MIN_MS = 200;
const CHILD_AUTH_STARTUP_BASE_DELAY_RANGE_MS = 200;
const CHILD_AUTH_STARTUP_RETRY_FACTOR = 2;
const NO_API_KEY_PREFIX = "No API key found for ";
const LEADING_SLASHES_PATTERN = /^\/+/;
const TRAILING_PERIOD_PATTERN = /\.$/;
const SURROUNDING_QUOTES_PATTERN = /^['"]|['"]$/g;
const CHILD_PROMPT_AFTER_SLASHES_REQUIRED =
	"child prompt must contain text after leading '/' characters";

export interface ChildAuthStartupRetryOptions {
	readonly signal?: AbortSignal | undefined;
}

export interface ChildAuthStartupFailureOptions {
	readonly activityObserved: boolean;
	readonly failure: Error;
	readonly parentAuthVerified: boolean;
	readonly provider: string;
}

/** Carries a verified pre-prompt auth rejection through shared retry backoff. */
export class ChildAuthStartupRetryError extends Error {
	constructor(readonly failure: Error) {
		super(failure.message);
		this.name = "ChildAuthStartupRetryError";
	}
}

/** Removes command markers before a task crosses the child Pi prompt boundary. */
export function normalizeChildPrompt(prompt: string): string {
	const normalized = prompt.replace(LEADING_SLASHES_PATTERN, "");
	if (normalized.trim().length === 0) {
		throw new Error(CHILD_PROMPT_AFTER_SLASHES_REQUIRED);
	}
	return normalized;
}

/** Creates a retry marker only for a verified, inactive prompt auth rejection. */
export function createChildAuthStartupRetryError(
	options: ChildAuthStartupFailureOptions,
): ChildAuthStartupRetryError | undefined {
	if (
		!options.parentAuthVerified ||
		options.activityObserved ||
		!isChildAuthStartupError(options.failure.message, options.provider)
	) {
		return undefined;
	}
	return new ChildAuthStartupRetryError(options.failure);
}

/** Retries a verified child prompt auth rejection with one randomized base delay. */
export async function withChildAuthStartupRetry<T>(
	operation: () => Promise<T>,
	options: ChildAuthStartupRetryOptions = {},
): Promise<T> {
	const baseDelayMs =
		CHILD_AUTH_STARTUP_BASE_DELAY_MIN_MS +
		Math.floor(Math.random() * CHILD_AUTH_STARTUP_BASE_DELAY_RANGE_MS);
	return withRetry(operation, {
		retry: {
			enabled: true,
			maxRetries: CHILD_AUTH_STARTUP_MAX_RETRIES,
			baseDelayMs,
		},
		signal: options.signal,
		shouldRetry: (error) => error instanceof ChildAuthStartupRetryError,
		factor: CHILD_AUTH_STARTUP_RETRY_FACTOR,
	});
}

/** Matches only the provider-specific missing-key startup failure emitted by Pi. */
export function isChildAuthStartupError(
	message: string,
	provider: string,
): boolean {
	const firstLine = message.split("\n", 1)[0]?.trim();
	if (firstLine === undefined || !firstLine.startsWith(NO_API_KEY_PREFIX)) {
		return false;
	}
	const reportedProvider = firstLine
		.slice(NO_API_KEY_PREFIX.length)
		.replace(TRAILING_PERIOD_PATTERN, "")
		.replace(SURROUNDING_QUOTES_PATTERN, "");
	return reportedProvider === provider;
}
