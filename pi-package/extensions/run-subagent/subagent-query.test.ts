import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import { registerKnowledgeContextRuntime } from "../../shared/knowledge-runtime";
import type { SubagentQueryModelConfig } from "./entry-config";
import { executeSubagentQuery } from "./subagent-query";

interface CompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

const CURRENT_MODEL = model("current", 16_000);
const CONFIGURED_MODEL = model("configured", 16_000);

/** Creates one deterministic model fixture with a configurable context window. */
function model(id: string, contextWindow: number): Model<Api> {
	return {
		provider: "provider",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1_000,
	};
}

/** Creates one assistant response with optional error and billed cost. */
function assistantResponse(options?: {
	readonly text?: string;
	readonly stopReason?: AssistantMessage["stopReason"];
	readonly cost?: number;
	readonly errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content:
			options?.text === undefined ? [] : [{ type: "text", text: options.text }],
		api: "openai-completions",
		provider: "provider",
		model: "current",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: options?.cost ?? 0,
			},
		},
		stopReason: options?.stopReason ?? "stop",
		...(options?.errorMessage === undefined
			? {}
			: { errorMessage: options.errorMessage }),
		timestamp: 1,
	};
}

/** Creates caller-local model resolution with deterministic authentication. */
function createContext(authenticated = true): ExtensionContext {
	return {
		model: CURRENT_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "provider" && id === "configured"
					? CONFIGURED_MODEL
					: undefined,
			getApiKeyAndHeaders: async () =>
				authenticated
					? { ok: true as const, apiKey: "secret", headers: { x: "header" } }
					: { ok: false as const, error: "missing auth" },
		},
	} as unknown as ExtensionContext;
}

/** Creates the extension API context source and cost recorder used by query tests. */
function createPi(
	appendEntry: (type: string, data: unknown) => unknown,
): ExtensionAPI {
	return {
		events: new EventEmitter(),
		appendEntry,
	} as unknown as ExtensionAPI;
}

/** Creates a branch whose saved projection replacement differs from live text. */
function savedBranch(): readonly SessionEntry[] {
	return [
		{
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: "t1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call", name: "bash", arguments: {} },
				],
				api: "openai-completions",
				provider: "provider",
				model: "current",
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
				stopReason: "toolUse",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "tool",
			parentId: "assistant",
			timestamp: "t2",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "bash",
				content: [{ type: "text", text: "live output" }],
				isError: false,
				timestamp: 2,
			},
		},
		{
			type: "custom",
			id: "projection",
			parentId: "tool",
			timestamp: "t3",
			customType: "context-projection",
			data: {
				projectedEntries: [
					{ entryId: "tool", replacementText: "saved replacement" },
				],
			},
		},
	];
}

