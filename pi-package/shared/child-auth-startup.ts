import type { ChildStartupAuthRetryConfig } from "./child-startup-config";
import type { ChildStartupGate } from "./child-startup-gate";
import { withRetry } from "./retry";
import { normalizeTerminalDisplayText } from "./terminal-display-text";

const LEADING_SLASHES_PATTERN = /^\/+/;
const CHILD_PROMPT_AFTER_SLASHES_REQUIRED =
	"child prompt must contain text after leading '/' characters";

/** Extension that owns one child Pi startup operation. */
export type ChildAuthStartupOwner = "run-subagent" | "convene-council";

/** Startup stage that produced one diagnostic record. */
export type ChildAuthStartupStage = "parent_auth" | "child_prompt";

/** Recovery decision made from one startup attempt. */
export type ChildAuthStartupDecision =
	| "accepted"
	| "retry"
	| "failed"
	| "cancelled";

/** Safe reason codes that never include credential or child output content. */
export type ChildAuthStartupReason =
	| "provider_not_configured"
	| "parent_auth_unavailable"
	| "child_start_failed"
	| "prompt_accepted"
	| "child_stop_failed"
	| "prompt_auth_unavailable"
	| "prompt_failed"
	| "cancelled";

/** Safe diagnostic fields produced for one child startup attempt. */
export interface ChildAuthStartupAttemptRecord {
	readonly owner: ChildAuthStartupOwner;
	readonly provider: string;
	readonly attempt: number;
	readonly totalAttempts: number;
	readonly stage: ChildAuthStartupStage;
	readonly promptAccepted: boolean;
	readonly decision: ChildAuthStartupDecision;
	readonly reason: ChildAuthStartupReason;
	readonly durationMs: number;
}

/** Parent credential result checked inside the shared FIFO slot. */
export type ChildParentAuthResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: string };

/** Owner-provided operations for one shared child startup lifecycle. */
export interface ChildAuthStartupOperations<child, output> {
	readonly owner: ChildAuthStartupOwner;
	readonly provider: string;
	readonly providerConfigured: boolean;
	readonly retry: ChildStartupAuthRetryConfig;
	readonly startupGate: ChildStartupGate;
	readonly signal?: AbortSignal | undefined;
	readonly cancellationError?: (() => Error) | undefined;
	readonly checkParentAuth: () => Promise<ChildParentAuthResult>;
	readonly start: () => Promise<child>;
	readonly prompt: (attempt: child, onAccepted: () => void) => Promise<output>;
	readonly stop: (attempt: child) => Promise<void>;
	readonly recordAttempt?:
		| ((record: ChildAuthStartupAttemptRecord) => void)
		| undefined;
}

/** Final authentication recovery failure with safe per-attempt diagnostics. */
export class ChildAuthStartupRecoveryError extends Error {
	public constructor(
		public readonly failure: Error,
		public readonly attempts: readonly ChildAuthStartupAttemptRecord[],
	) {
		super(formatRecoveryFailure(failure, attempts));
		this.name = "ChildAuthStartupRecoveryError";
	}
}

