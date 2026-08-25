import { expect, test } from "bun:test";
import type {
	AssistantMessage,
	Model,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

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
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

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
