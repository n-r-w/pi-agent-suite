import type { Server, ServerWebSocket } from "bun";

/** WebSocket close code of an unexpected server condition. */
const SERVER_FAILURE_CLOSE_CODE = 1011;

/** What the fake server does after it receives one `response.create` message. */
export type FakeServerReply =
	| { readonly kind: "events"; readonly events: readonly object[] }
	| { readonly kind: "events-then-close"; readonly events: readonly object[] }
	| { readonly kind: "close" };

/** One `response.create` message as the fake server received it. */
export interface ReceivedRequest {
	readonly connectionId: number;
	readonly message: Record<string, unknown>;
}

/** Local Responses WebSocket endpoint that answers with scripted events. */
export interface FakeResponsesWebSocketServer {
	/** Base URL of the endpoint in the form that pi models use, such as `http://127.0.0.1:1234/v1`. */
	readonly baseUrl: string;
	/** Handshake headers of each accepted connection, in connection order. */
	readonly handshakes: readonly Record<string, string>[];
	readonly requests: readonly ReceivedRequest[];
	/** Number of connections that the client closed or the server closed. */
	closedConnections(): number;
	/** Makes later handshakes fail with HTTP 403. */
	rejectHandshakes(): void;
	stop(): Promise<void>;
}

interface ConnectionData {
	readonly connectionId: number;
}

/** Starts a fake server; `reply` decides the answer to each request by its order. */
export function startFakeResponsesWebSocketServer(
	reply: (request: Record<string, unknown>, index: number) => FakeServerReply,
): FakeResponsesWebSocketServer {
	const handshakes: Record<string, string>[] = [];
	const requests: ReceivedRequest[] = [];
	let rejecting = false;
	let closed = 0;

	const server: Server<ConnectionData> = Bun.serve<ConnectionData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			if (rejecting) {
				return new Response("forbidden", { status: 403 });
			}
			handshakes.push(Object.fromEntries(request.headers.entries()));
			const upgraded = bunServer.upgrade(request, {
				data: { connectionId: handshakes.length - 1 },
			});
			return upgraded
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			message(socket: ServerWebSocket<ConnectionData>, raw) {
				const message = JSON.parse(String(raw)) as Record<string, unknown>;
				requests.push({ connectionId: socket.data.connectionId, message });
				answer(socket, reply(message, requests.length - 1));
			},
			close() {
				closed++;
			},
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		handshakes,
		requests,
		closedConnections: () => closed,
		rejectHandshakes: () => {
			rejecting = true;
		},
		stop: () => server.stop(true),
	};
}

function answer(
	socket: ServerWebSocket<ConnectionData>,
	reply: FakeServerReply,
): void {
	if (reply.kind === "close") {
		socket.close(SERVER_FAILURE_CLOSE_CODE, "server failure");
		return;
	}
	for (const event of reply.events) {
		socket.send(JSON.stringify(event));
	}
	if (reply.kind === "events-then-close") {
		socket.close(SERVER_FAILURE_CLOSE_CODE, "server failure");
	}
}

/** Usage block of a completed response; `cachedTokens` of `inputTokens` came from the prompt cache. */
export function responseUsage(
	inputTokens: number,
	cachedTokens: number,
): Record<string, unknown> {
	return {
		input_tokens: inputTokens,
		input_tokens_details: { cached_tokens: cachedTokens },
		output_tokens: 1,
		total_tokens: inputTokens + 1,
	};
}

/** Events of a response that answers with one text message. */
export function textResponseEvents(
	responseId: string,
	text: string,
	usage: Record<string, unknown> = responseUsage(10, 0),
): object[] {
	const item = {
		type: "message",
		id: `msg_${responseId}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
	};
	return completedResponseEvents(responseId, item, usage);
}

/** Events of a response that calls one tool. */
export function toolCallResponseEvents(
	responseId: string,
	toolName: string,
	toolArguments: Record<string, unknown>,
): object[] {
	const item = {
		type: "function_call",
		id: `fc_${responseId}`,
		call_id: `call_${responseId}`,
		name: toolName,
		arguments: JSON.stringify(toolArguments),
		status: "completed",
	};
	return completedResponseEvents(responseId, item, responseUsage(10, 0));
}

function completedResponseEvents(
	responseId: string,
	item: object,
	usage: Record<string, unknown>,
): object[] {
	return [
		{
			type: "response.created",
			response: { id: responseId, status: "in_progress", output: [] },
		},
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: { id: responseId, status: "completed", output: [item], usage },
		},
	];
}

/** Error event that the Responses API sends instead of a response. */
export function errorEvent(
	status: number,
	code: string,
	message: string,
): object {
	return {
		type: "error",
		status,
		error: { type: "invalid_request_error", code, message },
	};
}
