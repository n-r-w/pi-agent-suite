/** Drives native MCP permission checks with a deterministic local provider. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Registers a provider that makes one codemode call and records its result. */
export default function registerNativeMcpProvider(pi: ExtensionAPI): void {
	const directory = dirname(fileURLToPath(import.meta.url));
	const code = readFileSync(join(directory, "script.js"), "utf8");
	let calls = 0;
	pi.on("before_agent_start", (event) => {
		writeFileSync(
			join(directory, "runtime.json"),
			JSON.stringify({
				systemPrompt: event.systemPrompt,
				activeTools: pi.getActiveTools(),
			}),
		);
	});
	pi.registerProvider("native-mcp-test", {
		api: "openai-completions",
		apiKey: "fixture",
		baseUrl: "http://127.0.0.1:1",
		models: [
			{
				id: "fake",
				name: "Fake",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				calls += 1;
				const results = context.messages.filter(
					(message) => message.role === "toolResult",
				);
				writeFileSync(join(directory, "results.json"), JSON.stringify(results));
				const stopReason = calls === 1 ? "toolUse" : "stop";
				const output = createResponse(model, code, stopReason);
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: stopReason, message: output });
				stream.end();
			});
			return stream;
		},
	});
}

/** Creates the provider response for a tool call or completed turn. */
function createResponse(
	model: Model<Api>,
	code: string,
	stopReason: "toolUse" | "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [
						{
							type: "toolCall",
							id: "native-call",
							name: "codemode",
							arguments: { code },
						},
					]
				: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: 0,
	};
}