/** Carries one retryable startup failure through the shared scheduler. */
class ChildAuthStartupRetryError extends Error {
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

interface ChildAuthStartupAttemptLifecycle {
	readonly accepted: () => boolean;
	readonly accept: () => void;
	readonly record: (
		stage: ChildAuthStartupStage,
		decision: ChildAuthStartupDecision,
		reason: ChildAuthStartupReason,
	) => void;
	readonly release: () => void;
}

/** Inputs needed to create one attempt's idempotent lifecycle callbacks. */
interface ChildAuthStartupAttemptLifecycleOptions {
	readonly attemptNumber: number;
	readonly totalAttempts: number;
	readonly startedAt: number;
	readonly releaseStartup: () => void;
	readonly recordAttempt: (
		record: Omit<ChildAuthStartupAttemptRecord, "owner" | "provider">,
	) => void;
}

/** Runs one child process until its first prompt is accepted or recovery stops. */
export async function runChildAuthStartup<child, output>(
	options: ChildAuthStartupOperations<child, output>,
): Promise<output> {
	const attempts: ChildAuthStartupAttemptRecord[] = [];
	const totalAttempts = options.retry.maxRetries + 1;
	let attemptNumber = 0;

	if (!options.providerConfigured) {
		recordStartupAttempt(options, attempts, {
			attempt: 1,
			totalAttempts,
			stage: "parent_auth",
			promptAccepted: false,
			decision: "failed",
			reason: "provider_not_configured",
			durationMs: 0,
		});
		throw new Error(`No API key found for "${options.provider}"`);
	}

	try {
		return await withRetry(
			() =>
				runStartupAttempt(options, attempts, ++attemptNumber, totalAttempts),
			{
				retry: {
					enabled: true,
					maxRetries: options.retry.maxRetries,
					baseDelayMs: options.retry.delayMs,
				},
				signal: options.signal,
				shouldRetry: (error) => error instanceof ChildAuthStartupRetryError,
				factor: 1,
			},
		);
	} catch (error) {
		if (error instanceof ChildAuthStartupRetryError) {
			throw new ChildAuthStartupRecoveryError(error.failure, attempts);
		}
		throw error;
	}
}

/** Owns one FIFO slot, parent credential check, and first-prompt boundary. */
async function runStartupAttempt<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	attempts: ChildAuthStartupAttemptRecord[],
	attemptNumber: number,
	totalAttempts: number,
): Promise<output> {
	const startedAt = Date.now();
	const releaseStartup = await options.startupGate.acquire(options.signal);
	if (releaseStartup === undefined) {
		recordStartupAttempt(options, attempts, {
			attempt: attemptNumber,
			totalAttempts,
			stage: "parent_auth",
			promptAccepted: false,
			decision: "cancelled",
			reason: "cancelled",
			durationMs: Date.now() - startedAt,
		});
		throw cancellationError(options);
	}

	const lifecycle = createAttemptLifecycle({
		attemptNumber,
		totalAttempts,
		startedAt,
		releaseStartup,
		recordAttempt: (record) => recordStartupAttempt(options, attempts, record),
	});
	try {
		throwIfCancelled(options, lifecycle);
		const auth = await options.checkParentAuth();
		throwIfCancelled(options, lifecycle);
		if (!auth.ok) {
			lifecycle.record(
				"parent_auth",
				retryDecision(attemptNumber, options.retry.maxRetries),
				"parent_auth_unavailable",
			);
			throw new ChildAuthStartupRetryError(new Error(auth.error));
		}

		const child = await startChild(options, lifecycle);
		if (options.signal?.aborted) {
			await stopChild(options, child, lifecycle);
			lifecycle.record("child_prompt", "cancelled", "cancelled");
			throw cancellationError(options);
		}
		return await deliverFirstPrompt(options, child, lifecycle, attemptNumber);
	} finally {
		lifecycle.release();
	}
}

/** Stops an aborted attempt before auth classification or process creation. */
function throwIfCancelled<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	lifecycle: ChildAuthStartupAttemptLifecycle,
): void {
	if (!options.signal?.aborted) {
		return;
	}
	lifecycle.record("parent_auth", "cancelled", "cancelled");
	throw cancellationError(options);
}

/** Starts a child only after parent credentials are available. */
async function startChild<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	lifecycle: ChildAuthStartupAttemptLifecycle,
): Promise<child> {
	try {
		return await options.start();
	} catch (error) {
		if (options.signal?.aborted) {
			lifecycle.record("child_prompt", "cancelled", "cancelled");
			throw cancellationError(options);
		}
		lifecycle.record("child_prompt", "failed", "child_start_failed");
		throw toError(error);
	}
}

/** Stops one unaccepted child and preserves stop failures as terminal startup errors. */
async function stopChild<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	childProcess: child,
	lifecycle: ChildAuthStartupAttemptLifecycle,
): Promise<void> {
	try {
		await options.stop(childProcess);
	} catch (error) {
		lifecycle.record("child_prompt", "failed", "child_stop_failed");
		throw toError(error);
	}
}

