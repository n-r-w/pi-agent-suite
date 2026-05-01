import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { COUNCIL_CONTEXT_TOO_LARGE_ERROR } from "./constants";
import type { ParticipantRuntime } from "./types";

// Pi exports generateSummary but not the request builder it uses, so preflight mirrors that model-visible envelope.
const PI_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const PI_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Verifies that Pi generateSummary can receive the rendered context package and reserve. */
export function validateSummaryInputSize(options: {
	readonly contextPackage: string;
	readonly runtime: ParticipantRuntime;
	readonly reserveTokens: number;
}): string | undefined {
	const estimate =
		estimateSerializedInputTokens(
			createGenerateSummaryContext(options.contextPackage),
			options.runtime.model.id,
			options.runtime.model.provider,
		) + options.reserveTokens;
	return estimate <= options.runtime.model.contextWindow
		? undefined
		: COUNCIL_CONTEXT_TOO_LARGE_ERROR;
}

/** Creates the message that Pi generateSummary receives as source conversation content. */
export function createSummarySourceMessage(contextPackage: string): Message {
	return { role: "user", content: contextPackage, timestamp: Date.now() };
}

/** Mirrors the model-visible prompt envelope used by Pi generateSummary. */
function createGenerateSummaryContext(contextPackage: string): Context {
	const sourceMessage = createSummarySourceMessage(contextPackage);
	const conversationText = serializeConversation(
		convertToLlm([sourceMessage as AgentMessage]),
	);
	return {
		systemPrompt: PI_SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `<conversation>\n${conversationText}\n</conversation>\n\n${PI_SUMMARIZATION_PROMPT}`,
					},
				],
				timestamp: Date.now(),
			},
		],
	};
}
