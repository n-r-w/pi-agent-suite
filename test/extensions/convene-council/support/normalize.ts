import type { Message } from "@mariozechner/pi-ai";

/** Removes volatile timestamps from context messages before equality checks. */
export function stripMessageTimestamps(
	messages: readonly Message[] | undefined,
): unknown[] {
	return (messages ?? []).map((message) => {
		const { timestamp: _timestamp, ...stableMessage } = message;
		return stableMessage;
	});
}