/** Delivers the first prompt and classifies only failures before acceptance. */
async function deliverFirstPrompt<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	childProcess: child,
	lifecycle: ChildAuthStartupAttemptLifecycle,
	attemptNumber: number,
): Promise<output> {
	try {
		const result = await options.prompt(childProcess, lifecycle.accept);
		if (!lifecycle.accepted()) {
			throw new Error("child prompt completed without acceptance");
		}
		return result;
	} catch (error) {
		if (lifecycle.accepted()) {
			throw error;
		}

		await stopChild(options, childProcess, lifecycle);
		if (options.signal?.aborted) {
			lifecycle.record("child_prompt", "cancelled", "cancelled");
			throw cancellationError(options);
		}

		const failure = toError(error);
		if (isChildAuthStartupError(failure.message, options.provider)) {
			lifecycle.record(
				"child_prompt",
				retryDecision(attemptNumber, options.retry.maxRetries),
				"prompt_auth_unavailable",
			);
			throw new ChildAuthStartupRetryError(failure);
		}
		lifecycle.record("child_prompt", "failed", "prompt_failed");
		throw failure;
	}
}

/** Creates idempotent acceptance, recording, and FIFO release operations. */
function createAttemptLifecycle({
	attemptNumber,
	totalAttempts,
	startedAt,
	releaseStartup,
	recordAttempt,
}: ChildAuthStartupAttemptLifecycleOptions): ChildAuthStartupAttemptLifecycle {
	let promptAccepted = false;
	let attemptRecorded = false;
	let gateReleased = false;
	const release = (): void => {
		if (!gateReleased) {
			gateReleased = true;
			releaseStartup();
		}
	};
	const record = (
		stage: ChildAuthStartupStage,
		decision: ChildAuthStartupDecision,
		reason: ChildAuthStartupReason,
	): void => {
		if (attemptRecorded) {
			return;
		}
		attemptRecorded = true;
		recordAttempt({
			attempt: attemptNumber,
			totalAttempts,
			stage,
			promptAccepted,
			decision,
			reason,
			durationMs: Date.now() - startedAt,
		});
	};
	return {
		accepted: () => promptAccepted,
		accept: () => {
			if (promptAccepted) {
				return;
			}
			promptAccepted = true;
			release();
			record("child_prompt", "accepted", "prompt_accepted");
		},
		record,
		release,
	};
}

/** Appends one immutable attempt record and forwards it to the optional diagnostic sink. */
function recordStartupAttempt<child, output>(
	options: ChildAuthStartupOperations<child, output>,
	attempts: ChildAuthStartupAttemptRecord[],
	record: Omit<ChildAuthStartupAttemptRecord, "owner" | "provider">,
): void {
	const completeRecord: ChildAuthStartupAttemptRecord = {
		owner: options.owner,
		provider: options.provider,
		...record,
	};
	attempts.push(completeRecord);
	try {
		options.recordAttempt?.(completeRecord);
	} catch {
		// Diagnostic persistence must not change startup recovery behavior.
	}
}

/** Maps remaining retry capacity to the attempt's observable decision. */
function retryDecision(
	attempt: number,
	maxRetries: number,
): Extract<ChildAuthStartupDecision, "retry" | "failed"> {
	return attempt <= maxRetries ? "retry" : "failed";
}

/** Uses the owner's cancellation contract before the generic signal fallback. */
function cancellationError<child, output>(
	options: ChildAuthStartupOperations<child, output>,
): Error {
	if (options.cancellationError !== undefined) {
		return options.cancellationError();
	}
	return options.signal?.reason instanceof Error
		? options.signal.reason
		: new Error("child startup cancelled");
}

/** Converts unknown operation failures into explicit Error values. */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Formats the terminal failure while retaining structured attempt records separately. */
function formatRecoveryFailure(
	failure: Error,
	attempts: readonly ChildAuthStartupAttemptRecord[],
): string {
	const safeFailure = normalizeTerminalDisplayText(failure.message);
	const lastAttempt = attempts.at(-1);
	if (lastAttempt === undefined) {
		return safeFailure;
	}
	return `${safeFailure}\nChild startup recovery stopped after ${attempts.length}/${lastAttempt.totalAttempts} attempts: ${lastAttempt.reason}.`;
}

/** Matches only the provider-specific missing-key first line emitted by Pi. */
export function isChildAuthStartupError(
	message: string,
	provider: string,
): boolean {
	return message.split("\n", 1)[0] === `No API key found for ${provider}.`;
}
