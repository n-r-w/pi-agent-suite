import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createModelResponseTimeoutExtension,
	type ResponseTimerDependencies,
} from "./index";

type Handler = (...args: unknown[]) => unknown;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: Handler;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly sentMessages: Array<{ message: unknown; options: unknown }>;
}

class TimerFake implements ResponseTimerDependencies {
	readonly delays: number[] = [];
	readonly callbacks: Array<() => void> = [];
	readonly active = new Set<number>();

	setTimeout = (callback: () => void, delayMilliseconds: number) => {
		const index = this.callbacks.push(callback) - 1;
		this.delays.push(delayMilliseconds);
		this.active.add(index);
		return index as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
		this.active.delete(timer as unknown as number);
	};

	fire(index: number): void {
		this.callbacks[index]?.();
	}
}

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	return {
		handlers,
		sentMessages,
		on: ((eventName: string, handler: Handler) => {
			handlers.push({ eventName, handler });
		}) as ExtensionAPI["on"],
		sendMessage: (message: unknown, options: unknown) => {
			sentMessages.push({ message, options });
		},
	} as ExtensionApiFake;
}

function getHandler(pi: ExtensionApiFake, eventName: string): Handler {
	const handler = pi.handlers.find(
		(registered) => registered.eventName === eventName,
	)?.handler;
	expect(handler).toBeFunction();
	return handler as Handler;
}

function assistantMessage(text = "partial"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
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
				total: 0,
			},
		},
		stopReason: "aborted",
		timestamp: 1,
	};
}

async function withSuiteConfig(
	content: string | undefined,
	run: (directory: string) => void | Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "model-response-timeout-"));
	const previousSuiteDir = process.env["PI_AGENT_SUITE_DIR"];
	try {
		process.env["PI_AGENT_SUITE_DIR"] = directory;
		if (content !== undefined) {
			const extensionDirectory = join(directory, "model-response-timeout");
			await mkdir(extensionDirectory, { recursive: true });
			await writeFile(join(extensionDirectory, "config.json"), content);
		}
		await run(directory);
	} finally {
		if (previousSuiteDir === undefined) {
			delete process.env["PI_AGENT_SUITE_DIR"];
		} else {
			process.env["PI_AGENT_SUITE_DIR"] = previousSuiteDir;
		}
		await rm(directory, { recursive: true, force: true });
	}
}

