import { writeFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Selects native fixture calls for final-stage retention or explicit exit. */
function createToolCalls(leave: boolean): ToolCall[] {
	return leave
		? [
				{
					type: "toolCall",
					id: "exit",
					name: "workflow_exit",
					arguments: { basis: "The final stage work is delivered." },
				},
				{
					type: "toolCall",
					id: "stale",
					name: "workflow_transition",
					arguments: {
						stageId: "start",
						basis: "Probe the stale registered call.",
					},
				},
			]
		: [
				{
					type: "toolCall",
					id: "activate",
					name: "workflow_activate",
					arguments: { workflowId: "delivery" },
				},
				{
					type: "toolCall",
					id: "advance",
					name: "workflow_transition",
					arguments: { stageId: "done", basis: "The initial work is ready." },
				},
			];
}

/** Runs deterministic workflow calls and records native CLI runtime boundaries. */
export function workflowExitProvider(
	pi: ExtensionAPI,
	file: string,
	leave: boolean,
): void {
	const plan = createToolCalls(leave);
	let calls = 0;
	let systemPrompt: string | undefined;
	const requests: { tools: string[]; model: string }[] = [];
	pi.on("before_agent_start", (event) => {
		systemPrompt = event.systemPrompt;
	});
	pi.on("agent_settled", (_event, ctx) => {
		writeFileSync(
			file,
			JSON.stringify({
				systemPrompt,
				activeTools: pi.getActiveTools(),
				requests,
				model: ctx.model?.id,
				thinking: pi.getThinkingLevel(),
				branch: ctx.sessionManager.getBranch(),
			}),
		);
	});
	pi.registerProvider("workflow-exit-fixture", {
		api: "openai-completions",
		apiKey: "fixture",
		baseUrl: "http://127.0.0.1:1",
		models: ["original", "stage"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			requests.push({
				tools: getCurrentTools(context.messages).map(({ name }) => name),
				model: model.id,
			});
			const call = plan[calls++];
			const stopReason =
				call === undefined ? ("stop" as const) : ("toolUse" as const);
			const output = {
				role: "assistant" as const,
				content: call === undefined ? [] : [call],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason,
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: stopReason, message: output });
				stream.end();
			});
			return stream;
		},
	});
}
