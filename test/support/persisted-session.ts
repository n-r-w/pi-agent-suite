import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Creates one saved owner session with deterministic assistant evidence. */
export function createPersistedSession(
	directory: string,
	options: { readonly id: string; readonly text: string } = {
		id: "owner-pi",
		text: "owner seed",
	},
): SessionManager {
	const manager = SessionManager.create(directory, directory, {
		id: options.id,
	});
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: options.text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	manager.appendMessage(assistant);
	return manager;
}