function createContext() {
	const notifications: Array<{ message: string; type: string | undefined }> =
		[];
	let abortCount = 0;
	return {
		ctx: {
			hasUI: true,
			ui: {
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
			abort: () => {
				abortCount += 1;
			},
		},
		notifications,
		get abortCount() {
			return abortCount;
		},
	};
}

describe("model response timeout", () => {
	test("uses the 1200 second default and clears a timed-out response", async () => {
		// Purpose: prove the default timer produces a timeout error without leaking partial output.
		// Input and expected output: one provider request schedules 1200000 ms and returns an empty error response.
		// Edge case: the timed-out partial assistant content must not reach the next attempt.
		// Dependencies: suite config location and deterministic timer fake.
		await withSuiteConfig(undefined, () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			getHandler(pi, "before_provider_request")(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			expect(timers.delays).toEqual([1_200_000]);
			timers.fire(0);
			const result = getHandler(pi, "message_end")(
				{ type: "message_end", message: assistantMessage() },
				context.ctx,
			) as { message: AssistantMessage };

			expect(context.abortCount).toBe(1);
			expect(result.message.content).toEqual([]);
			expect(result.message.stopReason).toBe("error");
		});
	});

	test("registers no lifecycle handlers when disabled", async () => {
		// Purpose: prove that explicit disablement is silent and leaves provider behavior unchanged.
		// Input and expected output: enabled false registers no extension event handlers.
		// Edge case: disabled configuration must not be reported as invalid.
		// Dependencies: suite config parser only.
		await withSuiteConfig('{"enabled":false}', () => {
			const pi = createExtensionApiFake();
			createModelResponseTimeoutExtension(new TimerFake())(pi);
			expect(pi.handlers).toHaveLength(0);
		});
	});

	test("disables only itself and reports one startup error for invalid config", async () => {
		// Purpose: prove fail-open provider behavior for invalid strict configuration.
		// Input and expected output: an unknown field registers one startup diagnostic and no provider handler.
		// Edge case: repeated session starts must not duplicate the diagnostic.
		// Dependencies: suite config parsing and session UI notification.
		await withSuiteConfig('{"enabled":true,"unexpected":1}', () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			expect(
				pi.handlers.some(
					({ eventName }) => eventName === "before_provider_request",
				),
			).toBeFalse();
			const sessionStart = getHandler(pi, "session_start");
			sessionStart({ type: "session_start", reason: "startup" }, context.ctx);
			sessionStart({ type: "session_start", reason: "reload" }, context.ctx);

			expect(context.notifications).toHaveLength(1);
			expect(context.notifications[0]?.type).toBe("error");
			expect(context.notifications[0]?.message).toContain(
				"[model-response-timeout]",
			);
			expect(timers.delays).toHaveLength(0);
		});
	});

	test("reports invalid values even when explicitly disabled", async () => {
		// Purpose: prove strict validation does not skip configured fields when enabled is false.
		// Input and expected output: an invalid timeout registers the startup diagnostic instead of silent disablement.
		// Edge case: explicit disablement must not make malformed field values valid.
		// Dependencies: suite config parsing and session UI notification.
		await withSuiteConfig('{"enabled":false,"timeoutSeconds":0}', () => {
			const pi = createExtensionApiFake();
			const context = createContext();
			createModelResponseTimeoutExtension(new TimerFake())(pi);
			const sessionStart = getHandler(pi, "session_start");
			sessionStart({ type: "session_start", reason: "startup" }, context.ctx);
			expect(context.notifications).toHaveLength(1);
			expect(context.notifications[0]?.type).toBe("error");
		});
	});

	test.each([
		["malformed JSON", "{"],
		["removed continuation budget", '{"maxAutomaticContinuations":3}'],
		["non-boolean enabled", '{"enabled":"yes"}'],
		["zero timeout", '{"timeoutSeconds":0}'],
		["zero retries", '{"maxRetries":0}'],
		["fractional retries", '{"maxRetries":1.5}'],
		["non-numeric retries", '{"maxRetries":"3"}'],
		["null retries", '{"maxRetries":null}'],
		["unsafe retries", '{"maxRetries":9007199254740992}'],
	])("rejects %s", async (_name, content) => {
		// Purpose: prove strict validation for every configured field shape.
		// Input and expected output: malformed or out-of-range input disables timer registration.
		// Edge case: numeric lower bounds and safe integer requirements are enforced.
		// Dependencies: suite config parser only.
		await withSuiteConfig(content, () => {
			const pi = createExtensionApiFake();
			createModelResponseTimeoutExtension(new TimerFake())(pi);
			expect(
				pi.handlers.some(
					({ eventName }) => eventName === "before_provider_request",
				),
			).toBeFalse();
		});
	});

	test("aborts once and replaces incomplete assistant content with the retry error", async () => {
		// Purpose: prove the timeout abort and finalized-message replacement contract.
		// Input and expected output: configured timeout fires, aborts once, and returns empty assistant content with the compact error.
		// Edge case: a repeated stale timer callback cannot abort twice.
		// Dependencies: provider, message-end, and timer lifecycle handlers.
		await withSuiteConfig('{"enabled":true,"timeoutSeconds":12.5}', () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			getHandler(pi, "before_provider_request")(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			timers.fire(0);
			timers.fire(0);
			const result = getHandler(pi, "message_end")(
				{ type: "message_end", message: assistantMessage() },
				context.ctx,
			);

			expect(context.abortCount).toBe(1);
			expect(result).toEqual({
				message: {
					...assistantMessage(),
					content: [],
					stopReason: "error",
					errorMessage: "Model response timed out after 12.5 seconds.",
				},
			});
		});
	});

	test("normal completion clears timing before the next provider request", async () => {
		// Purpose: prove that a completed assistant response ends timing before tool work and the next request.
		// Input and expected output: a normal response clears its timer, while a later request gets an independent timeout.
		// Edge case: invoking the cleared callback after normal completion cannot abort tool work.
		// Dependencies: message-end generation matching and deterministic timer fake.
		await withSuiteConfig('{"enabled":true,"timeoutSeconds":5}', () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			const beforeProviderRequest = getHandler(pi, "before_provider_request");
			const messageEnd = getHandler(pi, "message_end");

			beforeProviderRequest(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			const normal = {
				...assistantMessage("done"),
				stopReason: "stop" as const,
			};
			expect(
				messageEnd({ type: "message_end", message: normal }, context.ctx),
			).toBeUndefined();
			expect(timers.active).toHaveLength(0);
			timers.fire(0);
			expect(context.abortCount).toBe(0);

			beforeProviderRequest(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			timers.fire(1);
			expect(context.abortCount).toBe(1);
		});
	});

	test("retries at most three times by default without replaying failed responses", async () => {
		// Purpose: prove the extension owns a bounded retry loop independent of Pi's retry policy.
		// Inputs and expected outputs: four consecutive timeouts schedule exactly three hidden retries and three recovery edits.
		// Edge cases: the fourth timeout remains final; retry triggers do not appear in provider context.
		// Dependencies: timer, turn boundary, context transform, and settlement handlers.
		await withSuiteConfig(undefined, () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			const start = getHandler(pi, "before_provider_request");
			const finish = getHandler(pi, "message_end");
			const turnEnd = getHandler(pi, "turn_end");
			const settled = getHandler(pi, "agent_settled");
			const transform = getHandler(pi, "context");
			const retryMarker = {
				role: "custom",
				customType: "model-response-timeout.retry-trigger",
				content: [],
			};

			for (let attempt = 0; attempt < 4; attempt++) {
				start({ type: "before_provider_request", payload: {} }, context.ctx);
				timers.fire(attempt);
				const result = finish(
					{ type: "message_end", message: assistantMessage() },
					context.ctx,
				) as { message: AssistantMessage };
				const boundary = turnEnd(
					{
						type: "turn_end",
						message: result.message,
						messageEntryId: `failed-${attempt}`,
						entries: [],
					},
					context.ctx,
				) as { entries: Record<string, unknown>[] } | undefined;
				if (attempt < 3) {
					expect(boundary?.entries).toEqual([
						{
							type: "context_edit",
							targetId: `failed-${attempt}`,
							replacement: null,
						},
						{
							type: "custom",
							customType: "model-response-timeout.retry-scheduled",
							data: {},
						},
					]);
				} else {
					expect(boundary).toBeUndefined();
				}
				settled({ type: "agent_settled" }, context.ctx);
				if (attempt < 3) {
					expect(pi.sentMessages).toHaveLength(attempt + 1);
					expect(pi.sentMessages[attempt]).toMatchObject({
						message: {
							customType: retryMarker.customType,
							display: false,
						},
						options: { triggerTurn: true },
					});
				} else {
					expect(pi.sentMessages).toHaveLength(3);
				}
			}
			const transformed = transform(
				{ type: "context", messages: [{ role: "user" }, retryMarker] },
				context.ctx,
			) as { messages: Array<{ role: string }> };
			expect(transformed.messages.map((entry) => entry.role)).toEqual(["user"]);
			expect(context.abortCount).toBe(4);
		});
	});

	test("resets the retry budget after a successful assistant response", async () => {
		// Purpose: a later independent timeout receives its own retry budget.
		// Inputs and expected outputs: timeout, successful response, and timeout each produce a retry with maxRetries one.
		// Edge case: success clears the earlier failed response's attempt count.
		// Dependencies: provider, message-end, turn, and settlement handlers.
		await withSuiteConfig('{"maxRetries":1}', () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			const start = getHandler(pi, "before_provider_request");
			const finish = getHandler(pi, "message_end");
			const turnEnd = getHandler(pi, "turn_end");
			const settled = getHandler(pi, "agent_settled");
			for (let attempt = 0; attempt < 3; attempt++) {
				start({ type: "before_provider_request", payload: {} }, context.ctx);
				if (attempt !== 1) {
					timers.fire(attempt);
				}
				const finalizedMessage = {
					...assistantMessage(),
					stopReason: attempt === 1 ? ("stop" as const) : ("aborted" as const),
				};
				const response = finish(
					{ type: "message_end", message: finalizedMessage },
					context.ctx,
				) as { message: AssistantMessage } | undefined;
				turnEnd(
					{
						type: "turn_end",
						message: response?.message ?? finalizedMessage,
						messageEntryId: `attempt-${attempt}`,
						entries: [],
					},
					context.ctx,
				);
				settled({ type: "agent_settled" }, context.ctx);
			}
			expect(pi.sentMessages).toHaveLength(2);
		});
	});

	test("does not retry an ordinary user abort", async () => {
		// Purpose: user cancellation must not be confused with a timer-triggered abort.
		// Inputs and expected outputs: an aborted assistant response without an expired timer produces no marker or retry.
		// Edge case: the unused timer is cleared after the abort message.
		// Dependencies: provider, message-end, turn, and settlement handlers.
		await withSuiteConfig(undefined, () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			getHandler(pi, "before_provider_request")(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			expect(
				getHandler(pi, "message_end")(
					{ type: "message_end", message: assistantMessage() },
					context.ctx,
				),
			).toBeUndefined();
			expect(
				getHandler(pi, "turn_end")(
					{
						type: "turn_end",
						message: assistantMessage(),
						messageEntryId: "aborted",
						entries: [],
					},
					context.ctx,
				),
			).toBeUndefined();
			getHandler(pi, "agent_settled")({ type: "agent_settled" }, context.ctx);
			expect(pi.sentMessages).toHaveLength(0);
			expect(context.abortCount).toBe(0);
		});
	});

	test("session lifecycle clears active response timing", async () => {
		// Purpose: prove session replacement and shutdown cannot leak timeout work into another session.
		// Input and expected output: session start and shutdown invalidate old timers.
		// Edge case: stale callbacks after teardown must do nothing.
		// Dependencies: session lifecycle and timer generation.
		await withSuiteConfig(undefined, () => {
			const pi = createExtensionApiFake();
			const timers = new TimerFake();
			const context = createContext();
			createModelResponseTimeoutExtension(timers)(pi);
			getHandler(pi, "before_provider_request")(
				{ type: "before_provider_request", payload: {} },
				context.ctx,
			);
			getHandler(pi, "session_start")(
				{ type: "session_start", reason: "new" },
				context.ctx,
			);
			timers.fire(0);
			getHandler(pi, "session_shutdown")(
				{ type: "session_shutdown", reason: "quit" },
				context.ctx,
			);

			expect(context.abortCount).toBe(0);
			expect(timers.active).toHaveLength(0);
		});
	});
});
