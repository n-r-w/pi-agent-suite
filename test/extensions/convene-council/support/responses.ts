import type { AssistantMessage } from "@mariozechner/pi-ai";

/** Formats a valid participant discussion response. */
export function participantResponse(
	status: "AGREE" | "DIFF" | "NEED_INFO",
	opinion: string,
): AssistantMessage["content"] {
	return [
		{
			type: "text",
			text: `<status>${status}</status><opinion>${opinion}</opinion>`,
		},
	];
}

/** Formats a plain final answer model response. */
export function finalAnswer(text: string): AssistantMessage["content"] {
	return [{ type: "text", text }];
}

/** Formats a final answer response with no text blocks. */
export function nonTextFinalAnswer(): AssistantMessage["content"] {
	return [{ type: "thinking", thinking: "hidden reasoning" }];
}
