import { describe, expect, test } from "bun:test";
import {
	type ChildAuthStartupAttemptRecord,
	ChildAuthStartupRecoveryError,
	normalizeChildPrompt,
	runChildAuthStartup,
} from "./child-auth-startup";
import { ChildStartupGate } from "./child-startup-gate";

const NO_OPENAI_API_KEY_ERROR = `No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.`;

describe("child auth startup recovery", () => {
	test("normalizes leading command markers before child prompt delivery", () => {
		// Purpose: child tasks must never enter Pi's extension-command path.
		// Input and expected output: every contiguous leading slash is removed while other content stays unchanged.
		// Edge case: slash characters after the first non-slash character are preserved.
		// Dependencies: prompt normalization is a pure shared boundary function.
		expect(normalizeChildPrompt("///review /tmp/input")).toBe(
			"review /tmp/input",
		);
		expect(normalizeChildPrompt(" review /tmp/input")).toBe(
			" review /tmp/input",
		);
		expect(() => normalizeChildPrompt("///")).toThrow(
			"child prompt must contain text after leading '/' characters",
		);
		expect(() => normalizeChildPrompt("/// \n\t")).toThrow(
			"child prompt must contain text after leading '/' characters",
		);
		expect(normalizeChildPrompt("///  review")).toBe("  review");
	});

	test("does not start a child for an unconfigured provider", async () => {
		// Purpose: a permanent provider configuration error must stop before process creation.
		// Input and expected output: an unconfigured provider rejects once without auth or process calls.
		// Edge case: retry capacity must not change the permanent decision.
		// Dependencies: the production FIFO gate and isolated operation fakes.
		let authChecks = 0;
		let starts = 0;
		const attempts: ChildAuthStartupAttemptRecord[] = [];

		await expect(
			runChildAuthStartup({
				owner: "run-subagent",
				provider: "openai",
				providerConfigured: false,
				retry: { maxRetries: 10, delayMs: 1 },
				startupGate: new ChildStartupGate(),
				checkParentAuth: async () => {
					authChecks += 1;
					return { ok: true };
				},
				start: async () => {
					starts += 1;
					return {};
				},
				prompt: async () => "accepted",
				stop: async () => {},
				recordAttempt: (attempt) => attempts.push(attempt),
			}),
		).rejects.toThrow('No API key found for "openai"');
		expect(authChecks).toBe(0);
		expect(starts).toBe(0);
		expect(attempts).toMatchObject([
			{
				attempt: 1,
				stage: "parent_auth",
				decision: "failed",
				reason: "provider_not_configured",
			},
		]);
	});

	test("rechecks parent authentication inside every FIFO attempt", async () => {
		// Purpose: transient parent credential access must recover without starting unauthenticated children.
		// Input and expected output: two unavailable checks retry before one authenticated child is accepted.
		// Edge case: failed parent checks never invoke process start or stop.
		// Dependencies: the production retry scheduler and FIFO gate with one-millisecond test delay.
		let authChecks = 0;
		let starts = 0;
		const attempts: ChildAuthStartupAttemptRecord[] = [];

		const result = await runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 2, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => {
				authChecks += 1;
				return authChecks < 3
					? { ok: false, error: "OAuth storage is temporarily unavailable" }
					: { ok: true };
			},
			start: async () => {
				starts += 1;
				return {};
			},
			prompt: async (_attempt, onAccepted) => {
				onAccepted();
				return "accepted";
			},
			stop: async () => {},
			recordAttempt: (attempt) => attempts.push(attempt),
		});

		expect(result).toBe("accepted");
		expect(authChecks).toBe(3);
		expect(starts).toBe(1);
		expect(attempts.map((attempt) => attempt.decision)).toEqual([
			"retry",
			"retry",
			"accepted",
		]);
	});

	test("cancels after a pending parent-auth check without starting a child", async () => {
		// Purpose: cancellation during credential resolution must win before auth classification or process creation.
		// Input and expected output: both successful and failed delayed auth results produce one cancelled attempt.
		// Edge case: a failed delayed auth result must not retain a retry decision.
		// Dependencies: deferred parent-auth fakes, AbortController, and shared startup recovery.
		const outcomes: Array<{
			readonly originalReason: boolean;
			readonly starts: number;
			readonly decisions: readonly string[];
		}> = [];
		for (const authResult of [
			{ ok: true as const },
			{ ok: false as const, error: "OAuth storage is unavailable" },
		]) {
			const controller = new AbortController();
			const reason = new Error("cancel credential wait");
			const attempts: ChildAuthStartupAttemptRecord[] = [];
			let starts = 0;
			let resolveAuth = (_result: typeof authResult): void => undefined;
			let markAuthStarted = (): void => undefined;
			const authStarted = new Promise<void>((resolve) => {
				markAuthStarted = resolve;
			});
			const auth = new Promise<typeof authResult>((resolve) => {
				resolveAuth = resolve;
			});
			const pending = runChildAuthStartup({
				owner: "run-subagent",
				provider: "openai",
				providerConfigured: true,
				retry: { maxRetries: 1, delayMs: 1 },
				startupGate: new ChildStartupGate(),
				signal: controller.signal,
				checkParentAuth: async () => {
					markAuthStarted();
					return auth;
				},
				start: async () => {
					starts += 1;
					return {};
				},
				prompt: async (_attempt, onAccepted) => {
					onAccepted();
					return "unexpected";
				},
				stop: async () => {},
				recordAttempt: (attempt) => attempts.push(attempt),
			});
			await authStarted;
			controller.abort(reason);
			resolveAuth(authResult);
			const outcome = await pending.catch((error: unknown) => error);
			outcomes.push({
				originalReason: outcome === reason,
				starts,
				decisions: attempts.map((attempt) => attempt.decision),
			});
		}

		expect(outcomes).toEqual([
			{ originalReason: true, starts: 0, decisions: ["cancelled"] },
			{ originalReason: true, starts: 0, decisions: ["cancelled"] },
		]);
	});

	test("stops a child cancelled after start without delivering the prompt", async () => {
		// Purpose: cancellation after process readiness must prevent the first prompt from entering child Pi.
		// Input and expected output: a delayed start resolves after abort, then one stop completes with zero prompt calls.
		// Edge case: the FIFO slot remains owned until the started child is stopped.
		// Dependencies: deferred child start, AbortController, and shared startup recovery.
		const controller = new AbortController();
		const reason = new Error("cancel after process start");
		const attempts: ChildAuthStartupAttemptRecord[] = [];
		let promptCalls = 0;
		let stopCalls = 0;
		let resolveStart = (_child: object): void => undefined;
		let markStartEntered = (): void => undefined;
		const startEntered = new Promise<void>((resolve) => {
			markStartEntered = resolve;
		});
		const startedChild = new Promise<object>((resolve) => {
			resolveStart = resolve;
		});
		const pending = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 1, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			signal: controller.signal,
			checkParentAuth: async () => ({ ok: true }),
			start: async () => {
				markStartEntered();
				return startedChild;
			},
			prompt: async (_attempt, onAccepted) => {
				promptCalls += 1;
				onAccepted();
				return "unexpected";
			},
			stop: async () => {
				stopCalls += 1;
			},
			recordAttempt: (attempt) => attempts.push(attempt),
		});
		await startEntered;
		controller.abort(reason);
		resolveStart({});

		const outcome = await pending.catch((error: unknown) => error);

		expect({
			originalReason: outcome === reason,
			promptCalls,
			stopCalls,
			attempts: attempts.map(({ decision, reason: attemptReason }) => ({
				decision,
				reason: attemptReason,
			})),
		}).toEqual({
			originalReason: true,
			promptCalls: 0,
			stopCalls: 1,
			attempts: [{ decision: "cancelled", reason: "cancelled" }],
		});
	});

	test("uses a fresh process after an exact first-prompt auth rejection", async () => {
		// Purpose: only a directly rejected first prompt may trigger safe child replacement.
		// Input and expected output: two matching rejections stop their processes before the third succeeds.
		// Edge case: process identities differ while all attempts use the same provider policy.
		// Dependencies: the production retry scheduler and isolated process-operation fakes.
		let nextProcessId = 0;
		const stoppedProcessIds: number[] = [];
		const attempts: ChildAuthStartupAttemptRecord[] = [];

		const result = await runChildAuthStartup({
			owner: "convene-council",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 2, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => ({ ok: true }),
			start: async () => ({ id: ++nextProcessId }),
			prompt: async (process, onAccepted) => {
				if (process.id < 3) {
					throw new Error(NO_OPENAI_API_KEY_ERROR);
				}
				onAccepted();
				return process.id;
			},
			stop: async (process) => {
				stoppedProcessIds.push(process.id);
			},
			recordAttempt: (attempt) => attempts.push(attempt),
		});

		expect(result).toBe(3);
		expect(stoppedProcessIds).toEqual([1, 2]);
		expect(attempts.map((attempt) => attempt.decision)).toEqual([
			"retry",
			"retry",
			"accepted",
		]);
	});

	test("does not retry a missing-key error for another provider", async () => {
		// Purpose: retry eligibility must bind the child error to the selected provider.
		// Input and expected output: an anthropic error under an openai launch stops one process without replacement.
		// Edge case: the error has the exact retryable prefix and differs only by provider.
		// Dependencies: shared provider matching and isolated process-operation fakes.
		const failure = new Error("No API key found for anthropic.");
		const attempts: ChildAuthStartupAttemptRecord[] = [];
		let starts = 0;
		let stops = 0;

		const promise = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 2, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => ({ ok: true }),
			start: async () => {
				starts += 1;
				return {};
			},
			prompt: async () => {
				throw failure;
			},
			stop: async () => {
				stops += 1;
			},
			recordAttempt: (attempt) => attempts.push(attempt),
		});

		await expect(promise).rejects.toBe(failure);
		expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
		expect(attempts).toMatchObject([
			{ decision: "failed", reason: "prompt_failed" },
		]);
	});

	test.each([
		["missing terminal period", "No API key found for openai"],
		["double-quoted provider", 'No API key found for "openai".'],
		["single-quoted provider", "No API key found for 'openai'."],
		["outer whitespace", " No API key found for openai. "],
	])("does not retry non-Pi missing-key text: %s", async (_case, message) => {
		// Purpose: retry classification must accept only the exact first line emitted by Pi.
		// Input and expected output: a similar missing-key message stops once and preserves the original failure.
		// Edge case: punctuation, quoting, and whitespace variants must not become equivalent to the Pi contract.
		// Dependencies: shared first-prompt classification and isolated process-operation fakes.
		const failure = new Error(message);
		const attempts: ChildAuthStartupAttemptRecord[] = [];
		let starts = 0;
		let stops = 0;

		const promise = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 1, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => ({ ok: true }),
			start: async () => {
				starts += 1;
				return {};
			},
			prompt: async () => {
				throw failure;
			},
			stop: async () => {
				stops += 1;
			},
			recordAttempt: (attempt) => attempts.push(attempt),
		});

		await expect(promise).rejects.toBe(failure);
		expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
		expect(attempts).toMatchObject([
			{ decision: "failed", reason: "prompt_failed" },
		]);
	});

	test("releases the FIFO slot during the fixed retry delay", async () => {
		// Purpose: one recovering operation must not hold the package-wide startup slot while waiting.
		// Input and expected output: a second operation accepts before the first operation begins its retry process.
		// Edge case: both operations share one gate but use independent retry policies.
		// Dependencies: the production FIFO gate and fixed retry scheduler.
		const gate = new ChildStartupGate();
		const order: string[] = [];
		let firstAuthChecks = 0;
		let markRetryScheduled = (): void => undefined;
		const retryScheduled = new Promise<void>((resolve) => {
			markRetryScheduled = resolve;
		});
		const first = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 1, delayMs: 100 },
			startupGate: gate,
			checkParentAuth: async () => {
				firstAuthChecks += 1;
				return firstAuthChecks === 1
					? { ok: false, error: "OAuth storage is temporarily unavailable" }
					: { ok: true };
			},
			start: async () => {
				order.push("first-start");
				return {};
			},
			prompt: async (_attempt, onAccepted) => {
				onAccepted();
				return "first";
			},
			stop: async () => {},
			recordAttempt: (attempt) => {
				if (attempt.decision === "retry") {
					markRetryScheduled();
				}
			},
		});
		await retryScheduled;

		const second = runChildAuthStartup({
			owner: "convene-council",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 0, delayMs: 1 },
			startupGate: gate,
			checkParentAuth: async () => ({ ok: true }),
			start: async () => {
				order.push("second-start");
				return {};
			},
			prompt: async (_attempt, onAccepted) => {
				onAccepted();
				return "second";
			},
			stop: async () => {},
		});

		expect(await second).toBe("second");
		expect(await first).toBe("first");
		expect(order).toEqual(["second-start", "first-start"]);
	});

	test("never retries after the first prompt is accepted", async () => {
		// Purpose: protocol acceptance is the irreversible boundary for one child operation.
		// Input and expected output: a post-acceptance failure is returned without replacement or stop.
		// Edge case: the failure occurs in the same promise after the acceptance callback.
		// Dependencies: isolated process-operation fakes and the production acceptance state.
		const failure = new Error(NO_OPENAI_API_KEY_ERROR);
		let starts = 0;
		let stops = 0;
		const attempts: ChildAuthStartupAttemptRecord[] = [];

		await expect(
			runChildAuthStartup({
				owner: "convene-council",
				provider: "openai",
				providerConfigured: true,
				retry: { maxRetries: 10, delayMs: 1 },
				startupGate: new ChildStartupGate(),
				checkParentAuth: async () => ({ ok: true }),
				start: async () => {
					starts += 1;
					return {};
				},
				prompt: async (_attempt, onAccepted) => {
					onAccepted();
					throw failure;
				},
				stop: async () => {
					stops += 1;
				},
				recordAttempt: (attempt) => attempts.push(attempt),
			}),
		).rejects.toBe(failure);
		expect(starts).toBe(1);
		expect(stops).toBe(0);
		expect(attempts.map((attempt) => attempt.decision)).toEqual(["accepted"]);
	});

	test("sanitizes the exhausted parent-auth message before public reporting", async () => {
		// Purpose: terminal controls from credential resolution must not enter tool errors or diagnostics.
		// Input and expected output: ANSI styling and line controls collapse while the recovery reason remains visible.
		// Edge case: no child process exists when the only permitted attempt fails parent authentication.
		// Dependencies: the production terminal display normalizer and shared startup recovery.
		const promise = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 0, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => ({
				ok: false,
				error: "\u001b[31mOAuth unavailable\u001b[0m\nretry later",
			}),
			start: async () => ({}),
			prompt: async () => "unused",
			stop: async () => {},
		});

		await expect(promise).rejects.toMatchObject({
			message:
				"OAuth unavailable retry later\nChild startup recovery stopped after 1/1 attempts: parent_auth_unavailable.",
		});
	});

	test("returns the original failure with the exhausted attempt report", async () => {
		// Purpose: bounded recovery must retain the child error and every safe retry decision.
		// Input and expected output: three failed attempts produce one recovery error with the original message.
		// Edge case: maxRetries counts retries after the initial attempt.
		// Dependencies: the production retry scheduler and isolated process-operation fakes.
		const failure = new Error(NO_OPENAI_API_KEY_ERROR);

		const promise = runChildAuthStartup({
			owner: "run-subagent",
			provider: "openai",
			providerConfigured: true,
			retry: { maxRetries: 2, delayMs: 1 },
			startupGate: new ChildStartupGate(),
			checkParentAuth: async () => ({ ok: true }),
			start: async () => ({}),
			prompt: async () => {
				throw failure;
			},
			stop: async () => {},
		});

		await expect(promise).rejects.toMatchObject({
			name: ChildAuthStartupRecoveryError.name,
			failure,
			message:
				"No API key found for openai. Use /login to log into a provider via OAuth or API key.\nChild startup recovery stopped after 3/3 attempts: prompt_auth_unavailable.",
			attempts: [
				{ attempt: 1, decision: "retry" },
				{ attempt: 2, decision: "retry" },
				{ attempt: 3, decision: "failed" },
			],
		});
	});
});
