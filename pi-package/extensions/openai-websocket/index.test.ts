import { afterEach, describe, expect, jest, test } from "bun:test";
import { createServer, type Server as NetServer } from "node:net";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	getModels,
	isRetryableAssistantError,
	normalizeContext,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	errorEvent,
	type FakeResponsesWebSocketServer,
	type FakeServerReply,
	responseUsage,
	startFakeResponsesWebSocketServer,
	textResponseEvents,
	toolCallResponseEvents,
} from "../../../test/support/fake-responses-websocket-server";
import { sseResponse } from "../../../test/support/sse-response";
import openAIWebSocket, { createOpenAIWebSocketExtension } from "./index";

type Handler = (...args: unknown[]) => unknown;

/** Stream options that replace the defaults of the harness; an undefined value removes the default. */
type OptionOverrides = {
	readonly [K in keyof SimpleStreamOptions]?:
		| SimpleStreamOptions[K]
		| undefined;
};

interface ExtensionHarness {
	readonly provider: ProviderConfig;
	readonly warnings: string[];
	emit(eventName: string): Promise<void>;
	request(
		context: TranscriptContext,
		options?: OptionOverrides,
	): Promise<AssistantMessage>;
}

const READ_TOOL = {
	name: "read",
	description: "Reads a file",
	parameters: Type.Object({ path: Type.String() }),
};

const SESSION_ID = "session-1";
const servers: FakeResponsesWebSocketServer[] = [];
const httpRequests: Record<string, unknown>[] = [];

afterEach(async () => {
	jest.useRealTimers();
	httpRequests.length = 0;
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function startServer(
	reply: (request: Record<string, unknown>, index: number) => FakeServerReply,
): FakeResponsesWebSocketServer {
	const server = startFakeResponsesWebSocketServer(reply);
	servers.push(server);
	return server;
}

/** Fetch that answers each HTTP request with one text response, as the Responses API does over HTTP. */
const httpFetch: typeof fetch = Object.assign(
	async (_input: RequestInfo | URL, init?: RequestInit) => {
		httpRequests.push(
			JSON.parse(String(init?.body)) as Record<string, unknown>,
		);
		return sseResponse(
			textResponseEvents(`http_${httpRequests.length}`, "over http"),
		);
	},
	{ preconnect: fetch.preconnect },
);

function createModel(baseUrl: string): Model<Api> {
	const model = getModels("openai").find(
		(candidate) => candidate.api === "openai-responses",
	);
	if (model === undefined) {
		throw new Error("pi has no built-in OpenAI Responses model");
	}
	// A large window keeps pi's max_output_tokens the same for every request of a test.
	return { ...model, baseUrl, contextWindow: 1_000_000 };
}

function loadExtension(
	baseUrl: string,
	extension: (pi: ExtensionAPI) => void = openAIWebSocket,
): ExtensionHarness {
	const handlers: { eventName: string; handler: Handler }[] = [];
	const warnings: string[] = [];
	let provider: ProviderConfig | undefined;
	const pi = {
		on: ((eventName: string, handler: Handler) => {
			handlers.push({ eventName, handler });
		}) as ExtensionAPI["on"],
		registerProvider: ((name: string, config: ProviderConfig) => {
			expect(name).toBe("openai");
			provider = config;
		}) as ExtensionAPI["registerProvider"],
	} as ExtensionAPI;
	extension(pi);
	if (provider === undefined) {
		throw new Error("extension registered no provider");
	}
	const registered = provider;
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => warnings.push(message) },
	};
	const model = createModel(baseUrl);
	return {
		provider: registered,
		warnings,
		emit: async (eventName) => {
			for (const entry of handlers.filter((h) => h.eventName === eventName)) {
				await entry.handler({ type: eventName }, ctx);
			}
		},
		request: (context, options = {}) => {
			if (registered.streamSimple === undefined) {
				throw new Error("extension registered no stream function");
			}
			const merged = {
				apiKey: "sk-test",
				sessionId: SESSION_ID,
				transport: "auto",
				fetch: httpFetch,
				...options,
			};
			const defined = Object.fromEntries(
				Object.entries(merged).filter(([, value]) => value !== undefined),
			) as SimpleStreamOptions;
			return registered.streamSimple(model, context, defined).result();
		},
	};
}

function userContext(text: string): Context {
	return {
		systemPrompt: "You are a test agent.",
		tools: [READ_TOOL],
		messages: [{ role: "user", content: text, timestamp: 1 }],
	};
}

