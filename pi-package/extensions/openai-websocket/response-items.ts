import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";
import {
	createInitialSystemMessage,
	getCurrentTools,
} from "@earendil-works/pi-ai/compat";

/** Input item types of tool results, which an assistant message does not produce. */
const TOOL_OUTPUT_TYPES = new Set<unknown>([
	"function_call_output",
	"custom_tool_call_output",
]);

/** Error that stops pi's request construction after the body is built, before any network access. */
class RequestCaptureStop extends Error {}

/** A finished response, the request that produced it, and pi's implementation that built the request. */
export interface FinishedResponse {
	readonly streamSimple: ApiStreamSimpleFunction;
	readonly model: Model<Api>;
	readonly context: TranscriptContext;
	readonly message: AssistantMessage;
	readonly options: SimpleStreamOptions | undefined;
}

/**
 * Returns the items of the response message in the form that pi will send them in the next request, or
 * undefined when pi's serialization cannot be separated. The raw `output` of the server differs from this form.
 */
export async function captureResponseItems(
	response: FinishedResponse,
): Promise<readonly unknown[] | undefined> {
	const { context, message } = response;
	// Tool declarations can be input items, so both contexts carry them and the difference is the message.
	const systemMessage = createInitialSystemMessage(
		undefined,
		getCurrentTools(context.messages),
	);
	const prefixMessages = systemMessage === undefined ? [] : [systemMessage];
	const build = (messages: TranscriptContext["messages"]) =>
		buildRequestInput(response, { ...context, messages });
	const [withMessage, prefix] = await Promise.all([
		build([...prefixMessages, message]),
		build(prefixMessages),
	]);
	if (
		withMessage === undefined ||
		prefix === undefined ||
		JSON.stringify(withMessage.slice(0, prefix.length)) !==
			JSON.stringify(prefix)
	) {
		return undefined;
	}
	// pi answers a tool call without a result with a placeholder output; the real result follows in the next request.
	return withMessage
		.slice(prefix.length)
		.filter(
			(item) => !TOOL_OUTPUT_TYPES.has((item as { type?: unknown }).type),
		);
}

/** Runs pi's request construction for `context` and returns the `input` of the body without sending it. */
async function buildRequestInput(
	response: FinishedResponse,
	context: TranscriptContext,
): Promise<readonly unknown[] | undefined> {
	let input: unknown;
	await response
		.streamSimple(response.model, context, {
			...response.options,
			onPayload: (payload) => {
				input = (payload as { input?: unknown }).input;
				throw new RequestCaptureStop();
			},
		})
		.result();
	return Array.isArray(input) ? input : undefined;
}
