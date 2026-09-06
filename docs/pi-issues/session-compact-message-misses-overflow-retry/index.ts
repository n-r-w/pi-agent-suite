import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	Model,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "overflow-retry-repro";
const MODEL_ID = "overflow-retry-repro";
const RESTORED_CONTEXT_MARKER = "RESTORED_CONTEXT_MARKER";

const MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: PROVIDER_ID,
	id: MODEL_ID,
	name: "Overflow retry reproducer",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
	maxTokens: 500,
};

function createMessage(
	model: Model<Api>,
	stopReason: AssistantMessage["stopReason"],
	text: string,
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: text === "" ? 0 : 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: text === "" ? 100 : 110,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

function completedStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

export default function overflowRetryRepro(pi: ExtensionAPI): void {
	let providerRequestCount = 0;
	const streamSimple = ((model, context) => {
		providerRequestCount += 1;
		if (providerRequestCount === 1) {
			return completedStream(createMessage(model, "stop", "Seed turn complete."));
		}
		if (providerRequestCount === 2) {
			return completedStream(
				createMessage(model, "error", "", "context_length_exceeded"),
			);
		}

		const markerPresent = JSON.stringify(context.messages).includes(
			RESTORED_CONTEXT_MARKER,
		);
		return completedStream(
			createMessage(
				model,
				"stop",
				markerPresent
					? "EXPECTED BEHAVIOR: restored context reached the overflow retry."
					: "BUG REPRODUCED: restored context was missing from the overflow retry.",
			),
		);
	}) satisfies StreamFn;

	pi.registerProvider(PROVIDER_ID, {
		name: "Overflow retry reproducer",
		baseUrl: "http://127.0.0.1",
		apiKey: "test",
		api: MODEL.api,
		models: [MODEL],
		streamSimple,
	});

	pi.on("session_before_compact", (event) => {
		if (event.reason !== "overflow" || !event.willRetry) {
			return undefined;
		}
		return {
			compaction: {
				summary: "The seed turn completed before the overflow.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	pi.on("session_compact", (event) => {
		if (event.reason !== "overflow" || !event.willRetry) {
			return;
		}
		pi.sendMessage(
			{
				customType: "restored-context",
				content: RESTORED_CONTEXT_MARKER,
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: false },
		);
	});
}
