import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RestorationRecord } from "../../pi-package/extensions/skill-restoration/restoration";

/** Creates deterministic assistant messages for read history and fake providers. */
export function createSkillAssistant(
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "skill-runtime",
		model: "fake",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Creates an ordered path-only persistence fixture. */
export function createPathRecord(paths: string[]): RestorationRecord {
	return {
		compactionId: "old",
		candidates: paths,
	};
}
