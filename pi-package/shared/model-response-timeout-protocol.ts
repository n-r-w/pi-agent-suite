export const MODEL_RESPONSE_TIMEOUT_RETRY_ENTRY =
	"model-response-timeout.retry-scheduled";
export const MODEL_RESPONSE_TIMEOUT_RETRY_TRIGGER =
	"model-response-timeout.retry-trigger";

/** Recognizes the extension's context-free child retry announcement. */
export function isModelResponseTimeoutRetryEntry(event: unknown): boolean {
	if (typeof event !== "object" || event === null) {
		return false;
	}
	const entry = Reflect.get(event, "entry");
	return (
		Reflect.get(event, "type") === "entry_appended" &&
		typeof entry === "object" &&
		entry !== null &&
		Reflect.get(entry, "type") === "custom" &&
		Reflect.get(entry, "customType") === MODEL_RESPONSE_TIMEOUT_RETRY_ENTRY
	);
}