/** Context of the request that follows a tool call: the previous context, the answer, and the tool result. */
function continueWithToolResult(
	previous: Context,
	answer: AssistantMessage,
): Context {
	const toolCall = answer.content.find((block) => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") {
		throw new Error("answer has no tool call");
	}
	return {
		...previous,
		messages: [
			...previous.messages,
			answer,
			{
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "file content" }],
				isError: false,
				timestamp: 2,
			},
		],
	};
}

function toolTurnReplies(
	request: Record<string, unknown>,
	index: number,
): FakeServerReply {
	if (index === 0) {
		return {
			kind: "events",
			events: toolCallResponseEvents("resp_1", "read", { path: "a.ts" }),
		};
	}
	const previous = request["previous_response_id"];
	return {
		kind: "events",
		events: textResponseEvents(
			`resp_${index + 1}`,
			previous === undefined ? "full" : "incremental",
			responseUsage(1000, 990),
		),
	};
}

function textOf(message: AssistantMessage): string {
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

async function runToolTurn(
	harness: ExtensionHarness,
	first: Context = userContext("read a.ts"),
): Promise<{ firstAnswer: AssistantMessage; secondAnswer: AssistantMessage }> {
	const firstAnswer = await harness.request(normalizeContext(first));
	const secondAnswer = await harness.request(
		normalizeContext(continueWithToolResult(first, firstAnswer)),
	);
	return { firstAnswer, secondAnswer };
}

describe("openai-websocket incremental requests", () => {
	test("sends the request after a tool call as the tool result and the previous response ID on the same connection", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);

		const { firstAnswer, secondAnswer } = await runToolTurn(harness);

		expect(firstAnswer.stopReason).toBe("toolUse");
		expect(firstAnswer.content).toContainEqual(
			expect.objectContaining({
				type: "toolCall",
				name: "read",
				arguments: { path: "a.ts" },
			}),
		);
		expect(textOf(secondAnswer)).toBe("incremental");
		expect(secondAnswer.usage.cacheRead).toBe(990);
		expect(server.handshakes).toHaveLength(1);
		const [first, second] = server.requests.map((r) => r.message);
		expect(first?.["type"]).toBe("response.create");
		expect(first).not.toHaveProperty("stream");
		expect(first).not.toHaveProperty("previous_response_id");
		expect(second?.["previous_response_id"]).toBe("resp_1");
		expect(second?.["input"]).toEqual([
			expect.objectContaining({
				type: "function_call_output",
				call_id: "call_resp_1",
			}),
		]);
		expect(httpRequests).toHaveLength(0);
	});

	test("sends a full request when the history no longer continues the previous response", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);
		await harness.request(normalizeContext(userContext("read a.ts")));

		const answer = await harness.request(
			normalizeContext(userContext("compacted history")),
		);

		expect(textOf(answer)).toBe("full");
		expect(server.requests[1]?.message).not.toHaveProperty(
			"previous_response_id",
		);
	});

	test("sends a full request when a request field other than input changes", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);
		const first = userContext("read a.ts");
		const firstAnswer = await harness.request(normalizeContext(first));

		const answer = await harness.request(
			normalizeContext(continueWithToolResult(first, firstAnswer)),
			{ maxTokens: 77 },
		);

		expect(textOf(answer)).toBe("full");
	});

	test("resends the full request on the same connection when the server lost the previous response", async () => {
		const server = startServer((request, index) =>
			index === 1
				? {
						kind: "events",
						events: [
							errorEvent(
								400,
								"previous_response_not_found",
								"Previous response not found.",
							),
						],
					}
				: toolTurnReplies(request, index),
		);
		const harness = loadExtension(server.baseUrl);

		const { secondAnswer } = await runToolTurn(harness);

		expect(textOf(secondAnswer)).toBe("full");
		expect(server.handshakes).toHaveLength(1);
		expect(server.requests[1]?.message).toHaveProperty("previous_response_id");
		expect(server.requests[2]?.message).not.toHaveProperty(
			"previous_response_id",
		);
	});
});

