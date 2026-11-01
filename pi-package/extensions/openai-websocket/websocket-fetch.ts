import { createHash } from "node:crypto";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { Connection, ConnectionPool } from "./connection-pool";
import {
	buildCreateMessage,
	type ContinuationRecord,
	type ResponsesRequestBody,
} from "./continuation";
import {
	connectWebSocket,
	createAbortError,
	type ResponseEvent,
	ResponseEventReader,
} from "./socket";

/** Error code of an incremental request whose previous response the server no longer holds. */
const PREVIOUS_RESPONSE_NOT_FOUND = "previous_response_not_found";

/** Error code of a request on a connection that reached the 60-minute limit of the server. */
const CONNECTION_LIMIT_REACHED = "websocket_connection_limit_reached";

/** Events after which the server sends nothing more for the response. */
const TERMINAL_EVENT_TYPES = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

/** Terminal events of a response that the next request can continue. */
const CONTINUABLE_EVENT_TYPES = new Set([
	"response.completed",
	"response.incomplete",
]);

/** HTTP headers that describe an HTTP body and have no meaning for a WebSocket handshake. */
const HTTP_BODY_HEADERS = new Set(["accept", "content-type", "content-length"]);

/** Matches a request path of the Responses API create endpoint. */
const RESPONSES_PATH_PATTERN = /\/responses$/;

/** A response that completed on a pooled connection, with the record that waits for its response items. */
export interface CompletedResponse {
	readonly record: ContinuationRecord;
	readonly connection: Connection;
}

/** What the extension learns about one model request while its fetch runs. */
export interface RequestTrace {
	fetchCalled: boolean;
	completed: CompletedResponse | undefined;
}

/** Settings and state that one model request gives its WebSocket fetch. */
export interface WebSocketFetchContext {
	readonly originalFetch: FetchFunction;
	readonly pool: ConnectionPool;
	readonly sessionId: string | undefined;
	/** True when the request may reuse the session connection and send incremental requests. */
	readonly pooled: boolean;
	readonly connectTimeoutMs: number | undefined;
	readonly idleTimeoutMs: number | undefined;
	readonly trace: RequestTrace;
	/** Moves the session to HTTP and tells the user why. */
	readonly onWebSocketUnavailable: (reason: string) => void;
}

/** Responses create request taken from the arguments of a fetch call. */
interface ResponsesRequest {
	readonly url: URL;
	readonly headers: Record<string, string>;
	readonly body: ResponsesRequestBody;
}

/** Creates the fetch that sends Responses create requests in WebSocket mode and passes other requests on. */
export function createWebSocketFetch(
	context: WebSocketFetchContext,
): FetchFunction {
	// pi-ai repeats a failed request through the same fetch, so the move to HTTP must cover the repeats.
	let movedToHttp = false;
	const exchangeContext: WebSocketFetchContext = {
		...context,
		onWebSocketUnavailable: (reason) => {
			movedToHttp = true;
			context.onWebSocketUnavailable(reason);
		},
	};
	const webSocketFetch = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		context.trace.fetchCalled = true;
		const request = parseResponsesRequest(input, init);
		if (request === undefined || movedToHttp) {
			return context.originalFetch(input, init);
		}
		return new WebSocketExchange(exchangeContext, request, () =>
			context.originalFetch(input, init),
		).run(init?.signal ?? undefined);
	};
	return Object.assign(webSocketFetch, {
		preconnect: context.originalFetch.preconnect,
	});
}

/** Returns the Responses create request of a fetch call, or undefined for any other HTTP request. */
function parseResponsesRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): ResponsesRequest | undefined {
	if (
		typeof input !== "string" ||
		init?.method !== "POST" ||
		typeof init.body !== "string"
	) {
		return undefined;
	}
	const url = new URL(input);
	const body = parseJsonObject(init.body);
	if (
		!RESPONSES_PATH_PATTERN.test(url.pathname) ||
		body === undefined ||
		body["background"] === true
	) {
		return undefined;
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of new Headers(init.headers)) {
		if (!HTTP_BODY_HEADERS.has(name)) {
			headers[name] = value;
		}
	}
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return { url, headers, body };
}

