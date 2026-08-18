import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

type AssistantAgentMessage = Extract<
	AgentEndEvent["messages"][number],
	{ readonly role: "assistant" }
>;

/** Returns whether the final assistant outcome represents a cancelled agent run. */
export function isAbortedAgentRun(event: AgentEndEvent): boolean {
	return findLastAssistantMessage(event)?.stopReason === "aborted";
}

/** Returns whether the final assistant outcome represents completed work. */
export function isCompletedAgentRun(event: AgentEndEvent): boolean {
	const stopReason = findLastAssistantMessage(event)?.stopReason;
	return (
		stopReason !== undefined &&
		stopReason !== "error" &&
		stopReason !== "aborted"
	);
}

/** Finds the latest assistant message because tool results can follow assistant turns. */
function findLastAssistantMessage(
	event: AgentEndEvent,
): AssistantAgentMessage | undefined {
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}