describe("openai-websocket connections", () => {
	test("opens a new connection and repeats the request once when the connection reached its time limit", async () => {
		const server = startServer((request, index) =>
			index === 1
				? {
						kind: "events",
						events: [
							errorEvent(
								400,
								"websocket_connection_limit_reached",
								"Responses websocket connection limit reached (60 minutes).",
							),
						],
					}
				: toolTurnReplies(request, index),
		);
		const harness = loadExtension(server.baseUrl);

		const { secondAnswer } = await runToolTurn(harness);

		expect(textOf(secondAnswer)).toBe("full");
		expect(server.handshakes).toHaveLength(2);
		expect(server.requests[2]?.connectionId).toBe(1);
		expect(httpRequests).toHaveLength(0);
	});

	test("sends the handshake with the request headers and without the beta header", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);

		await harness.request(normalizeContext(userContext("hi")));

		const headers = server.handshakes[0];
		expect(headers?.["authorization"]).toBe("Bearer sk-test");
		expect(headers?.["session_id"]).toBe(SESSION_ID);
		expect(headers).not.toHaveProperty("openai-beta");
		expect(headers).not.toHaveProperty("content-type");
	});

	test("opens one connection per request with transport websocket", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);
		const first = userContext("read a.ts");
		const firstAnswer = await harness.request(normalizeContext(first), {
			transport: "websocket",
		});

		const answer = await harness.request(
			normalizeContext(continueWithToolResult(first, firstAnswer)),
			{ transport: "websocket" },
		);

		expect(textOf(answer)).toBe("full");
		expect(server.handshakes).toHaveLength(2);
		await waitFor(() => server.closedConnections() === 2);
	});

	test("closes the connection of a request without a session ID after the response", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);

		await harness.request(normalizeContext(userContext("hi")), {
			sessionId: undefined,
		});

		await waitFor(() => server.closedConnections() === 1);
	});

	test("opens a second connection for a request that starts while the session connection is busy", async () => {
		const server = startServer((_request, index) =>
			index === 0
				? {
						kind: "events",
						events: textResponseEvents("resp_1", "slow").slice(0, 1),
					}
				: { kind: "events", events: textResponseEvents("resp_2", "second") },
		);
		const harness = loadExtension(server.baseUrl);
		const first = harness.request(normalizeContext(userContext("slow")));
		await waitFor(() => server.requests.length === 1);

		const second = await harness.request(normalizeContext(userContext("x")));

		expect(textOf(second)).toBe("second");
		expect(server.requests[1]?.connectionId).toBe(1);
		await harness.emit("session_shutdown");
		expect((await first).stopReason).toBe("error");
	});

	test("closes all connections on session shutdown", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);
		await harness.request(normalizeContext(userContext("hi")));

		await harness.emit("session_shutdown");

		await waitFor(() => server.closedConnections() === 1);
	});

	test("closes a connection after five idle minutes and does not reuse a connection older than 55 minutes", async () => {
		jest.useFakeTimers({ now: 0 });
		const server = startServer((_request, index) => ({
			kind: "events",
			events: textResponseEvents(`resp_${index}`, "ok"),
		}));
		const harness = loadExtension(server.baseUrl);
		await harness.request(normalizeContext(userContext("hi")));

		jest.advanceTimersByTime(6 * 60_000);
		await waitFor(() => server.closedConnections() === 1);

		await harness.request(normalizeContext(userContext("again")));
		for (let minute = 4; minute <= 56; minute += 4) {
			jest.advanceTimersByTime(4 * 60_000);
			await harness.request(normalizeContext(userContext(`at ${minute}`)));
		}
		expect(server.handshakes).toHaveLength(3);
	});
});

