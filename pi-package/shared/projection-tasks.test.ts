import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AuxiliaryLlmContext } from "./auxiliary-llm";
import {
	type ProjectionTasksRequestOptions,
	requestProjectionTasks,
} from "./projection-tasks";
import {
	createDefaultToolResultSummaryConfig,
	type ToolResultSummaryConfig,
} from "./tool-result-summary";

/** Captures a model request for assertions. */
interface RecordedRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

/** Creates one deterministic model fixture. */
function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

/** Creates a model context where only the listed provider/model pairs exist. */
function createModelContext(
	currentModel: Model<Api>,
	knownModels: readonly Model<Api>[] = [],
): AuxiliaryLlmContext {
	return {
		model: currentModel,
		modelRegistry: {
			find: (provider, id) =>
				knownModels.find(
					(model) => model.provider === provider && model.id === id,
				),
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	};
}

/** Creates one assistant response fixture. */
function createResponse(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Goal: finish." }],
		api: "fake-api",
		provider: "fake",
		model: "fake",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

/** Creates summary settings without retry delay, with optional overrides. */
function summaryConfig(
	overrides: Partial<ToolResultSummaryConfig> = {},
): ToolResultSummaryConfig {
	return {
		...createDefaultToolResultSummaryConfig(true),
		retryCount: 0,
		retryDelayMs: 0,
		...overrides,
	};
}

/** Runs one request with a recording completion and returns what the module did. */
async function runRequest(
	respond: (request: RecordedRequest) => Promise<AssistantMessage>,
	overrides: Partial<ProjectionTasksRequestOptions> = {},
): Promise<{
	readonly result: Awaited<ReturnType<typeof requestProjectionTasks>>;
	readonly requests: RecordedRequest[];
	readonly costs: AssistantMessage[];
}> {
	const requests: RecordedRequest[] = [];
	const costs: AssistantMessage[] = [];
	const result = await requestProjectionTasks({
		messages: [{ role: "user", content: "Do the work.", timestamp: 1 }],
		modelContext: createModelContext(createModel("fake", "current")),
		config: summaryConfig(),
		currentThinking: undefined,
		signal: undefined,
		completeSimple: async (model, context, options) => {
			const request = { model, context, options };
			requests.push(request);
			return respond(request);
		},
		recordCost: (message) => {
			costs.push(message);
		},
		...overrides,
	});
	return { result, requests, costs };
}

describe("requestProjectionTasks", () => {
	test("drops system messages and sends the session before the task prompt without tools", async () => {
		// Purpose: the task model must read the conversation only, without primary system state.
		// Input and expected output: two user messages and one system message become the two user messages plus one final user message.
		// Edge case: the system message must not reach the request in any position.
		// Dependencies: fake completion and fake model registry.
		const messages: AgentMessage[] = [
			{ role: "user", content: "First request.", timestamp: 1 },
			{ role: "system", content: "Primary system state.", timestamp: 2 },
			{ role: "user", content: "Second request.", timestamp: 3 },
		];

		const { requests } = await runRequest(async () => createResponse(), {
			messages,
		});

		const sent = requests[0]?.context;
		expect(sent?.tools).toEqual([]);
		expect(sent?.messages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"user",
		]);
		expect(JSON.stringify(sent?.messages)).not.toContain(
			"Primary system state.",
		);
	});

	test("uses the configured model and falls back to the current thinking level", async () => {
		// Purpose: the task model follows the configured model id and keeps the current thinking level when none is configured.
		// Input and expected output: a configured provider/model id selects that model, and current thinking becomes the request reasoning.
		// Edge case: the current model is also registered and must not be used.
		// Dependencies: fake completion and fake model registry.
		const configured = createModel("other", "task-model");
		const current = createModel("fake", "current");

		const { requests } = await runRequest(async () => createResponse(), {
			modelContext: createModelContext(current, [configured, current]),
			config: summaryConfig({ model: { id: "other/task-model" } }),
			currentThinking: "high",
		});

		expect(requests[0]?.model.id).toBe("task-model");
		expect(requests[0]?.options?.reasoning).toBe("high");
	});

	test("lets summary.tasks.model replace summary.model as a whole", async () => {
		// Purpose: the task model setting must not inherit fields of the summary model.
		// Input and expected output: summary.model names a model with high thinking and summary.tasks.model sets only low thinking, so the current model runs with low thinking.
		// Edge case: without summary.tasks.model the summary model applies.
		// Dependencies: fake completion and fake model registry.
		const summaryModel = createModel("other", "summary-model");
		const current = createModel("fake", "current");
		const modelContext = createModelContext(current, [summaryModel, current]);
		const model = { id: "other/summary-model", thinking: "high" } as const;

		const replaced = await runRequest(async () => createResponse(), {
			modelContext,
			config: summaryConfig({ model, tasks: { model: { thinking: "low" } } }),
		});
		expect(replaced.requests[0]?.model.id).toBe("current");
		expect(replaced.requests[0]?.options?.reasoning).toBe("low");

		const inherited = await runRequest(async () => createResponse(), {
			modelContext,
			config: summaryConfig({ model, tasks: {} }),
		});
		expect(inherited.requests[0]?.model.id).toBe("summary-model");
		expect(inherited.requests[0]?.options?.reasoning).toBe("high");
	});

	test("prefers the configured thinking level over the current one", async () => {
		// Purpose: configured thinking must override the main agent level.
		// Input and expected output: configured low thinking wins over current high thinking.
		// Edge case: only thinking is configured, so the model stays the current one.
		// Dependencies: fake completion and fake model registry.
		const { requests } = await runRequest(async () => createResponse(), {
			config: summaryConfig({ model: { thinking: "low" } }),
			currentThinking: "high",
		});

		expect(requests[0]?.model.id).toBe("current");
		expect(requests[0]?.options?.reasoning).toBe("low");
	});

	test("returns the trimmed task text and records the response cost", async () => {
		// Purpose: a successful request returns the text and exposes the response for usage accounting.
		// Input and expected output: text with surrounding whitespace is trimmed, and the response reaches recordCost once.
		// Edge case: several text blocks are joined in provider order.
		// Dependencies: fake completion.
		const response = createResponse({
			content: [
				{ type: "text", text: "  Goal: a" },
				{ type: "text", text: "Tasks: b  " },
			],
		});

		const { result, costs } = await runRequest(async () => response);

		expect(result).toEqual({ kind: "success", text: "Goal: a\nTasks: b" });
		expect(costs).toEqual([response]);
	});

	test("reports a failure with an issue for unresolved model, provider error, empty text, and thrown errors", async () => {
		// Purpose: every failure path must return an issue text that a caller can show.
		// Input and expected output: each failure source returns kind failure with its own issue text.
		// Edge case: a provider error without a message still returns a non-empty issue.
		// Dependencies: fake completion and fake model registry.
		const unresolved = await runRequest(async () => createResponse(), {
			config: summaryConfig({ model: { id: "other/missing" } }),
		});
		expect(unresolved.result).toEqual({
			kind: "failure",
			issue: "model other/missing was not found",
		});
		expect(unresolved.requests).toHaveLength(0);

		const providerError = await runRequest(async () =>
			createResponse({ stopReason: "error", errorMessage: "quota exceeded" }),
		);
		expect(providerError.result).toEqual({
			kind: "failure",
			issue: "quota exceeded",
		});
		expect(providerError.costs).toHaveLength(1);

		const silentError = await runRequest(async () =>
			createResponse({ stopReason: "error" }),
		);
		expect(silentError.result.kind).toBe("failure");
		if (silentError.result.kind === "failure") {
			expect(silentError.result.issue.length).toBeGreaterThan(0);
		}

		const empty = await runRequest(async () =>
			createResponse({ content: [{ type: "text", text: "  " }] }),
		);
		expect(empty.result.kind).toBe("failure");

		const thrown = await runRequest(async () => {
			throw new Error("socket closed");
		});
		expect(thrown.result).toEqual({ kind: "failure", issue: "socket closed" });
	});

	test("reports an abort without a request when the signal is already aborted", async () => {
		// Purpose: a user abort must stop the task request before it starts.
		// Input and expected output: an aborted signal returns kind aborted and sends no request.
		// Edge case: model resolution must not run for an aborted run.
		// Dependencies: fake completion and AbortController.
		const controller = new AbortController();
		controller.abort();

		const { result, requests } = await runRequest(
			async () => createResponse(),
			{ signal: controller.signal },
		);

		expect(result).toEqual({ kind: "aborted" });
		expect(requests).toHaveLength(0);
	});

	test("reports an abort when the response or the thrown error shows cancellation", async () => {
		// Purpose: an abort during the request must not become a failure with an issue.
		// Input and expected output: an aborted stop reason and a thrown AbortError both return kind aborted, and the response is still recorded.
		// Edge case: the signal itself stays unaborted.
		// Dependencies: fake completion.
		const stopped = await runRequest(async () =>
			createResponse({ stopReason: "aborted" }),
		);
		expect(stopped.result).toEqual({ kind: "aborted" });
		expect(stopped.costs).toHaveLength(1);

		const thrown = await runRequest(async () => {
			throw new DOMException("aborted", "AbortError");
		});
		expect(thrown.result).toEqual({ kind: "aborted" });
	});
	test("retries failures with the retry settings and returns the last issue", async () => {
		// Purpose: provider errors, empty answers, and thrown errors follow the retry count.
		// Input and expected output: retryCount 2 sends three requests and returns the issue of the last one; a later success ends the retries.
		// Edge case: every response, including failed ones, reaches recordCost.
		// Dependencies: fake completion.
		let calls = 0;
		const failing = await runRequest(
			async () => {
				calls += 1;
				return createResponse({
					stopReason: "error",
					errorMessage: `failure ${calls}`,
				});
			},
			{ config: summaryConfig({ retryCount: 2 }) },
		);
		expect(failing.requests).toHaveLength(3);
		expect(failing.costs).toHaveLength(3);
		expect(failing.result).toEqual({ kind: "failure", issue: "failure 3" });

		let attempts = 0;
		const recovering = await runRequest(
			async () => {
				attempts += 1;
				return attempts === 1
					? createResponse({ stopReason: "error", errorMessage: "temporary" })
					: createResponse();
			},
			{ config: summaryConfig({ retryCount: 2 }) },
		);
		expect(recovering.requests).toHaveLength(2);
		expect(recovering.result.kind).toBe("success");
	});

	test("does not retry an abort", async () => {
		// Purpose: an abort must end the request even when retries remain.
		// Input and expected output: a thrown AbortError sends one request and returns kind aborted.
		// Edge case: retryCount is positive.
		// Dependencies: fake completion.
		const { result, requests } = await runRequest(
			async () => {
				throw new DOMException("aborted", "AbortError");
			},
			{ config: summaryConfig({ retryCount: 3 }) },
		);

		expect(result).toEqual({ kind: "aborted" });
		expect(requests).toHaveLength(1);
	});

	test("fails without a request or retry when the session does not fit the task model window", async () => {
		// Purpose: an oversized session must be reported before any provider call.
		// Input and expected output: a model window of one token returns kind failure and sends no request.
		// Edge case: retryCount is positive and must not matter.
		// Dependencies: fake completion and fake model registry.
		const tiny = { ...createModel("fake", "tiny"), contextWindow: 1 };

		const { result, requests } = await runRequest(
			async () => createResponse(),
			{
				modelContext: createModelContext(tiny),
				config: summaryConfig({ retryCount: 2 }),
			},
		);

		expect(result.kind).toBe("failure");
		expect(requests).toHaveLength(0);
	});
});
