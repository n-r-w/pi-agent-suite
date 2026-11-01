/** Handshake timeout when pi has no `websocketConnectTimeoutMs` setting; pi's `openai-codex` provider uses the same value. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Close code of a normal closure, sent when the extension closes a connection. */
const NORMAL_CLOSURE_CODE = 1000;

/** WebSocket constructor of Node and Bun, which accept handshake headers; the DOM type lacks this option. */
type WebSocketWithHeaders = new (
	url: string,
	options: { readonly headers: Record<string, string> },
) => WebSocket;

/** One event of the Responses API, parsed from a WebSocket message. */
export type ResponseEvent = Readonly<Record<string, unknown>> & {
	readonly type: string;
};

/** Result of one read of response events from a connection. */
export type ResponseRead =
	| { readonly kind: "event"; readonly event: ResponseEvent }
	| { readonly kind: "aborted" }
	| {
			readonly kind: "failed";
			readonly error: Error;
			/** True when the connection itself failed: it closed, broke, or stayed silent past the idle timeout. */
			readonly connectionLost: boolean;
	  };

/** Creates the error that the OpenAI SDK and pi treat as a user abort. */
export function createAbortError(): Error {
	return new DOMException("This operation was aborted", "AbortError");
}

/** Closes a connection and ignores the error of a socket that is already closed. */
export function closeSocket(socket: WebSocket): void {
	try {
		socket.close(NORMAL_CLOSURE_CODE);
	} catch {
		// The socket is already closed or closing.
	}
}

/** Opens a connection; rejects when the handshake fails, exceeds the timeout, or the request is aborted. */
export function connectWebSocket(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new (WebSocket as unknown as WebSocketWithHeaders)(url, {
			headers,
		});
		const connectTimeoutMs = timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const timer = setTimeout(
			() =>
				fail(
					new Error(`WebSocket connect timeout after ${connectTimeoutMs} ms`),
				),
			connectTimeoutMs,
		);
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error): void => {
			cleanup();
			closeSocket(socket);
			reject(error);
		};
		const onOpen = (): void => {
			cleanup();
			resolve(socket);
		};
		const onError = (event: Event): void => {
			fail(new Error(`WebSocket handshake failed: ${describeEvent(event)}`));
		};
		const onAbort = (): void => fail(createAbortError());
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onError);
		signal?.addEventListener("abort", onAbort);
		if (signal?.aborted) {
			onAbort();
		}
	});
}

/** Reads the events of one response from a connection, in arrival order. */
export class ResponseEventReader {
	readonly #socket: WebSocket;
	readonly #signal: AbortSignal | undefined;
	readonly #idleTimeoutMs: number | undefined;
	readonly #queue: ResponseRead[] = [];
	#waiter: ((read: ResponseRead) => void) | undefined;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	#ended = false;

	constructor(
		socket: WebSocket,
		signal: AbortSignal | undefined,
		idleTimeoutMs: number | undefined,
	) {
		this.#socket = socket;
		this.#signal = signal;
		this.#idleTimeoutMs = idleTimeoutMs;
		socket.addEventListener("message", this.#onMessage);
		socket.addEventListener("close", this.#onClose);
		socket.addEventListener("error", this.#onClose);
		signal?.addEventListener("abort", this.#onAbort);
		this.#restartIdleTimer();
		if (signal?.aborted) {
			this.#onAbort();
		}
	}

	/** Returns the next event, or how the response ended without one. */
	next(): Promise<ResponseRead> {
		const read = this.#queue.shift();
		if (read !== undefined) {
			return Promise.resolve(read);
		}
		return new Promise((resolve) => {
			this.#waiter = resolve;
		});
	}

	/** Stops reading so that the connection can serve another response. */
	dispose(): void {
		this.#ended = true;
		clearTimeout(this.#idleTimer);
		this.#socket.removeEventListener("message", this.#onMessage);
		this.#socket.removeEventListener("close", this.#onClose);
		this.#socket.removeEventListener("error", this.#onClose);
		this.#signal?.removeEventListener("abort", this.#onAbort);
	}

	readonly #onMessage = (message: MessageEvent): void => {
		this.#restartIdleTimer();
		const event = parseEvent(message.data);
		this.#push(
			event === undefined
				? {
						kind: "failed",
						error: new Error("Invalid JSON in a Responses WebSocket event"),
						connectionLost: false,
					}
				: { kind: "event", event },
		);
	};

	readonly #onClose = (event: Event): void => {
		this.#push({
			kind: "failed",
			error: new Error(`WebSocket connection lost: ${describeEvent(event)}`),
			connectionLost: true,
		});
	};

	readonly #onAbort = (): void => {
		this.#push({ kind: "aborted" });
	};

	#restartIdleTimer(): void {
		clearTimeout(this.#idleTimer);
		const timeoutMs = this.#idleTimeoutMs;
		if (timeoutMs === undefined || timeoutMs <= 0) {
			return;
		}
		this.#idleTimer = setTimeout(() => {
			this.#push({
				kind: "failed",
				error: new Error(`WebSocket idle timeout after ${timeoutMs} ms`),
				connectionLost: true,
			});
		}, timeoutMs);
	}

	/** Delivers a read; after a failure or an abort, the reader delivers nothing more. */
	#push(read: ResponseRead): void {
		if (this.#ended) {
			return;
		}
		if (read.kind !== "event") {
			this.dispose();
		}
		const waiter = this.#waiter;
		this.#waiter = undefined;
		if (waiter === undefined) {
			this.#queue.push(read);
		} else {
			waiter(read);
		}
	}
}

/** Parses a WebSocket message into a Responses event; gives undefined for anything else. */
function parseEvent(data: unknown): ResponseEvent | undefined {
	if (typeof data !== "string") {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(data);
		return isResponseEvent(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Returns true for a JSON object with a string `type`, the shape of every Responses event. */
function isResponseEvent(value: unknown): value is ResponseEvent {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** Describes a `close` or `error` event; Node and Bun give these events different classes, so fields are read by name. */
function describeEvent(event: Event): string {
	const fields = event as Partial<{
		code: number;
		reason: string;
		message: string;
	}>;
	if (typeof fields.code === "number") {
		return `closed with code ${fields.code}${fields.reason ? ` (${fields.reason})` : ""}`;
	}
	return fields.message || event.type;
}
