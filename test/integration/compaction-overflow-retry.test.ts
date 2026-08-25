import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	Model,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import compactionTrigger from "../../pi-package/extensions/compaction-trigger";
import { estimateSerializedInputTokens } from "../../pi-package/shared/context-size";

const MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "test",
	id: "test-model",
	name: "Test model",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
};

function userMessage(text: string, timestamp: number): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function assistantMessage(
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
	text = "response",
	inputTokens = 100,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: inputTokens,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

/** Builds one deterministic provider response without token or cost side effects. */
function fakeAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** Emits one complete assistant response through Pi's real stream contract. */
function completedStream(
	message: AssistantMessage,
	reason: "stop" | "toolUse",
) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason, message });
		stream.end();
	});
	return stream;
}

test("threshold interruption compacts and resumes through real AgentSession boundaries", async () => {
	// Purpose: prove Pi blocks the original threshold-crossing dispatch and resumes from compacted tool state.
	// Inputs and expected outputs: a deterministic tool result crosses the limit, one inline compaction persists, and one hidden continuation reaches the rebuilt request.
	// Edge cases: the provider stream function is entered with an aborted signal, which is not counted as an outbound dispatch.
	// Dependencies: real AgentSession lifecycle, in-memory session storage, temporary native settings, and inline extension contracts.
	const cwd = mkdtempSync(join(tmpdir(), "pi-compaction-trigger-session-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-compaction-trigger-agent-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;

	const toolResult = `retained-tool-state:${"result-data ".repeat(900)}`;
	const providerEntries: boolean[] = [];
	const contextTokens: number[] = [];
	const outboundMessages: unknown[][] = [];
	let providerDispatches = 0;
	let dispatchNumber = 0;
	let compactionCalls = 0;
	const model: Model<"openai-completions"> = {
		...MODEL,
		provider: "compaction-integration",
		id: "fake",
		contextWindow: 8_000,
		maxTokens: 500,
	};
	const sessionManager = SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 1_000,
			keepRecentTokens: 3_000,
		},
		retry: { enabled: false },
	});
	let session: AgentSession | undefined;
	const fakeStream = ((streamModel, context, options) => {
		const aborted = options?.signal?.aborted ?? false;
		providerEntries.push(aborted);
		if (aborted) {
			return completedStream(
				fakeAssistantMessage(streamModel, [], "aborted"),
				"stop",
			);
		}
		providerDispatches += 1;
		dispatchNumber += 1;
		outboundMessages.push(structuredClone(context.messages));
		if (dispatchNumber === 1) {
			return completedStream(
				fakeAssistantMessage(
					streamModel,
					[
						{
							type: "toolCall",
							id: "isolated-call",
							name: "isolated_result",
							arguments: {},
						},
					],
					"toolUse",
				),
				"toolUse",
			);
		}
		return completedStream(
			fakeAssistantMessage(
				streamModel,
				[{ type: "text", text: "continued" }],
				"stop",
			),
			"stop",
		);
	}) satisfies StreamFn;

	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				compaction: {
					enabled: true,
					reserveTokens: 1_000,
					keepRecentTokens: 3_000,
				},
			}),
		);
		sessionManager.appendMessage(userMessage("old task", 1));
		sessionManager.appendMessage(
			assistantMessage(
				"stop",
				2,
				`old-context:${"history-data ".repeat(2_300)}`,
				5_000,
			),
		);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "isolated_result",
						label: "Isolated result",
						description: "Return deterministic retained state.",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: toolResult }],
							details: {},
						}),
					});
					pi.on("context", (event, ctx) => {
						contextTokens.push(
							estimateSerializedInputTokens({
								systemPrompt: ctx.getSystemPrompt(),
								messages: convertToLlm(event.messages),
								tools: [],
							}),
						);
					});
					pi.registerProvider(model.provider, {
						name: "Compaction integration",
						baseUrl: "http://127.0.0.1:1/v1",
						apiKey: "test",
						api: model.api,
						models: [model],
						streamSimple: fakeStream,
					});
					pi.on("session_before_compact", (event) => {
						compactionCalls += 1;
						const currentTurn = event.branchEntries.find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								JSON.stringify(entry.message.content).includes(
									"Use isolated_result",
								),
						);
						if (currentTurn === undefined) {
							throw new Error(
								"current tool turn was not available for compaction",
							);
						}
						return {
							compaction: {
								summary: "Old task was compacted.",
								firstKeptEntryId: currentTurn.id,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
				compactionTrigger,
			],
		});
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: ["isolated_result"],
		}));
		// Pi owns the Agent, so the test replaces only its public stream contract.
		(
			session as unknown as {
				readonly agent: { streamFunction: StreamFn };
			}
		).agent.streamFunction = fakeStream;

		await session.prompt("Use isolated_result and continue from its result.");
		for (
			let attempt = 0;
			attempt < 100 && providerDispatches < 2;
			attempt += 1
		) {
			await Bun.sleep(10);
		}

		expect(contextTokens[0]).toBeLessThan(7_000);
		expect(contextTokens[1]).toBeGreaterThanOrEqual(7_000);
		expect(contextTokens[2]).toBeLessThan(7_000);
		expect(providerEntries).toEqual([false, true, false]);
		expect(providerDispatches).toBe(2);
		expect(compactionCalls).toBe(1);
		const entries = sessionManager.getEntries();
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(
			1,
		);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason === "aborted",
			),
		).toHaveLength(1);
		const continuationEntry = entries
			.filter((entry) => entry.type === "custom_message")
			.find((entry) => entry.customType === "compaction-trigger-continuation");
		expect(continuationEntry).toBeDefined();
		if (continuationEntry === undefined) {
			throw new Error("compaction continuation was not persisted");
		}
		expect(continuationEntry.display).toBeFalse();
		const rebuiltMessages = outboundMessages[1] ?? [];
		expect(JSON.stringify(rebuiltMessages)).toContain(
			JSON.stringify(continuationEntry.content),
		);
		expect(JSON.stringify(rebuiltMessages)).toContain(toolResult);
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		}
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("overflow compaction retries after passive context restoration", async () => {
	// Purpose: interrupted work must continue after compaction restores hidden extension context.
	// Input and expected output: willRetry true returns continuation while one custom context message is persisted without steering.
	// Edge case: session_compact runs while AgentSession still reports an active run.
	// Dependencies: real AgentSession auto-compaction and custom-message delivery control flow with an in-memory session.
	const sessionManager = SessionManager.inMemory(
		"/tmp/compaction-overflow-retry",
	);
	sessionManager.appendMessage(userMessage("old turn", 1));
	sessionManager.appendMessage(assistantMessage("stop", 2));
	sessionManager.appendMessage(userMessage("interrupted turn", 3));
	sessionManager.appendMessage(assistantMessage("error", 4));

	let steerCalls = 0;
	const agent = {
		state: { model: MODEL, messages: [] as unknown[] },
		hasQueuedMessages: () => steerCalls > 0,
		steer: () => {
			steerCalls += 1;
		},
		followUp: () => {},
	};
	const session = Object.create(AgentSession.prototype) as AgentSession;
	Object.assign(session, {
		agent,
		sessionManager,
		settingsManager: {
			getCompactionSettings: () => ({
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		},
		_isAgentRunActive: true,
		_pendingNextTurnMessages: [],
		_eventListeners: new Set(),
		_getSummarizationRequestAuth: async () => ({ model: MODEL }),
		_extensionRunner: {
			hasHandlers: (eventName: string) =>
				eventName === "session_before_compact",
			emit: async (event: Record<string, unknown>) => {
				if (event["type"] === "session_before_compact") {
					const preparation = event["preparation"] as {
						readonly firstKeptEntryId: string;
						readonly tokensBefore: number;
					};
					return {
						compaction: {
							summary: "summary",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					};
				}
				if (event["type"] === "session_compact") {
					await session.sendCustomMessage(
						{
							customType: "restored-context",
							content: "context",
							display: false,
							details: {},
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
				}
				return undefined;
			},
		},
	});

	const continuation = await (
		session as unknown as {
			_runAutoCompaction(
				reason: "overflow",
				willRetry: boolean,
			): Promise<boolean>;
		}
	)._runAutoCompaction("overflow", true);

	expect(continuation).toBe(true);
	expect(steerCalls).toBe(0);
	expect(
		sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message")
			.map((entry) => entry.customType),
	).toEqual(["restored-context"]);
});