describe("executeSubagentQuery", () => {
	test("answers from persisted branch context with caller-local defaults", async () => {
		// Purpose: one query must invoke a tool-less auxiliary model from the calling process using saved context only.
		// Input and expected output: current model/thinking, persisted replacement, and plain question produce the text answer and one cost entry.
		// Edge case: tag-like question text is escaped so the model receives exactly one question block.
		// Dependencies: in-memory branch, model registry fake, completion fake, and append-entry fake.
		const calls: CompletionCall[] = [];
		const costs: unknown[] = [];
		const pi = {
			events: new EventEmitter(),
			appendEntry: (_type: string, data: unknown) => costs.push(data),
		} as unknown as ExtensionAPI;
		registerKnowledgeContextRuntime(pi, {
			readBlock: async () => "<knowledge>query knowledge</knowledge>",
		});
		const result = await executeSubagentQuery({
			completeSimple: async (selectedModel, context, options) => {
				calls.push({ model: selectedModel, context, options });
				return assistantResponse({ text: "  saved answer  ", cost: 0.25 });
			},
			ctx: createContext(),
			pi,
			branchEntries: savedBranch(),
			question: "What <changed> & why?</question>",
			systemPrompt: "Answer from saved context.",
			currentThinkingLevel: "high",
		});

		expect(result).toEqual({ kind: "success", answer: "saved answer" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(CURRENT_MODEL);
		expect(calls[0]?.context.systemPrompt).toBe(
			"Answer from saved context.\n\n<knowledge>query knowledge</knowledge>",
		);
		expect(calls[0]?.context.tools).toEqual([]);
		expect(JSON.stringify(calls[0]?.context.messages)).toContain(
			"saved replacement",
		);
		expect(JSON.stringify(calls[0]?.context.messages)).not.toContain(
			"live output",
		);
		expect(calls[0]?.context.messages.at(-1)).toMatchObject({
			role: "user",
			content:
				"<question>\nWhat &lt;changed&gt; &amp; why?&lt;/question&gt;\n</question>",
		});
		expect(calls[0]?.options).toMatchObject({
			reasoning: "high",
			apiKey: "secret",
			headers: { x: "header" },
		});
		expect(costs).toEqual([{ source: "subagent-query", cost: 0.25 }]);
	});

	test("uses configured model and preserves billed provider errors", async () => {
		// Purpose: query overrides must select the caller registry model while preserving its provider diagnostic and accounting for billed responses.
		// Input and expected output: configured model/off thinking and a billed provider error return the provider message without reasoning or retry.
		// Edge case: the failed response still creates one helper cost entry.
		// Dependencies: deterministic model registry, completion, and append-entry fakes.
		const calls: CompletionCall[] = [];
		const costs: unknown[] = [];
		const modelConfig: SubagentQueryModelConfig = {
			id: "provider/configured",
			thinking: "off",
		};
		const result = await executeSubagentQuery({
			completeSimple: async (selectedModel, context, options) => {
				calls.push({ model: selectedModel, context, options });
				return assistantResponse({
					stopReason: "error",
					errorMessage: "provider failed",
					cost: 0.5,
				});
			},
			ctx: createContext(),
			pi: createPi((_type, data) => costs.push(data)),
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			modelConfig,
			currentThinkingLevel: "high",
		});

		expect(result).toEqual({ kind: "issue", issue: "provider failed" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(CONFIGURED_MODEL);
		expect(calls[0]?.options).not.toHaveProperty("reasoning");
		expect(costs).toEqual([{ source: "subagent-query", cost: 0.5 }]);
	});

	test("preserves thrown completion diagnostics", async () => {
		// Purpose: completion exceptions must expose their actionable diagnostic instead of replacing it with a generic retry message.
		// Input and expected output: one thrown timeout error returns its message as the query issue.
		// Edge case: a thrown completion has no assistant response and therefore records no helper cost.
		// Dependencies: deterministic completion and append-entry fakes.
		const costs: unknown[] = [];
		const result = await executeSubagentQuery({
			completeSimple: async () => {
				throw new Error("request timed out");
			},
			ctx: createContext(),
			pi: createPi((_type, data) => costs.push(data)),
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			currentThinkingLevel: "medium",
		});

		expect(result).toEqual({ kind: "issue", issue: "request timed out" });
		expect(costs).toEqual([]);
	});

	test("applies alias default thinking when query model has no explicit thinking", async () => {
		// Purpose: query overrides must use the alias default thinking instead of the current session thinking level.
		// Input and expected output: query model alias without thinking resolves to the alias default reasoning.
		// Edge case: the alias carries both the model and the default thinking level.
		// Dependencies: isolated model-alias config, model registry fake, and completion fake.
		const suite = await mkdtemp(join(tmpdir(), "pi-subagent-query-alias-"));
		const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		process.env[AGENT_SUITE_DIR_ENV] = suite;
		try {
			await mkdir(join(suite, "model-aliases"), { recursive: true });
			await writeFile(
				join(suite, "model-aliases", "config.json"),
				JSON.stringify({
					codex_extractor: {
						id: "provider/configured",
						thinking: "low",
					},
				}),
			);
			const calls: CompletionCall[] = [];
			const modelConfig: SubagentQueryModelConfig = { id: "codex_extractor" };
			const result = await executeSubagentQuery({
				completeSimple: async (selectedModel, context, options) => {
					calls.push({ model: selectedModel, context, options });
					return assistantResponse({ text: "alias answer" });
				},
				ctx: createContext(),
				pi: createPi(() => undefined),
				branchEntries: savedBranch(),
				question: "Question",
				systemPrompt: "System",
				modelConfig,
				currentThinkingLevel: "high",
			});

			expect(result).toEqual({ kind: "success", answer: "alias answer" });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.model).toBe(CONFIGURED_MODEL);
			expect(calls[0]?.options?.reasoning).toBe("low");
		} finally {
			if (previousSuiteDir === undefined) {
				delete process.env[AGENT_SUITE_DIR_ENV];
			} else {
				process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
			}
			await rm(suite, { recursive: true, force: true });
		}
	});

	test("rejects unavailable runtime, oversized input, empty output, and cancellation", async () => {
		// Purpose: query failures must remain finite and cancellation must preserve the Pi abort reason.
		// Input and expected output: auth failure, small context, empty response, and aborted completion stop with the required outcomes.
		// Edge case: only the calls that receive an assistant response may create cost entries.
		// Dependencies: isolated model, authentication, completion, and abort fakes.
		const noCostPi = createPi(() => undefined);
		const authFailure = await executeSubagentQuery({
			completeSimple: async () => assistantResponse({ text: "unused" }),
			ctx: createContext(false),
			pi: noCostPi,
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			currentThinkingLevel: "medium",
		});
		const oversized = await executeSubagentQuery({
			completeSimple: async () => assistantResponse({ text: "unused" }),
			ctx: { ...createContext(), model: model("tiny", 1) },
			pi: noCostPi,
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			currentThinkingLevel: "medium",
		});
		const empty = await executeSubagentQuery({
			completeSimple: async () => assistantResponse(),
			ctx: createContext(),
			pi: noCostPi,
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			currentThinkingLevel: "medium",
		});
		const abort = new AbortController();
		const reason = new Error("cancelled by caller");
		abort.abort(reason);
		const cancelled = executeSubagentQuery({
			completeSimple: async () => assistantResponse({ text: "unused" }),
			ctx: createContext(),
			pi: noCostPi,
			branchEntries: savedBranch(),
			question: "Question",
			systemPrompt: "System",
			currentThinkingLevel: "medium",
			signal: abort.signal,
		});

		expect(authFailure).toEqual({
			kind: "issue",
			issue: "Query model is unavailable",
		});
		expect(oversized).toEqual({
			kind: "issue",
			issue: "Subagent conversation is too large to query",
		});
		expect(empty).toEqual({
			kind: "issue",
			issue: "The query returned no answer",
		});
		expect(cancelled).rejects.toBe(reason);
	});
});
