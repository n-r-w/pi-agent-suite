import { withRetry } from "./retry";

/** Maximum retries for an auth failure isolated to a fresh child process. */
const CHILD_AUTH_STARTUP_RETRIES = 3;
/** Minimum backoff before a child auth startup retry. */
const CHILD_AUTH_RETRY_BASE_DELAY_MS = 200;
/** Random range added so independent Pi processes diverge during retry. */
const CHILD_AUTH_RETRY_JITTER_MS = 200;

/** Supplies cancellation and extension-specific safety classification to auth recovery. */
export interface ChildAuthStartupRetryOptions {
	readonly signal: AbortSignal | undefined;
	readonly shouldRetry: (error: unknown) => boolean;
}

/** Matches the provider-specific missing-key error emitted during Pi prompt preflight. */
export function isChildAuthStartupError(
	errorMessage: string | undefined,
	provider: string,
): boolean {
	return errorMessage?.startsWith(`No API key found for ${provider}.`) === true;
}

/** Runs one child startup operation with the shared bounded auth recovery policy. */
export function withChildAuthStartupRetry<T>(
	operation: () => Promise<T>,
	options: ChildAuthStartupRetryOptions,
): Promise<T> {
	return withRetry(operation, {
		retry: {
			enabled: true,
			maxRetries: CHILD_AUTH_STARTUP_RETRIES,
			baseDelayMs: createChildAuthRetryDelayMs(),
		},
		factor: 2,
		signal: options.signal,
		shouldRetry: options.shouldRetry,
	});
}

/** Creates one randomized initial retry delay shared by child process launchers. */
function createChildAuthRetryDelayMs(): number {
	return (
		CHILD_AUTH_RETRY_BASE_DELAY_MS +
		Math.floor(Math.random() * CHILD_AUTH_RETRY_JITTER_MS)
	);
}