describe("openai-websocket failures", () => {
	test("completes the request over HTTP, warns once, and keeps the session on HTTP when the handshake fails", async () => {
		const server = startServer(toolTurnReplies);
		server.rejectHandshakes();
		const harness = loadExtension(server.baseUrl);
		await harness.emit("session_start");

		const first = await harness.request(normalizeContext(userContext("hi")));
		const second = await harness.request(normalizeContext(userContext("x")));

		expect(textOf(first)).toBe("over http");
		expect(textOf(second)).toBe("over http");
		expect(httpRequests).toHaveLength(2);
		expect(harness.warnings).toHaveLength(1);
	});

	test("completes the request over HTTP when the handshake exceeds the connect timeout", async () => {
		const silentServer = await startSilentTcpServer();
		try {
			const address = silentServer.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const harness = loadExtension(`http://127.0.0.1:${port}/v1`);

			const answer = await harness.request(
				normalizeContext(userContext("hi")),
				{
					websocketConnectTimeoutMs: 100,
				},
			);

			expect(textOf(answer)).toBe("over http");
		} finally {
			silentServer.close();
		}
	});

	test("completes the request over HTTP when the connection closes before the first event", async () => {
		const server = startServer(() => ({ kind: "close" }));
		const harness = loadExtension(server.baseUrl);

		const answer = await harness.request(normalizeContext(userContext("hi")));

		expect(textOf(answer)).toBe("over http");
		expect(httpRequests).toHaveLength(1);
	});

	test("ends the response with a retryable error and moves the session to HTTP when the connection fails after the response started", async () => {
		const server = startServer(() => ({
			kind: "events-then-close",
			events: textResponseEvents("resp_1", "partial").slice(0, 2),
		}));
		const harness = loadExtension(server.baseUrl);

		const failed = await harness.request(normalizeContext(userContext("hi")));
		const next = await harness.request(normalizeContext(userContext("again")));

		expect(failed.stopReason).toBe("error");
		expect(isRetryableAssistantError(failed)).toBe(true);
		expect(textOf(next)).toBe("over http");
		expect(server.handshakes).toHaveLength(1);
	});

	test("ends the response with a retryable error when no event arrives within the idle timeout", async () => {
		const server = startServer(() => ({
			kind: "events",
			events: textResponseEvents("resp_1", "partial").slice(0, 1),
		}));
		const harness = loadExtension(server.baseUrl);

		const failed = await harness.request(normalizeContext(userContext("hi")), {
			timeoutMs: 200,
		});

		expect(failed.stopReason).toBe("error");
		expect(isRetryableAssistantError(failed)).toBe(true);
	});

	test("lets pi retry an API error that arrives before the response as over HTTP", async () => {
		const server = startServer((_request, index) =>
			index === 0
				? {
						kind: "events",
						events: [
							errorEvent(429, "rate_limit_exceeded", "Rate limit reached."),
						],
					}
				: {
						kind: "events",
						events: textResponseEvents("resp_2", "after retry"),
					},
		);
		const harness = loadExtension(server.baseUrl);

		const answer = await harness.request(normalizeContext(userContext("hi")), {
			maxRetries: 1,
			maxRetryDelayMs: 1,
		});

		expect(textOf(answer)).toBe("after retry");
		expect(httpRequests).toHaveLength(0);
	});

	test("reports an API error that arrives before the response and keeps the session on WebSocket", async () => {
		const server = startServer((_request, index) =>
			index === 0
				? {
						kind: "events",
						events: [errorEvent(400, "invalid_value", "Bad request field.")],
					}
				: { kind: "events", events: textResponseEvents("resp_2", "ok") },
		);
		const harness = loadExtension(server.baseUrl);

		const failed = await harness.request(normalizeContext(userContext("hi")));
		const next = await harness.request(normalizeContext(userContext("again")));

		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("Bad request field.");
		expect(textOf(next)).toBe("ok");
	});

	test("stops the response on user abort and answers the next request on a new connection", async () => {
		const controller = new AbortController();
		const server = startServer((_request, index) =>
			index === 0
				? {
						kind: "events",
						events: textResponseEvents("resp_1", "partial").slice(0, 1),
					}
				: { kind: "events", events: textResponseEvents("resp_2", "ok") },
		);
		const harness = loadExtension(server.baseUrl);

		const aborted = await harness.request(normalizeContext(userContext("hi")), {
			signal: controller.signal,
			onProviderStreamEvent: () => controller.abort(),
		});
		const next = await harness.request(normalizeContext(userContext("again")));

		expect(aborted.stopReason).toBe("aborted");
		expect(textOf(next)).toBe("ok");
		expect(server.handshakes).toHaveLength(2);
		expect(server.requests[1]?.message).not.toHaveProperty(
			"previous_response_id",
		);
	});
});

describe("openai-websocket HTTP mode", () => {
	test("sends requests over HTTP with transport sse", async () => {
		const server = startServer(toolTurnReplies);
		const harness = loadExtension(server.baseUrl);

		const answer = await harness.request(normalizeContext(userContext("hi")), {
			transport: "sse",
		});

		expect(textOf(answer)).toBe("over http");
		expect(server.handshakes).toHaveLength(0);
	});

	test("warns and moves the session to HTTP when pi does not pass the injected fetch to the request", async () => {
		const server = startServer(toolTurnReplies);
		const api = openAIResponsesApi();
		const harness = loadExtension(
			server.baseUrl,
			createOpenAIWebSocketExtension({
				responsesApi: {
					streamSimple: (model, context, options) =>
						api.streamSimple(model, context, { ...options, fetch: httpFetch }),
				},
			}),
		);
		await harness.emit("session_start");

		await harness.request(normalizeContext(userContext("hi")));

		expect(harness.warnings).toHaveLength(1);
		expect(server.handshakes).toHaveLength(0);
	});
});

/** Waits for socket events; `setImmediate` keeps working under fake timers, where `Bun.sleep` stops. */
async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 10_000; attempt++) {
		if (condition()) {
			return;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("condition not reached");
}

async function startSilentTcpServer(): Promise<NetServer> {
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return server;
}
