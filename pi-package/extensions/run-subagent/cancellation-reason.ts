/** Preserves Pi Error identity and wraps absent or non-Error cancellation reasons. */
export function readCancellationError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	return reason instanceof Error
		? reason
		: new Error("Pi operation was aborted", { cause: reason });
}