/** Parses a JSON object; gives undefined for invalid JSON and for other JSON values. */
function parseJsonObject(text: string): ResponsesRequestBody | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as ResponsesRequestBody)
			: undefined;
	} catch {
		return undefined;
	}
}

/** One Responses create request sent over a connection, with its retries and its HTTP fallback. */
class WebSocketExchange {
	readonly #context: WebSocketFetchContext;
	readonly #request: ResponsesRequest;
	readonly #fetchOverHttp: () => Promise<Response>;
	#retriedMissingResponse = false;
	#retriedConnectionLimit = false;

	constructor(
		context: WebSocketFetchContext,
		request: ResponsesRequest,
		fetchOverHttp: () => Promise<Response>,
	) {
		this.#context = context;
		this.#request = request;
		this.#fetchOverHttp = fetchOverHttp;
	}

	/** Returns the response as an HTTP response whose body repeats the events as server-sent events. */
	async run(signal: AbortSignal | undefined): Promise<Response> {
		const connection = await this.#acquire(signal);
		return connection === undefined
			? this.#fetchOverHttp()
			: this.#send(connection, signal);
	}

	async #send(
		connection: Connection,
		signal: AbortSignal | undefined,
	): Promise<Response> {
		const message = await buildCreateMessage(
			this.#request.body,
			connection.continuation,
		);
		const reader = new ResponseEventReader(
			connection.socket,
			signal,
			this.#context.idleTimeoutMs,
		);
		connection.socket.send(JSON.stringify(message));
		const first = await reader.next();
		if (
			first.kind === "event" &&
			this.#shouldResendOnSameConnection(first.event)
		) {
			reader.dispose();
			connection.continuation = undefined;
			return this.#send(connection, signal);
		}
		if (
			first.kind === "event" &&
			this.#shouldResendOnNewConnection(first.event)
		) {
			reader.dispose();
			this.#context.pool.release(connection, false);
			return this.run(signal);
		}
		return this.#respond(connection, reader, first);
	}

	/** Returns a connection, or undefined after the session moved to HTTP because the handshake failed. */
	async #acquire(
		signal: AbortSignal | undefined,
	): Promise<Connection | undefined> {
		const { pool, sessionId, pooled, connectTimeoutMs } = this.#context;
		const { url, headers } = this.#request;
		try {
			return await pool.acquire(
				{
					poolKey:
						pooled && sessionId !== undefined
							? poolKey(sessionId, this.#request)
							: undefined,
					sessionId,
				},
				() => connectWebSocket(url.href, headers, connectTimeoutMs, signal),
			);
		} catch (error) {
			if (signal?.aborted) {
				throw createAbortError();
			}
			this.#context.onWebSocketUnavailable(
				error instanceof Error ? error.message : String(error),
			);
			return undefined;
		}
	}

	#shouldResendOnSameConnection(event: ResponseEvent): boolean {
		if (
			errorCode(event) !== PREVIOUS_RESPONSE_NOT_FOUND ||
			this.#retriedMissingResponse
		) {
			return false;
		}
		this.#retriedMissingResponse = true;
		return true;
	}

	#shouldResendOnNewConnection(event: ResponseEvent): boolean {
		if (
			errorCode(event) !== CONNECTION_LIMIT_REACHED ||
			this.#retriedConnectionLimit
		) {
			return false;
		}
		this.#retriedConnectionLimit = true;
		return true;
	}

	#respond(
		connection: Connection,
		reader: ResponseEventReader,
		first: Awaited<ReturnType<ResponseEventReader["next"]>>,
	): Promise<Response> | Response {
		const { pool } = this.#context;
		if (first.kind === "aborted") {
			pool.release(connection, false);
			throw createAbortError();
		}
		if (first.kind === "failed") {
			pool.release(connection, false);
			if (!first.connectionLost) {
				throw first.error;
			}
			this.#context.onWebSocketUnavailable(first.error.message);
			return this.#fetchOverHttp();
		}
		const status = first.event["status"];
		if (first.event.type === "error" && typeof status === "number") {
			reader.dispose();
			pool.release(connection, false);
			const error = first.event["error"];
			return Response.json(
				{ error },
				{ status, headers: readErrorHeaders(error) },
			);
		}
		return new Response(
			new EventStreamBody(
				this.#context,
				connection,
				reader,
				this.#request.body,
			).stream(first.event),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}
}

