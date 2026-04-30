import type { Message } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { replayContextProjection } from "../../shared/context-projection";
import type {
	CouncilContext,
	ParticipantId,
	ParticipantRuntime,
	ParticipantState,
} from "./types";

/** Builds base context once so LLM1 and LLM2 start from equivalent messages. */
export async function buildBaseCouncilMessages(options: {
	readonly ctx: CouncilContext;
	readonly toolCallId: string;
	readonly loadedSkillRoots: readonly string[];
}): Promise<readonly Message[]> {
	const projectedMessages = await replayContextProjection({
		branchEntries: options.ctx.sessionManager.getBranch(),
		cwd: options.ctx.cwd,
		loadedSkillRoots: options.loadedSkillRoots,
	});
	return removePendingCouncilCall(
		convertToLlm(projectedMessages),
		options.toolCallId,
	);
}

/** Creates the initial participant state with an isolated conversation history. */
export function createParticipantState(
	id: ParticipantId,
	runtime: ParticipantRuntime,
	baseMessages: readonly Message[],
): ParticipantState {
	return {
		id,
		runtime,
		history: [...baseMessages],
		reviewedOpponent: false,
	};
}

/** Removes convene_council tool calls and matching tool results from participant transcripts. */
function removePendingCouncilCall(
	messages: Message[],
	toolCallId: string,
): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId === toolCallId) {
			continue;
		}
		if (message.role !== "assistant") {
			result.push(message);
			continue;
		}

		if (
			message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCallId,
			)
		) {
			continue;
		}

		result.push(message);
	}

	return result;
}
