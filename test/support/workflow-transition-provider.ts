import { writeFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../pi-package/shared/agent-runtime-composition";

/** Builds a deterministic provider response without transport or real credentials. */
function createResponse(
	target: Model<Api>,
	action: [string, ToolCall["arguments"]] | undefined,
	turn: number,
): AssistantMessage {
	return {
		role: "assistant",
		api: target.api,
		provider: target.provider,
		model: target.id,
		content: action
			? [
					{
						type: "toolCall",
						id: `call_bound_${turn}|fc_bound_${turn}`,
						name: action[0],
						arguments: action[1],
					},
				]
			: [{ type: "text", text: "Fixture complete" }],
		stopReason: action ? "toolUse" : "stop",
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
}

/** Drives the real child loop through transition checks without network or authentication. */
export function registerWorkflowTransitionProvider(
	pi: ExtensionAPI,
	file: string,
	child: boolean,
): void {
	const model = getBuiltinModel("openai", "gpt-6.1-sol") as Model<Api>;
	const plan: [string, ToolCall["arguments"]][] = [
		["workflow_activate", { workflowId: "delivery" }],
		["workflow_transition", { stageId: "done", basis: "Ready for checking" }],
		["workflow_exit", { basis: "Missing permission" }],
		[
			"workflow_transition",
			{ stageId: "done", basis: "Check needs its own check" },
		],
		["workflow_exit", { basis: "Inner check complete", allow: true }],
		["workflow_exit", { basis: "More parent work needed", allow: false }],
		["workflow_transition", { stageId: "done", basis: "Parent revised" }],
		["workflow_exit", { basis: "Early permission", allow: true }],
		[
			"workflow_transition",
			{ stageId: "start", ground: "retry", basis: "User requests revision" },
		],
		["workflow_exit", { basis: "Skip check as requested", allow: true }],
		["workflow_exit", { basis: "Task stopped", allow: false }],
	];
	let turn = 0;
	let systemPrompt: string | undefined;
	pi.on("session_start", () => {
		getAgentRuntimeComposition(pi).setSelectedAgentContribution({
			prompt: "Fixture agent",
			tools: ["workflow_activate", "workflow_transition", "workflow_exit"],
			...(child
				? {}
				: {
						agent: { id: "fixture", workflows: ["delivery", "check", "inner"] },
					}),
		});
	});
	pi.on("before_agent_start", (event) => {
		systemPrompt = event.systemPrompt;
	});
	pi.on("agent_settled", (_event, ctx) => {
		writeFileSync(
			file,
			JSON.stringify({
				branch: ctx.sessionManager.getBranch(),
				activeTools: pi.getActiveTools(),
				systemPrompt,
			}),
		);
	});
	pi.registerProvider("openai", {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture",
		models: [model],
		streamSimple(target) {
			const stream = createAssistantMessageEventStream();
			const action = plan[turn++];
			const response = createResponse(target, action, turn);
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: action ? "toolUse" : "stop",
					message: response,
				});
				stream.end(response);
			});
			return stream;
		},
	});
}
