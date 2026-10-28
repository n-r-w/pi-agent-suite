import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Provider fields captured after native serialization and before transport. */
export interface CacheRequestPayload {
	input: unknown[];
	[key: string]: unknown;
}

/** Native request and callable tools observed during one model turn. */
export interface CacheRequestSnapshot {
	payload: CacheRequestPayload;
	toolNames: string[];
}

/** Tool calls used by the scripted external model. */
type ModelAction = "activate_toolset" | "files_read" | "files_write" | "stop";

/** Serializes the actual provider context while stopping before network access. */
async function captureRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<CacheRequestPayload> {
	let payload: CacheRequestPayload | undefined;
	const serializedOptions: SimpleStreamOptions = {
		...options,
		apiKey: `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.signature`,
		transport: "sse",
		onPayload: async (value, target) => {
			const replacement = await options?.onPayload?.(value, target);
			payload = JSON.parse(
				JSON.stringify(replacement ?? value),
			) as CacheRequestPayload;
			throw new Error("Request captured before transport");
		},
	};
	const transcript = normalizeContext(context);
	const stream =
		model.api === "openai-responses"
			? streamOpenAI(
					model as Model<"openai-responses">,
					transcript,
					serializedOptions,
				)
			: streamCodex(
					model as Model<"openai-codex-responses">,
					transcript,
					serializedOptions,
				);
	await stream.result();
	if (!payload) {
		throw new Error(
			"Native provider serialization did not reach the capture hook",
		);
	}
	return payload;
}

/** Builds a model response with stable native tool-call identities. */
function createResponse(
	model: Model<Api>,
	action: ModelAction,
	id: string,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content:
			action === "stop"
				? [{ type: "text", text: "fixture response" }]
				: [
						{
							type: "toolCall",
							id: `call_${id}|fc_${id}`,
							name: action,
							arguments: action === "activate_toolset" ? { name: "files" } : {},
						},
					],
		stopReason: action === "stop" ? "stop" : "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** Replaces only model responses while preserving the real provider serialization path. */
export function registerCacheProvider(
	pi: ExtensionAPI,
	model: Model<Api>,
	resumed: boolean,
	requests: CacheRequestSnapshot[],
): void {
	const actions: ModelAction[] = resumed
		? ["files_read", "stop"]
		: ["activate_toolset", "files_read", "stop", "files_write", "stop"];
	let calls = 0;
	pi.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture",
		models: [model],
		streamSimple: (target, context, options) => {
			const stream = createAssistantMessageEventStream();
			const action = actions[calls];
			calls += 1;
			const response = createResponse(
				target,
				action ?? "stop",
				`${resumed ? "resumed" : "initial"}_${calls}`,
			);
			captureRequest(target, context, options)
				.then((payload) => {
					if (!action) {
						throw new Error("Agent requested an unexpected model turn");
					}
					requests.push({
						payload,
						toolNames: getCurrentTools(context.messages).map(
							(tool) => tool.name,
						),
					});
					stream.push({
						type: "done",
						reason: action === "stop" ? "stop" : "toolUse",
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
