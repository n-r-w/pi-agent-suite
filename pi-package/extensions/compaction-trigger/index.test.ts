import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type CompactOptions,
	calculateContextTokens,
	convertToLlm,
	type ExtensionAPI,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import compactionTrigger from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const CONTINUATION_TYPE = "compaction-trigger-continuation";
const DIAGNOSTIC_TYPE = "compaction-trigger-diagnostic";
const RESERVE_TOKENS = 100;
const tempDirs: string[] = [];
const previousAgentDir = process.env[AGENT_DIR_ENV];

afterEach(async () => {
	if (previousAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = previousAgentDir;
	}
	await Promise.all(
		tempDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

/** Captures one event registration for direct handler invocation. */
interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: (event: unknown, ctx: TestContext) => unknown;
}

/** Records custom message content and delivery fields sent by the extension. */
interface SentMessage {
	readonly message: {
		readonly customType: string;
		readonly content: string;
		readonly display: boolean;
	};
	readonly options:
		| {
				readonly triggerTurn?: boolean;
				readonly deliverAs?: "steer" | "followUp" | "nextTurn";
		  }
		| undefined;
}

/** Exposes the observed calls on the minimal ExtensionAPI fake. */
interface TestPi extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly sentMessages: SentMessage[];
}

/** Exposes request controls and lifecycle calls on the ExtensionContext fake. */
interface TestContext {
	readonly cwd: string;
	model: Model<Api> | undefined;
	readonly signal: AbortSignal | undefined;
	readonly abortCalls: { count: number };
	readonly compactCalls: CompactOptions[];
	abort(): void;
	compact(options?: CompactOptions): void;
	getSystemPrompt(): string;
}

/** Creates an isolated native settings location for one extension scenario. */
async function createSettingsFixture(settings: unknown): Promise<{
	readonly agentDir: string;
	readonly cwd: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-compaction-trigger-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	process.env[AGENT_DIR_ENV] = agentDir;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { agentDir, cwd };
}

/** Replaces native settings inside an existing isolated fixture. */
async function writeSettings(
	agentDir: string,
	settings: unknown,
): Promise<void> {
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
}

/** Creates the extension API observations needed by lifecycle behavior tests. */
function createPi(): TestPi {
	const handlers: RegisteredHandler[] = [];
	const sentMessages: SentMessage[] = [];
	return {
		handlers,
		sentMessages,
		on(eventName: string, handler: RegisteredHandler["handler"]): void {
			handlers.push({ eventName, handler });
		},
		sendMessage(
			message: SentMessage["message"],
			options?: SentMessage["options"],
		): void {
			sentMessages.push({ message, options });
		},
		getActiveTools(): string[] {
			return [];
		},
		getAllTools(): [] {
			return [];
		},
	} as unknown as TestPi;
}

/** Creates an active request context with observable abort and compaction calls. */
function createContext(
	cwd: string,
	contextWindow: number | undefined,
	hasActiveSignal = true,
): TestContext {
	const controller = new AbortController();
	const abortCalls = { count: 0 };
	const compactCalls: CompactOptions[] = [];
	return {
		cwd,
		model:
			contextWindow === undefined
				? undefined
				: ({ contextWindow } as Model<Api>),
		signal: hasActiveSignal ? controller.signal : undefined,
		abortCalls,
		compactCalls,
		abort(): void {
			abortCalls.count += 1;
			controller.abort();
		},
		compact(options: CompactOptions = {}): void {
			compactCalls.push(options);
		},
		getSystemPrompt(): string {
			return "system";
		},
	};
}

/** Creates one provider-visible user message fixture. */
function userMessage(text = "continue the current task"): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

/** Creates one successful assistant response with provider-reported context usage. */
function assistantMessage(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "provider response" }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-test",
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** Computes the exact threshold fixture from the production estimator inputs. */
function estimatedTokens(messages: AgentMessage[]): number {
	return estimateSerializedInputTokens({
		systemPrompt: "system",
		messages: convertToLlm(messages),
		tools: [],
	});
}

/** Installs the extension and returns safe no-op fallbacks for missing handlers. */
function install(pi = createPi()): {
	readonly pi: TestPi;
	readonly context: RegisteredHandler["handler"];
	readonly agentSettled: RegisteredHandler["handler"];
	readonly sessionCompact: RegisteredHandler["handler"];
	readonly sessionStart: RegisteredHandler["handler"];
} {
	compactionTrigger(pi);
	const fallback: RegisteredHandler["handler"] = () => undefined;
	return {
		pi,
		context:
			pi.handlers.find(({ eventName }) => eventName === "context")?.handler ??
			fallback,
		agentSettled:
			pi.handlers.find(({ eventName }) => eventName === "agent_settled")
				?.handler ?? fallback,
		sessionCompact:
			pi.handlers.find(({ eventName }) => eventName === "session_compact")
				?.handler ?? fallback,
		sessionStart:
			pi.handlers.find(({ eventName }) => eventName === "session_start")
				?.handler ?? fallback,
	};
}

/** Returns the visible diagnostic messages sent by the extension. */
function diagnostics(pi: TestPi): SentMessage[] {
	return pi.sentMessages.filter(
		({ message }) => message.customType === DIAGNOSTIC_TYPE,
	);
}

describe("compaction trigger", () => {
	test("passes through a request below the native threshold", async () => {
		// Purpose: normal requests must reach the provider unchanged.
		// Input and expected output: an enabled threshold one token above the estimate returns no replacement and makes no lifecycle calls.
		// Edge case: the request is adjacent to the threshold rather than far below it.
		// Dependencies: shared settings reader, active tool builder, convertToLlm, and serialized input estimator.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(
			cwd,
			estimatedTokens(messages) + RESERVE_TOKENS + 1,
		);
		const harness = install();

		const result = await harness.context({ type: "context", messages }, ctx);

		expect(result).toBeUndefined();
		expect(ctx.abortCalls.count).toBe(0);
		expect(ctx.compactCalls).toHaveLength(0);
		expect(harness.pi.sentMessages).toHaveLength(0);
	});

	test("passes through when native compaction is disabled", async () => {
		// Purpose: compaction.enabled false must disable threshold enforcement.
		// Input and expected output: a request above a nominal threshold returns no replacement and does not abort.
		// Edge case: the model window is smaller than the estimated input.
		// Dependencies: shared native settings reader.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: false, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, 1);
		const harness = install();

		const result = await harness.context({ type: "context", messages }, ctx);

		expect(result).toBeUndefined();
		expect(ctx.abortCalls.count).toBe(0);
		expect(harness.pi.sentMessages).toHaveLength(0);
	});

	test("blocks invalid settings with one visible non-triggering diagnostic", async () => {
		// Purpose: invalid native settings must fail closed before provider dispatch.
		// Input and expected output: malformed JSON aborts the active request, returns an empty message list, and sends one visible diagnostic.
		// Edge case: SettingsManager can return defaults while also reporting the parse error.
		// Dependencies: shared native settings reader and an active abort signal.
		const { agentDir, cwd } = await createSettingsFixture({});
		await writeFile(join(agentDir, "settings.json"), "{");
		const ctx = createContext(cwd, 10_000);
		const harness = install();

		const result = await harness.context(
			{ type: "context", messages: [userMessage()] },
			ctx,
		);

		expect(result).toEqual({ messages: [] });
		expect(ctx.abortCalls.count).toBe(1);
		expect(diagnostics(harness.pi)).toEqual([
			{
				message: {
					customType: DIAGNOSTIC_TYPE,
					content: expect.any(String),
					display: true,
				},
				options: { triggerTurn: false },
			},
		]);
	});

	test("passes through without a usable model context window", async () => {
		// Purpose: threshold enforcement needs a known positive model context window.
		// Input and expected output: missing, zero, and negative windows each return no replacement and do not abort.
		// Edge case: settings are enabled for every model case.
		// Dependencies: ExtensionContext model contract and shared settings reader.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const harness = install();
		for (const contextWindow of [undefined, 0, -1]) {
			const ctx = createContext(cwd, contextWindow);

			const result = await harness.context(
				{ type: "context", messages: [userMessage()] },
				ctx,
			);

			expect(result).toBeUndefined();
			expect(ctx.abortCalls.count).toBe(0);
		}
		expect(harness.pi.sentMessages).toHaveLength(0);
	});

	test("interrupts when the estimate equals the threshold", async () => {
		// Purpose: equality must trigger compaction rather than pass the request.
		// Input and expected output: contextWindow minus reserveTokens equals the estimate, so the handler calls abort and replaces messages with an empty list.
		// Edge case: exact equality remains interruptible when the context does not expose an active signal.
		// Dependencies: full provider-visible estimate inputs and ExtensionContext.abort.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(
			cwd,
			estimatedTokens(messages) + RESERVE_TOKENS,
			false,
		);
		const harness = install();

		const result = await harness.context({ type: "context", messages }, ctx);

		expect(result).toEqual({ messages: [] });
		expect(ctx.abortCalls.count).toBe(1);
		expect(ctx.compactCalls).toHaveLength(0);
	});

	test("interrupts when provider usage reaches the threshold above the serialized estimate", async () => {
		// Purpose: provider usage must preserve context that local serialization cannot count.
		// Input and expected output: successful provider usage plus one trailing message equals the threshold, so the handler aborts and clears the messages.
		// Edge case: usage-backed equality triggers while the serialized estimate remains below the threshold.
		// Dependencies: public calculateContextTokens and estimateTokens helpers, isolated settings, and the direct context handler.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const anchor = assistantMessage(10_000);
		const trailingMessage = userMessage("continue after hidden reasoning");
		const messages = [anchor, trailingMessage];
		const usageBackedEstimate =
			calculateContextTokens(anchor.usage) + estimateTokens(trailingMessage);
		expect(estimatedTokens(messages)).toBeLessThan(usageBackedEstimate);
		const ctx = createContext(cwd, usageBackedEstimate + RESERVE_TOKENS, false);
		const harness = install();

		const result = await harness.context({ type: "context", messages }, ctx);

		expect(result).toEqual({ messages: [] });
		expect(ctx.abortCalls.count).toBe(1);
	});

	test("defers one compaction until the interrupted agent settles", async () => {
		// Purpose: compaction must not overlap the aborted agent run.
		// Input and expected output: an equality crossing makes no context-handler compact call, then repeated settlement invokes compact exactly once.
		// Edge case: duplicate agent_settled events cannot start duplicate compactions.
		// Dependencies: context and agent_settled event ordering.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, estimatedTokens(messages) + RESERVE_TOKENS);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		expect(ctx.compactCalls).toHaveLength(0);

		await harness.agentSettled({ type: "agent_settled" }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);

		expect(ctx.compactCalls).toHaveLength(1);
	});

	test("continues without manual compaction after native compaction succeeds", async () => {
		// Purpose: native post-run compaction must satisfy the interrupted threshold cycle.
		// Input and expected output: session_compact before settlement sends one continuation without a manual compact call.
		// Edge case: agent_settled must not treat an already rebuilt context as uncompacted.
		// Dependencies: session_compact and agent_settled event ordering.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, estimatedTokens(messages) + RESERVE_TOKENS);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		await harness.sessionCompact({ type: "session_compact" }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);

		expect(ctx.compactCalls).toHaveLength(0);
		expect(harness.pi.sentMessages).toEqual([
			{
				message: {
					customType: CONTINUATION_TYPE,
					content: expect.any(String),
					display: false,
				},
				options: { triggerTurn: true },
			},
		]);
	});

	test("sends one hidden continuation after successful compaction", async () => {
		// Purpose: a successful compaction must continue the interrupted task once without user input.
		// Input and expected output: onComplete sends one hidden custom continuation with triggerTurn true.
		// Edge case: a duplicate completion callback and later settlement send no duplicate continuation.
		// Dependencies: CompactOptions onComplete and ExtensionAPI.sendMessage delivery fields.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, estimatedTokens(messages) + RESERVE_TOKENS);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);

		ctx.compactCalls[0]?.onComplete?.({} as never);
		ctx.compactCalls[0]?.onComplete?.({} as never);
		await harness.agentSettled({ type: "agent_settled" }, ctx);

		expect(harness.pi.sentMessages).toEqual([
			{
				message: {
					customType: CONTINUATION_TYPE,
					content: expect.any(String),
					display: false,
				},
				options: { triggerTurn: true },
			},
		]);
	});

	test("fails closed when compaction reports an error", async () => {
		// Purpose: failed compaction must stop continuation and keep later requests blocked.
		// Input and expected output: onError sends one visible non-triggering diagnostic, then the next active request aborts and receives empty messages.
		// Edge case: failure happens after settlement when no request is active.
		// Dependencies: CompactOptions onError, failed state, and ExtensionAPI.sendMessage.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, estimatedTokens(messages) + RESERVE_TOKENS);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);

		ctx.compactCalls[0]?.onError?.(new Error("summary failed"));
		const blockedCtx = createContext(cwd, 100_000);
		const result = await harness.context(
			{ type: "context", messages },
			blockedCtx,
		);

		expect(result).toEqual({ messages: [] });
		expect(blockedCtx.abortCalls.count).toBe(1);
		expect(diagnostics(harness.pi)).toHaveLength(1);
		expect(
			harness.pi.sentMessages.filter(
				({ message }) => message.customType === CONTINUATION_TYPE,
			),
		).toHaveLength(0);
	});

	test("fails an over-threshold resumed context without compacting again", async () => {
		// Purpose: one successful compaction must not create a compaction loop.
		// Input and expected output: an over-threshold context in resuming aborts, returns empty messages, sends one diagnostic, and keeps one compact call.
		// Edge case: the rebuilt context remains exactly at the threshold.
		// Dependencies: successful callback state and inclusive threshold comparison.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const ctx = createContext(cwd, estimatedTokens(messages) + RESERVE_TOKENS);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);
		ctx.compactCalls[0]?.onComplete?.({} as never);
		const resumedCtx = createContext(
			cwd,
			estimatedTokens(messages) + RESERVE_TOKENS,
		);

		const result = await harness.context(
			{ type: "context", messages },
			resumedCtx,
		);
		await harness.agentSettled({ type: "agent_settled" }, resumedCtx);

		expect(result).toEqual({ messages: [] });
		expect(resumedCtx.abortCalls.count).toBe(1);
		expect(ctx.compactCalls).toHaveLength(1);
		expect(resumedCtx.compactCalls).toHaveLength(0);
		expect(diagnostics(harness.pi)).toHaveLength(1);
	});

	test("returns to idle after an under-threshold resumed context", async () => {
		// Purpose: a compacted request that now fits must proceed and re-arm future threshold detection.
		// Input and expected output: the first resumed request below threshold passes, then a later equality request interrupts.
		// Edge case: state changes to idle only after the safe resumed request is measured.
		// Dependencies: successful callback, serialized input estimator, and idle threshold behavior.
		const { cwd } = await createSettingsFixture({
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});
		const messages = [userMessage()];
		const thresholdWindow = estimatedTokens(messages) + RESERVE_TOKENS;
		const ctx = createContext(cwd, thresholdWindow);
		const harness = install();
		await harness.context({ type: "context", messages }, ctx);
		await harness.agentSettled({ type: "agent_settled" }, ctx);
		ctx.compactCalls[0]?.onComplete?.({} as never);
		const safeCtx = createContext(cwd, thresholdWindow + 1);

		const safeResult = await harness.context(
			{ type: "context", messages },
			safeCtx,
		);
		const nextCtx = createContext(cwd, thresholdWindow);
		const nextResult = await harness.context(
			{ type: "context", messages },
			nextCtx,
		);

		expect(safeResult).toBeUndefined();
		expect(safeCtx.abortCalls.count).toBe(0);
		expect(nextResult).toEqual({ messages: [] });
		expect(nextCtx.abortCalls.count).toBe(1);
	});

	test("resets failed state on session start", async () => {
		// Purpose: terminal state from one session must not block a replacement session.
		// Input and expected output: invalid settings fail once, session_start plus repaired settings allows a new equality crossing to enter interruption.
		// Edge case: the extension instance is reused across the lifecycle event.
		// Dependencies: session_start lifecycle and reread of native settings per context event.
		const { agentDir, cwd } = await createSettingsFixture({});
		await writeFile(join(agentDir, "settings.json"), "{");
		const messages = [userMessage()];
		const harness = install();
		const failedCtx = createContext(cwd, 100_000);
		await harness.context({ type: "context", messages }, failedCtx);
		await writeSettings(agentDir, {
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
		});

		await harness.sessionStart(
			{ type: "session_start", reason: "resume" },
			failedCtx,
		);
		const nextCtx = createContext(
			cwd,
			estimatedTokens(messages) + RESERVE_TOKENS,
		);
		const result = await harness.context(
			{ type: "context", messages },
			nextCtx,
		);

		expect(result).toEqual({ messages: [] });
		expect(nextCtx.abortCalls.count).toBe(1);
		expect(diagnostics(harness.pi)).toHaveLength(1);
	});
});
