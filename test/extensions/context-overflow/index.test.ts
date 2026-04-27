import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import contextOverflow from "../../../pi-package/extensions/context-overflow/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface SendUserMessageCall {
	readonly content: string;
	readonly options: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly sendUserMessageCalls: SendUserMessageCall[];
}

interface ContextUsageFake {
	readonly tokens: number | null;
	readonly contextWindow: number;
}

interface CompactCall {
	readonly options: {
		readonly customInstructions?: string;
		readonly onComplete?: (result: unknown) => void;
		readonly onError?: (error: Error) => void;
	};
}

interface UiCall {
	readonly method: string;
}

interface ContextFake {
	usage: ContextUsageFake | undefined;
	readonly compactCalls: CompactCall[];
	readonly uiCalls: UiCall[];
	readonly ctx: {
		readonly hasUI: boolean;
		readonly ui: Record<string, (...args: unknown[]) => void>;
		getContextUsage(): ContextUsageFake | undefined;
		compact(options?: CompactCall["options"]): void;
	};
}

/** Creates the ExtensionAPI fake needed to observe event registration and continuation messages. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const sendUserMessageCalls: SendUserMessageCall[] = [];

	return {
		handlers,
		sendUserMessageCalls,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		sendUserMessage(content: string, options: unknown): void {
			sendUserMessageCalls.push({ content, options });
		},
	} as ExtensionApiFake;
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-context-overflow-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes context-overflow config into the isolated pi agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "context-overflow.json"),
		JSON.stringify(config),
	);
}

/** Returns one registered event handler from the extension fake. */
function getRegisteredHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => Promise<void> | void {
	const handler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (event: unknown, ctx: unknown) => Promise<void> | void;
}

/** Waits until the fire-and-callback compact API has recorded the expected call. */
async function waitForCompactCall(
	context: ContextFake,
	expectedCount: number,
): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (context.compactCalls.length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	throw new Error(`expected ${expectedCount} compact call(s)`);
}

/** Creates the context fake needed to observe context checks, compaction calls, and forbidden UI calls. */
function createContextFake(
	usage: ContextUsageFake | undefined,
	hasUI = true,
): ContextFake {
	const compactCalls: CompactCall[] = [];
	const uiCalls: UiCall[] = [];
	const recordUiCall = (method: string) => (): void => {
		uiCalls.push({ method });
	};
	const fake: ContextFake = {
		usage,
		compactCalls,
		uiCalls,
		ctx: {
			hasUI,
			ui: {
				notify: recordUiCall("notify"),
				setStatus: recordUiCall("setStatus"),
				setWidget: recordUiCall("setWidget"),
				setFooter: recordUiCall("setFooter"),
				setTitle: recordUiCall("setTitle"),
				setEditorText: recordUiCall("setEditorText"),
				custom: recordUiCall("custom"),
			},
			getContextUsage(): ContextUsageFake | undefined {
				return fake.usage;
			},
			compact(options: CompactCall["options"] = {}): void {
				compactCalls.push({ options });
			},
		},
	};

	return fake;
}

/** Installs the extension and returns the observable turn-end test harness. */
function installContextOverflowTestHarness(): {
	readonly pi: ExtensionApiFake;
	readonly turnEndHandler: (
		event: unknown,
		ctx: unknown,
	) => Promise<void> | void;
} {
	const pi = createExtensionApiFake();
	contextOverflow(pi);

	return {
		pi,
		turnEndHandler: getRegisteredHandler(pi, "turn_end"),
	};
}

