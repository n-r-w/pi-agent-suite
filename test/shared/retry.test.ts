import { describe, expect, test } from "bun:test";
import {
	buildRetryConfig,
	createRetryableExternalError,
	isAbortError,
	isRetryableExternalError,
	validateRetryConfig,
	withRetry,
} from "../../pi-package/shared/retry";

/** Creates an AbortError that works in Node and Bun test runtimes. */
function createAbortError(): Error {
	return new DOMException("operation aborted", "AbortError");
}

describe("shared retry", () => {
	test("builds retry config from validated extension-local values and defaults", () => {
		// Purpose: extensions need one typed retry contract without sharing config files.
		// Input and expected output: partial raw retry values override extension defaults while omitted fields use defaults.
		// Edge case: retry.enabled can explicitly disable retries.
		// Dependencies: this test covers only pure retry config parsing.
		const config = buildRetryConfig(
			{ enabled: false, maxRetries: 1 },
			{ maxRetries: 5, baseDelayMs: 5_000 },
		);

		expect(config).toEqual({
			enabled: false,
			maxRetries: 1,
			baseDelayMs: 5_000,
		});
	});

	test("validates retry config with caller-owned field paths", () => {
		// Purpose: extension config validators must report retry errors with their own config path.
		// Input and expected output: unsupported keys and invalid primitive values return concrete field-path errors.
		// Edge cases: undefined config is valid, but null and negative retry counts are rejected.
		// Dependencies: this test covers only pure retry config validation.
		expect(validateRetryConfig(undefined, "summary.retry")).toBeUndefined();
		expect(validateRetryConfig(null, "summary.retry")).toBe(
			"summary.retry must be an object",
		);
		expect(validateRetryConfig({ extra: true }, "summary.retry")).toBe(
			"summary.retry contains unsupported keys",
		);
		expect(validateRetryConfig({ enabled: "yes" }, "summary.retry")).toBe(
			"summary.retry.enabled must be a boolean",
		);
		expect(validateRetryConfig({ maxRetries: -1 }, "summary.retry")).toBe(
			"summary.retry.maxRetries must be a non-negative integer",
		);
		expect(validateRetryConfig({ baseDelayMs: 1.5 }, "summary.retry")).toBe(
			"summary.retry.baseDelayMs must be a non-negative integer",
		);
	});

	test("retries retryable external errors through p-retry", async () => {
		// Purpose: transient provider and network failures must be retried by the shared module.
		// Input and expected output: WebSocket closed fails once and then succeeds on the second attempt.
		// Edge case: zero base delay keeps the test deterministic and fast.
		// Dependencies: this test depends on p-retry behavior through the shared wrapper.
		let attempts = 0;

		const result = await withRetry(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("WebSocket closed");
				}

				return "ok";
			},
			{
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
	});

	test("does not retry abort failures", async () => {
		// Purpose: user and runtime cancellation must not be retried.
		// Input and expected output: an AbortError is thrown once and propagated.
		// Edge case: retry budget is available but must not be used.
		// Dependencies: this test depends on p-retry behavior through the shared wrapper.
		let attempts = 0;

		await expect(
			withRetry(
				async () => {
					attempts += 1;
					throw createAbortError();
				},
				{
					retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
				},
			),
		).rejects.toThrow("operation aborted");
		expect(attempts).toBe(1);
	});

	test("honors disabled retry config", async () => {
		// Purpose: extension-local config must be able to disable retry behavior.
		// Input and expected output: a retryable error is thrown once when retry.enabled is false.
		// Edge case: a non-zero maxRetries value is ignored when retry is disabled.
		// Dependencies: this test depends on p-retry behavior through the shared wrapper.
		let attempts = 0;

		await expect(
			withRetry(
				async () => {
					attempts += 1;
					throw new Error("WebSocket closed");
				},
				{
					retry: { enabled: false, maxRetries: 3, baseDelayMs: 0 },
				},
			),
		).rejects.toThrow("WebSocket closed");
		expect(attempts).toBe(1);
	});

	test("marks provider error responses as retryable without relying on message text", async () => {
		// Purpose: non-throwing provider responses with stopReason error need a shared retry marker.
		// Input and expected output: an explicit retryable external error is recognized by retry checks.
		// Edge case: the message does not match transient network patterns.
		// Dependencies: this test covers the shared marker used by extension provider adapters.
		const error = createRetryableExternalError(
			"advisor provider returned an error",
		);

		expect(isRetryableExternalError(error)).toBe(true);
		expect(isAbortError(error)).toBe(false);
	});
});