/** Body of the HTTP response that repeats the events of one response as server-sent events. */
class EventStreamBody {
	readonly #context: WebSocketFetchContext;
	readonly #connection: Connection;
	readonly #reader: ResponseEventReader;
	readonly #requestBody: ResponsesRequestBody;
	readonly #encoder = new TextEncoder();
	#finished = false;

	constructor(
		context: WebSocketFetchContext,
		connection: Connection,
		reader: ResponseEventReader,
		requestBody: ResponsesRequestBody,
	) {
		this.#context = context;
		this.#connection = connection;
		this.#reader = reader;
		this.#requestBody = requestBody;
	}

	stream(first: ResponseEvent): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start: (controller) => this.#deliver(controller, first),
			pull: async (controller) => {
				const read = await this.#reader.next();
				if (read.kind === "event") {
					this.#deliver(controller, read.event);
					return;
				}
				this.#finish(false);
				if (read.kind === "failed" && read.connectionLost) {
					this.#context.onWebSocketUnavailable(read.error.message);
				}
				controller.error(
					read.kind === "aborted" ? createAbortError() : read.error,
				);
			},
			cancel: () => this.#finish(false),
		});
	}

	#deliver(
		controller: ReadableStreamDefaultController<Uint8Array>,
		event: ResponseEvent,
	): void {
		controller.enqueue(
			this.#encoder.encode(
				`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			),
		);
		if (!TERMINAL_EVENT_TYPES.has(event.type)) {
			return;
		}
		const responseId = (event["response"] as { id?: unknown } | undefined)?.id;
		const continuable =
			CONTINUABLE_EVENT_TYPES.has(event.type) && typeof responseId === "string";
		if (continuable && this.#context.pooled) {
			const record: ContinuationRecord = {
				request: this.#requestBody,
				responseId,
				responseItems: undefined,
			};
			this.#connection.continuation = record;
			this.#context.trace.completed = { record, connection: this.#connection };
		}
		this.#finish(continuable);
		controller.close();
	}

	/** Releases the connection once; a response that did not complete leaves the server state unknown, so it closes. */
	#finish(completed: boolean): void {
		if (this.#finished) {
			return;
		}
		this.#finished = true;
		this.#reader.dispose();
		this.#context.pool.release(this.#connection, completed);
	}
}

/**
 * Returns the HTTP headers that the server sent with an `error` event, such as `retry-after`; pi decides
 * whether and when to retry by these headers.
 */
function readErrorHeaders(error: unknown): Record<string, string> {
	const headers = (error as { headers?: unknown } | undefined)?.headers;
	if (typeof headers !== "object" || headers === null) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(headers).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/** Returns the error code of an `error` event, such as `previous_response_not_found`. */
function errorCode(event: ResponseEvent): unknown {
	return event.type === "error"
		? (event["error"] as { code?: unknown } | undefined)?.code
		: undefined;
}

/** Pool key: session, model, and a digest of the URL and handshake headers, so the token stays out of the key. */
function poolKey(sessionId: string, request: ResponsesRequest): string {
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				request.url.href,
				Object.entries(request.headers).sort(),
			]),
		)
		.digest("hex");
	return JSON.stringify([sessionId, request.body["model"], digest]);
}
