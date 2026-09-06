import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../pi-package/shared/agent-runtime-composition";

interface Request {
	readonly model: string;
	readonly tools: string[];
}

/** Holds the first fake response while the test selects another main agent. */
export function selectionProbe(pi: ExtensionAPI, file: string): void {
	const requests: Request[] = [];
	const prompts: string[] = [];
	let release: (() => void) | undefined;
	pi.on("before_agent_start", (event) => {
		prompts.push(event.systemPrompt);
	});
	pi.registerCommand("probe", {
		description: "Dump isolated selection state",
		handler: async (_args, ctx) => {
			writeFileSync(
				file,
				JSON.stringify({
					requests,
					prompts,
					activeAgent:
						getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent
							?.id,
					activeTools: pi.getActiveTools(),
					model: ctx.model?.id,
					thinking: pi.getThinkingLevel(),
					branch: ctx.sessionManager.getBranch(),
				}),
			);
		},
	});
	pi.registerCommand("release", {
		description: "Release the isolated response",
		handler: async () => {
			release?.();
		},
	});
	registerProvider(pi, requests, (finish) => {
		release = finish;
	});
}

/** Registers a fake provider that does not perform network requests. */
function registerProvider(
	pi: ExtensionAPI,
	requests: Request[],
	hold: (finish: () => void) => void,
): void {
	pi.registerProvider("selection-test", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "fixture",
		api: "openai-completions",
		models: ["a", "b", "c"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		})),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			requests.push({
				model: model.id,
				tools: context.tools?.map(({ name }) => name) ?? [],
			});
			const finish = () => {
				const output = {
					role: "assistant" as const,
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop" as const,
					timestamp: Date.now(),
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
				};
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			};
			if (requests.length === 1) {
				hold(finish);
			} else {
				queueMicrotask(finish);
			}
			return stream;
		},
	});
}
