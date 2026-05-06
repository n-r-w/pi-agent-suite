import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ParticipantDiscussionResponse, ParticipantStatus } from "./types";

const PARTICIPANT_RESPONSE_PATTERN =
	/^<status>(AGREE|DIFF|NEED_INFO)<\/status><opinion>([\s\S]*?)<\/opinion>$/;
const DISCUSSION_TAG_PATTERN = /<\/?(?:status|opinion)>/;
const FORBIDDEN_FINAL_ANSWER_TAG_PATTERN =
	/<\/?(?:status|opinion|answer1|answer2)>/i;

/** Parses exact participant XML-like output and rejects all response defects. */
export function parseParticipantResponse(
	message: AssistantMessage,
):
	| { readonly response: ParticipantDiscussionResponse }
	| { readonly issue: string } {
	const text = getAssistantRawText(message);
	const match = PARTICIPANT_RESPONSE_PATTERN.exec(text);
	if (match === null) {
		return {
			issue: "participant response must contain only status and opinion blocks",
		};
	}

	const status = match[1];
	const rawOpinion = match[2] ?? "";
	const opinion = rawOpinion.trim();
	if (opinion.length === 0 || DISCUSSION_TAG_PATTERN.test(rawOpinion)) {
		return {
			issue: "participant response has invalid status or empty opinion",
		};
	}

	return { response: { status: status as ParticipantStatus, opinion } };
}

/** Extracts visible text content from a provider answer. */
export function getAssistantText(message: AssistantMessage): string {
	return getAssistantRawText(message).trim();
}

/** Extracts visible text without trimming so strict parsers can detect outside text. */
function getAssistantRawText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Rejects empty final answers and discussion tags that must not reach the caller. */
export function isValidFinalAnswer(answer: string): boolean {
	return answer.length > 0 && !FORBIDDEN_FINAL_ANSWER_TAG_PATTERN.test(answer);
}
