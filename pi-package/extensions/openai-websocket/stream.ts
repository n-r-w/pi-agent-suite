import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";
import type { ConnectionPool } from "./connection-pool";
import { captureResponseItems } from "./response-items";
import { createWebSocketFetch, type RequestTrace } from "./websocket-fetch";

/** State that the model requests of one extension instance share. */
export interface TransportState {
	readonly pool: ConnectionPool;
	/** Sessions whose model requests go over HTTP after WebSocket mode failed. */
	readonly httpSessions: Set<string>;
	/** Tells the user that WebSocket mode is unavailable. */
	readonly warn: (message: string) => void;
}

/** Reason shown to the user when pi stops passing the fetch of the extension to the OpenAI SDK. */
const FETCH_NOT_USED_REASON =
	"pi did not pass the WebSocket transport to the OpenAI request";

/**
 * Creates the stream function of the `openai` provider: pi's own `openai-responses` implementation whose
 * HTTP requests go in WebSocket mode, unless the pi setting `transport` is `sse` or the session moved to HTTP.
 */
export function createStreamFunction(
	responsesStreamSimple: ApiStreamSimpleFunction,
	state: TransportState,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		const transport = options?.transport ?? "auto";
		const sessionId = options?.sessionId;
		if (
			transport === "sse" ||
			(sessionId !== undefined && state.httpSessions.has(sessionId))
		) {
			return responsesStreamSimple(model, context, options);
		}
		const moveToHttp = (reason: string): void => {
			if (sessionId !== undefined) {
				state.httpSessions.add(sessionId);
			}
			state.warn(
				`[openai-websocket] WebSocket mode is unavailable; OpenAI model requests of this session use HTTP. Reason: ${reason}`,
			);
		};
		const trace: RequestTrace = { fetchCalled: false, completed: undefined };
		const fetch = createWebSocketFetch({
			originalFetch: options?.fetch ?? globalThis.fetch,
			pool: state.pool,
			sessionId,
			pooled: sessionId !== undefined && transport !== "websocket",
			connectTimeoutMs: options?.websocketConnectTimeoutMs,
			idleTimeoutMs: options?.timeoutMs,
			trace,
			onWebSocketUnavailable: moveToHttp,
		});
		const stream = responsesStreamSimple(model, context, { ...options, fetch });
		stream.result().then((message) => {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				closeCompletedConnection(state, trace);
				return;
			}
			if (!trace.fetchCalled) {
				moveToHttp(FETCH_NOT_USED_REASON);
				return;
			}
			// The next request on the connection waits for this capture.
			const record = trace.completed?.record;
			if (
				record !== undefined &&
				record.responseId === message.responseId &&
				!hasUnparsedToolArguments(message)
			) {
				record.responseItems = captureResponseItems({
					streamSimple: responsesStreamSimple,
					model,
					context,
					message,
					options,
				});
			}
		});
		return stream;
	};
}

/**
 * Closes the connection of a response that the server completed but pi ended with an abort or an error,
 * unless another request already uses the connection.
 */
function closeCompletedConnection(
	state: TransportState,
	trace: RequestTrace,
): void {
	const completed = trace.completed;
	if (
		completed !== undefined &&
		!completed.connection.busy &&
		completed.connection.continuation === completed.record
	) {
		state.pool.release(completed.connection, false);
	}
}

/**
 * Returns true when pi replaced tool arguments that it could not parse with `{}`. The server keeps the
 * original text, so only a full request gives the model the same context as over HTTP.
 */
function hasUnparsedToolArguments(message: AssistantMessage): boolean {
	return message.content.some(
		(block) => block.type === "toolCall" && block.argumentsError !== undefined,
	);
}