describe("context-overflow", () => {
	test("uses default threshold, standard compaction, and continue message when config is missing", async () => {
		// Purpose: missing config must enable proactive standard compaction with the recommended token reserve.
		// Input and expected output: exact boundary usage triggers one ctx.compact() call without customInstructions, then onComplete sends continue.
		// Edge case: remainingTokens equals compactRemainingTokens exactly.
		// Dependencies: this test uses only in-memory ExtensionAPI and context fakes with an isolated agent directory.
		await withIsolatedAgentDir(async () => {
			const { pi, turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 150_848,
				contextWindow: 200_000,
			});

			const turnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await waitForCompactCall(context, 1);

			expect(context.compactCalls).toHaveLength(1);
			expect(
				context.compactCalls[0]?.options.customInstructions,
			).toBeUndefined();
			expect(pi.sendUserMessageCalls).toEqual([]);

			context.compactCalls[0]?.options.onComplete?.({});
			await turnEndPromise;

			expect(pi.sendUserMessageCalls).toEqual([
				{
					content: "System message: Context summarization complete, continue",
					options: { deliverAs: "followUp" },
				},
			]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("uses valid non-default threshold from config", async () => {
		// Purpose: valid config must override the default reserve while keeping standard compaction behavior.
		// Input and expected output: enabled config with compactRemainingTokens 10 compacts at 10 remaining tokens but not at 11.
		// Edge case: explicit enabled true must keep the extension active.
		// Dependencies: this test writes only to an isolated temporary agent directory and uses context fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				compactRemainingTokens: 10,
			});
			const { turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 989,
				contextWindow: 1_000,
			});

			await turnEndHandler({ type: "turn_end" }, context.ctx);
			expect(context.compactCalls).toEqual([]);

			context.usage = { tokens: 990, contextWindow: 1_000 };
			const turnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await waitForCompactCall(context, 1);
			context.compactCalls[0]?.options.onComplete?.({});
			await turnEndPromise;

			expect(context.compactCalls).toHaveLength(1);
			expect(
				context.compactCalls[0]?.options.customInstructions,
			).toBeUndefined();
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("does not compact when usage is above threshold or unknown", async () => {
		// Purpose: the extension must not trigger compaction without a known threshold exceedance.
		// Input and expected output: one token above the threshold, undefined usage, and null tokens produce no compact calls.
		// Edge case: tokens are unavailable right after compaction, so null must not re-arm or trigger compaction.
		// Dependencies: this test uses only the turn_end handler and context usage fakes.
		await withIsolatedAgentDir(async () => {
			const { turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 150_847,
				contextWindow: 200_000,
			});

			await turnEndHandler({ type: "turn_end" }, context.ctx);
			context.usage = undefined;
			await turnEndHandler({ type: "turn_end" }, context.ctx);
			context.usage = { tokens: null, contextWindow: 200_000 };
			await turnEndHandler({ type: "turn_end" }, context.ctx);

			expect(context.compactCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("does not compact when UI is unavailable", async () => {
		// Purpose: print and JSON modes must not start proactive compaction because the automatic continuation cannot be delivered safely after teardown.
		// Input and expected output: exceeded context usage with hasUI false produces no compact calls and no continuation.
		// Edge case: this preserves package validation commands that run pi in print mode.
		// Dependencies: this test uses the context fake's hasUI flag and in-memory ExtensionAPI calls.
		await withIsolatedAgentDir(async () => {
			const { pi, turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake(
				{
					tokens: 151_000,
					contextWindow: 200_000,
				},
				false,
			);

			await turnEndHandler({ type: "turn_end" }, context.ctx);

			expect(context.compactCalls).toEqual([]);
			expect(pi.sendUserMessageCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("compacts once per threshold exceedance and re-arms after usage returns above threshold", async () => {
		// Purpose: repeated turn_end events below the reserve must not start repeated compactions for one exceedance.
		// Input and expected output: two exceeded usages trigger one compaction, an above-threshold usage re-arms, and a later exceeded usage triggers another compaction.
		// Edge case: compaction in flight blocks duplicate compaction before onComplete runs.
		// Dependencies: this test manually invokes the captured compaction completion callback.
		await withIsolatedAgentDir(async () => {
			const { turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 151_000,
				contextWindow: 200_000,
			});

			const firstTurnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await waitForCompactCall(context, 1);
			await turnEndHandler({ type: "turn_end" }, context.ctx);
			expect(context.compactCalls).toHaveLength(1);

			context.compactCalls[0]?.options.onComplete?.({});
			await firstTurnEndPromise;
			const stillExceededPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await stillExceededPromise;
			expect(context.compactCalls).toHaveLength(1);

			context.usage = { tokens: 100_000, contextWindow: 200_000 };
			await turnEndHandler({ type: "turn_end" }, context.ctx);
			context.usage = { tokens: 151_000, contextWindow: 200_000 };
			const secondTurnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await waitForCompactCall(context, 2);
			context.compactCalls[1]?.options.onComplete?.({});
			await secondTurnEndPromise;

			expect(context.compactCalls).toHaveLength(2);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("does not send continue when compaction fails", async () => {
		// Purpose: failed compaction must not create an automatic continuation message.
		// Input and expected output: onError after a threshold exceedance leaves sendUserMessage untouched.
		// Edge case: the compaction guard must still clear so a future re-armed exceedance can compact.
		// Dependencies: this test uses a captured onError callback and ExtensionAPI fake call records.
		await withIsolatedAgentDir(async () => {
			const { pi, turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 151_000,
				contextWindow: 200_000,
			});

			const turnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			);
			await waitForCompactCall(context, 1);
			context.compactCalls[0]?.options.onError?.(
				new Error("compaction failed"),
			);
			await turnEndPromise;

			expect(pi.sendUserMessageCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("waits for compaction completion before the turn-end handler returns", async () => {
		// Purpose: turn_end must keep the extension runtime active until the compaction continuation is queued.
		// Input and expected output: turn_end remains pending until onComplete sends exactly one follow-up continuation.
		// Edge case: the completion callback is the only operation that resolves the in-flight turn_end promise.
		// Dependencies: this test uses captured callbacks and the ExtensionAPI fake call records.
		await withIsolatedAgentDir(async () => {
			const { pi, turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 151_000,
				contextWindow: 200_000,
			});
			let turnEndResolved = false;

			const turnEndPromise = Promise.resolve(
				turnEndHandler({ type: "turn_end" }, context.ctx),
			).then(() => {
				turnEndResolved = true;
			});
			await waitForCompactCall(context, 1);

			expect(turnEndResolved).toBe(false);
			expect(pi.sendUserMessageCalls).toEqual([]);

			context.compactCalls[0]?.options.onComplete?.({});
			await turnEndPromise;

			expect(turnEndResolved).toBe(true);
			expect(pi.sendUserMessageCalls).toHaveLength(1);
			expect(context.uiCalls).toEqual([]);
		});
	});

	test("disabled and invalid config fail closed without UI calls", async () => {
		// Purpose: explicit disablement and invalid config must preserve pi behavior by not triggering compaction.
		// Input and expected output: disabled config, unsupported keys, negative thresholds, and malformed JSON produce no compact calls.
		// Edge case: invalid config must not use notifications because the extension owns no UI.
		// Dependencies: this test writes only to isolated temporary agent directories.
		const cases: readonly unknown[] = [
			{ enabled: false },
			{ compactRemainingTokens: -1 },
			{ compactRemainingTokens: 1.5 },
			{ unsupported: true },
		];

		for (const config of cases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, config);
				const { turnEndHandler } = installContextOverflowTestHarness();
				const context = createContextFake({
					tokens: 151_000,
					contextWindow: 200_000,
				});

				await turnEndHandler({ type: "turn_end" }, context.ctx);

				expect(context.compactCalls).toEqual([]);
				expect(context.uiCalls).toEqual([]);
			});
		}

		await withIsolatedAgentDir(async (agentDir) => {
			await mkdir(join(agentDir, "config"), { recursive: true });
			await writeFile(
				join(agentDir, "config", "context-overflow.json"),
				"{not json",
			);
			const { turnEndHandler } = installContextOverflowTestHarness();
			const context = createContextFake({
				tokens: 151_000,
				contextWindow: 200_000,
			});

			await turnEndHandler({ type: "turn_end" }, context.ctx);

			expect(context.compactCalls).toEqual([]);
			expect(context.uiCalls).toEqual([]);
		});
	});
});
