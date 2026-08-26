/** Identifies the hidden message that keeps a child invocation open during threshold compaction. */
export const COMPACTION_TRIGGER_INTERRUPTION_TYPE =
	"compaction-trigger-interruption";

/** Identifies the hidden message that starts the post-compaction agent run. */
export const COMPACTION_TRIGGER_CONTINUATION_TYPE =
	"compaction-trigger-continuation";

/** Detects the package-internal interruption marker in a Pi RPC message event. */
export function isCompactionTriggerInterruptionMessage(
	message: unknown,
): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		Reflect.get(message, "role") === "custom" &&
		Reflect.get(message, "customType") === COMPACTION_TRIGGER_INTERRUPTION_TYPE
	);
}
