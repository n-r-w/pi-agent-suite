import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@mariozechner/pi-ai";
import type { ParticipantId } from "./types";
import { escapeXmlText } from "./xml";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");
const PARTICIPANT_SYSTEM_PROMPT = readPromptFile("participant-system.md");
const FINAL_ANSWER_SYSTEM_PROMPT = readPromptFile("final-answer-system.md");
const INITIAL_OPINION_PROMPT = readPromptFile("initial-opinion.md");
const OPINION_REVIEW_PROMPT = readPromptFile("opinion-review.md");
const MISSING_INFORMATION_RESPONSE_PROMPT = readPromptFile(
	"missing-information-response.md",
);
const CLARIFICATION_REVIEW_PROMPT = readPromptFile("clarification-review.md");
const FINAL_ANSWER_PROMPT = readPromptFile("final-answer.md");
const PARTICIPANT_REPAIR_PROMPT = readPromptFile("participant-repair.md");
const FINAL_ANSWER_REPAIR_PROMPT = readPromptFile("final-answer-repair.md");
const RUNTIME_GUIDANCE_PROMPT = readPromptFile("runtime-guidance.md");

/** Builds the stable system prompt for one participant. */
export function buildParticipantSystemPrompt(
	participantId: ParticipantId,
): string {
	return renderTemplate(PARTICIPANT_SYSTEM_PROMPT, { participantId });
}

/** Builds the plain-text system prompt for final-answer generation. */
export function buildFinalAnswerSystemPrompt(): string {
	return FINAL_ANSWER_SYSTEM_PROMPT;
}

/** Builds the first-turn task that requires an initial NEED_INFO status. */
export function buildInitialOpinionTask(question: string): string {
	return renderTemplate(INITIAL_OPINION_PROMPT, { question });
}

/** Builds a normal opponent-opinion review task. */
export function buildOpinionReviewTask(
	question: string,
	opponentOpinion: string,
): string {
	return renderTemplate(OPINION_REVIEW_PROMPT, { question, opponentOpinion });
}

/** Builds a task for answering the opponent's missing-information request. */
export function buildMissingInformationResponseTask(
	question: string,
	missingInformationRequest: string,
): string {
	return renderTemplate(MISSING_INFORMATION_RESPONSE_PROMPT, {
		question,
		missingInformationRequest,
	});
}

/** Builds a task for reviewing an opponent clarification response. */
export function buildClarificationReviewTask(
	question: string,
	clarification: string,
): string {
	return renderTemplate(CLARIFICATION_REVIEW_PROMPT, {
		question,
		clarification,
	});
}

/** Builds the final-answer task after both participants have agreed. */
export function buildFinalAnswerTask(
	question: string,
	llm1Opinion: string,
	llm2Opinion: string,
): string {
	return renderTemplate(FINAL_ANSWER_PROMPT, {
		question,
		llm1Opinion,
		llm2Opinion,
	});
}

/** Builds a repair instruction for malformed participant discussion responses. */
export function buildParticipantRepairInstruction(): string {
	return PARTICIPANT_REPAIR_PROMPT;
}

/** Builds a repair instruction for defective final answers. */
export function buildFinalAnswerRepairInstruction(): string {
	return FINAL_ANSWER_REPAIR_PROMPT;
}

/** Returns the tool-gated system prompt guidance for the main agent. */
export function buildRuntimeGuidancePrompt(): string {
	return RUNTIME_GUIDANCE_PROMPT;
}

/** Creates a user task message that is always appended after prior context. */
export function createTaskMessage(task: string): Message {
	return { role: "user", content: task, timestamp: Date.now() };
}

/** Reads one bundled prompt file and trims trailing file whitespace. */
function readPromptFile(fileName: string): string {
	return readFileSync(join(PROMPTS_DIR, fileName), "utf8").trim();
}

/** Replaces named prompt variables without adding runtime prompt logic elsewhere. */
function renderTemplate(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/{{([A-Za-z0-9]+)}}/g, (match, key: string) => {
		const value = values[key];
		return value === undefined ? match : escapeXmlText(value);
	});
}
