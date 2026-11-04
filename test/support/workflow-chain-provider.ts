import { writeFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../pi-package/shared/agent-runtime-composition";
import {
	type CacheRequestSnapshot,
	captureRequest,
} from "./toolset-cache-provider";

/** Defines dynamic stages without changing provider-leading model settings. */
function dynamicWorkflow() {
	return {
		id: "dynamic-child",
		kind: "review",
		description: "Child",
		nested: true,
		stages: [
			{
				id: "start",
				description: "Start",
				goal: "Ready",
				prompt: "Perform fixture work",
				initial: true,
				model: { thinking: "low" },
			},
			{
				id: "done",
				description: "Done",
				goal: "Delivered",
				prompt: "Deliver fixture report",
				final: true,
				model: { thinking: "low" },
			},
		],
		transitions: [
			{ from: "start", to: "done", type: "advance" },
			{
				from: "done",
				to: "start",
				type: "rework",
				grounds: [{ id: "retry", when: "Revision" }],
			},
		],
	};
}

/** Supplies deterministic tool actions through the real native agent loop. */
function actions(): ToolCall[] {
	const plan: [string, ToolCall["arguments"]][] = [
		["workflow_activate", { workflowId: "delivery" }],
		["workflow_activate", { workflowId: "denied" }],
		["workflow_activate", { workflowId: "check" }],
		[
			"workflow_transition",
			{ stageId: "parent-only", basis: "Probe parent isolation" },
		],
		["workflow_create", dynamicWorkflow()],
		[
			"workflow_edit_stage",
			{
				stageId: "start",
				description: "Edited child",
				goal: "Ready",
				prompt: "Updated fixture work",
				model: { thinking: "low" },
			},
		],
		["workflow_get_stage", { stageId: "start" }],
		["workflow_exit", { basis: "Child complete" }],
		[
			"workflow_transition",
			{ stageId: "done", basis: "The check stage work is ready for delivery" },
		],
		["workflow_exit", { basis: "Check complete" }],
		["workflow_activate", { workflowId: "check" }],
		["workflow_activate", { workflowId: "replacement" }],
		["workflow_exit", { basis: "Replacement complete" }],
	];
	return plan.map(([name, args], index) => ({
		type: "toolCall",
		id: `call_chain_${index}|fc_chain_${index}`,
		name,
		arguments: args,
	}));
}

/** Builds one external response independently of native request serialization. */
function createResponse(
	target: Model<Api>,
	call: ToolCall | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		api: target.api,
		provider: target.provider,
		model: target.id,
		content: call ? [call] : [{ type: "text", text: "Fixture complete" }],
		stopReason: call ? "toolUse" : "stop",
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

/** Applies main policy through runtime composition while child policy stays in its launcher transport. */
function configurePolicy(pi: ExtensionAPI, child: boolean): void {
	getAgentRuntimeComposition(pi).setSelectedAgentContribution({
		prompt: "Fixture selected agent",
		tools: [
			"workflow_activate",
			"workflow_create",
			"workflow_transition",
			"workflow_exit",
			"workflow_get_stage",
			"workflow_edit_stage",
		],
		...(child
			? {}
			: {
					agent: {
						id: "fixture",
						workflows: ["delivery", "check", "replacement", "task"],
					},
				}),
	});
}

/** Captures real serialized requests and CLI lifecycle data without sending transport traffic. */
export function workflowChainProvider(
	pi: ExtensionAPI,
	file: string,
	provider: "openai" | "openai-codex",
	child: boolean,
): void {
	const model = getBuiltinModel(provider, "gpt-6.1-sol") as Model<Api>;
	const requests: CacheRequestSnapshot[] = [];
	const plan = actions();
	let turn = 0;
	let systemPrompt: string | undefined;
	pi.on("session_start", () => {
		configurePolicy(pi, child);
	});
	pi.on("before_agent_start", (event) => {
		systemPrompt = event.systemPrompt;
	});
	pi.on("agent_settled", (_event, ctx) => {
		writeFileSync(
			file,
			JSON.stringify({
				requests,
				systemPrompt,
				activeTools: pi.getActiveTools(),
				branch: ctx.sessionManager.getBranch(),
				thinking: pi.getThinkingLevel(),
				model: ctx.model?.id,
			}),
		);
	});
	pi.registerProvider(provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture",
		models: [model],
		streamSimple(target, context, options) {
			const stream = createAssistantMessageEventStream();
			const call = plan[turn++];
			const response = createResponse(target, call);
			captureRequest(target, context, options)
				.then((payload) => {
					requests.push({
						payload,
						toolNames: getCurrentTools(context.messages).map(
							({ name }) => name,
						),
					});
					stream.push({
						type: "done",
						reason: call ? "toolUse" : "stop",
						message: response,
					});
					stream.end(response);
				})
				.catch((error: unknown) => {
					const failed: AssistantMessage = {
						...response,
						stopReason: "error",
						errorMessage: String(error),
					};
					stream.push({ type: "error", reason: "error", error: failed });
					stream.end(failed);
				});
			return stream;
		},
	});
}
