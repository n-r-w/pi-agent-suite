import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import type { ChildAuthStartupAttemptRecord } from "../../shared/child-auth-startup";
import {
	CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE,
	createChildAuthStartupDiagnosticRecorder,
} from "../../shared/child-auth-startup-diagnostic";
import type { ChildStartupConfig } from "../../shared/child-startup-config";
import { ChildStartupGate } from "../../shared/child-startup-gate";
import {
	COUNCIL_RPC_ABORT_GRACE_MS,
	COUNCIL_RPC_TERM_GRACE_MS,
	createParticipantRunnerFactory,
	type ParticipantRunnerFactoryDependencies,
} from "./runner";
import type { ParticipantRunnerFactory } from "./types";

const NO_OPENAI_API_KEY_ERROR = `No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.`;

interface FakeStdin extends EventEmitter {
	readonly writes: string[];
	write(chunk: string): boolean;
}

interface FakeProcess {
	readonly stdin: FakeStdin;
	readonly stdout: EventEmitter;
	readonly stderr: EventEmitter;
	readonly killedSignals: string[];
	kill(signal?: string): boolean;
	on(
		event: "error" | "exit" | "close",
		handler: ((error: Error) => void) | (() => void),
	): unknown;
	error(error: Error): void;
	exit(): void;
	close(): void;
}

/** Creates one fake child process with writable stdin and evented stdout/stderr. */
function createFakeProcess(
	options: { readonly exitOnSignal?: string } = {},
): FakeProcess {
	const stdin = new EventEmitter() as FakeStdin;
	Object.defineProperty(stdin, "writes", { value: [] });
	stdin.write = function write(chunk: string): boolean {
		this.writes.push(chunk);
		this.emit("write", chunk);
		return true;
	};
	const stdout = new EventEmitter();
	stdout.on("error", () => {});
	const stderr = new EventEmitter();
	const killedSignals: string[] = [];
	const process: FakeProcess = {
		stdin,
		stdout,
		stderr,
		killedSignals,
		kill(signal = "SIGTERM"): boolean {
			killedSignals.push(signal);
			if (signal === options.exitOnSignal) {
				queueMicrotask(() => process.exit());
			}
			return true;
		},
		on(
			event: "error" | "exit" | "close",
			handler: ((error: Error) => void) | (() => void),
		): unknown {
			return stdout.on(event, handler);
		},
		error(error: Error): void {
			stdout.emit("error", error);
		},
		exit(): void {
			stdout.emit("exit");
		},
		close(): void {
			stdout.emit("close");
		},
	};
	return process;
}

/** Builds a runner factory backed by fake child processes. */
function createFakeScheduler(): {
	readonly scheduled: Array<{
		readonly delayMs: number;
		readonly callback: () => void;
	}>;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	runNext(): void;
} {
	const scheduled: Array<{
		readonly delayMs: number;
		readonly callback: () => void;
	}> = [];
	return {
		scheduled,
		setTimeout(callback, delayMs) {
			const item = { delayMs, callback };
			scheduled.push(item);
			return item;
		},
		clearTimeout(handle) {
			const index = scheduled.indexOf(
				handle as { readonly delayMs: number; readonly callback: () => void },
			);
			if (index !== -1) {
				scheduled.splice(index, 1);
			}
		},
		runNext() {
			const item = scheduled.shift();
			if (item === undefined) {
				throw new Error("no scheduled timer");
			}
			item.callback();
		},
	};
}

interface FakeRunnerFactoryOptions {
	readonly scheduler?: ReturnType<typeof createFakeScheduler>;
	readonly onSpawn?: (process: FakeProcess, attempt: number) => void;
	readonly startupGate?: ChildStartupGate;
	readonly childStartupConfig?: ChildStartupConfig;
	readonly exitOnSignal?: string | null;
	readonly recordChildStartupAttempt?: ParticipantRunnerFactoryDependencies["recordChildStartupAttempt"];
}

function createFakeRunnerFactory(options: FakeRunnerFactoryOptions = {}) {
	const scheduler = options.scheduler ?? createFakeScheduler();
	const startupGate = options.startupGate ?? new ChildStartupGate();
	const childStartupConfig = options.childStartupConfig ?? {
		authRetry: { maxRetries: 10, delayMs: 1 },
	};
	const exitOnSignal =
		options.exitOnSignal === null
			? undefined
			: (options.exitOnSignal ?? "SIGTERM");
	const spawned: Array<{
		readonly command: string;
		readonly args: readonly string[];
		readonly options: {
			readonly cwd: string;
			readonly env: Record<string, string>;
		};
		readonly process: FakeProcess;
	}> = [];
	return {
		spawned,
		factory: createParticipantRunnerFactory({
			setTimeout: scheduler.setTimeout,
			startupGate,
			childStartupConfig,
			recordChildStartupAttempt:
				options.recordChildStartupAttempt ?? (() => undefined),
			clearTimeout: scheduler.clearTimeout,
			spawnPi(command, args, spawnOptions) {
				const process = createFakeProcess(
					exitOnSignal === undefined ? {} : { exitOnSignal },
				);
				spawned.push({ command, args, options: spawnOptions, process });
				options.onSpawn?.(process, spawned.length);
				return process;
			},
		}),
	};
}

/** Returns a minimal runner factory input for lifecycle tests. */
function createRunnerOptions(
	modelRegistry: unknown = {
		find(provider: string, modelId: string) {
			return provider === "openai" && modelId === "model-a"
				? createModel("openai", "model-a")
				: undefined;
		},
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true as const }),
	},
) {
	return {
		participantId: "llm1" as const,
		runtime: {
			model: createModel("openai", "model-a"),
			thinking: "medium" as const,
		},
		sessionFile: "/tmp/session/llm1.jsonl",
		sessionDir: "/tmp/session",
		systemPrompt: "participant prompt",
		config: {
			llm1: {},
			llm2: {},
			participantIterationLimit: 3,
			finalAnswerParticipant: "llm2" as const,
			responseDefectRetries: 1,
			tools: undefined,
		},
		startupPlan: {
			extensionArgs: ["-e", "./pi-package"],
			env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" },
		},
		toolArgs: ["--tools", "read"],
		tools: [],
		ctx: {
			cwd: "/tmp/project",
			modelRegistry,
		} as never,
		signal: undefined,
	};
}

/** Emits one successful response for the next RPC command id. */
function respond(process: FakeProcess, id: string, command: string): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "response", id, command, success: true })}\n`,
	);
}

/** Emits one failed response for the selected RPC prompt command id. */
function rejectPrompt(process: FakeProcess, error: string, id = "1"): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "response", id, command: "prompt", success: false, error })}\n`,
	);
}

/** Emits one transient assistant failure and its non-terminal low-level run boundary. */
function retryablePromptFailure(process: FakeProcess): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "temporary failure" }], api: "test", provider: "openai", model: "model-a", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "server error 500", timestamp: 1 } })}\n`,
	);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_end" })}\n`);
}

/** Emits one assistant answer and the complete settled lifecycle boundary. */
function completePrompt(process: FakeProcess, content: string): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: content }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
	);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_end" })}\n`);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_settled" })}\n`);
}

/** Starts one runner prompt and returns the process created under startup ownership. */
async function startRunnerPrompt(
	fake: ReturnType<typeof createFakeRunnerFactory>,
	task: string,
	signal: AbortSignal | undefined,
	options: Parameters<ParticipantRunnerFactory>[0] = createRunnerOptions(),
): Promise<{
	readonly runner: Awaited<ReturnType<ParticipantRunnerFactory>>;
	readonly child: FakeProcess;
	readonly prompt: ReturnType<
		Awaited<ReturnType<ParticipantRunnerFactory>>["prompt"]
	>;
}> {
	const runner = await fake.factory(options);
	const prompt = runner.prompt(task, signal);
	await waitForSpawnCount(fake, 1);
	const child = fake.spawned.at(-1)?.process as FakeProcess;
	return { runner, child, prompt };
}

/** Waits until the fake factory records the requested number of child processes. */
async function waitForSpawnCount(
	fake: ReturnType<typeof createFakeRunnerFactory>,
	count: number,
): Promise<void> {
	while (fake.spawned.length < count) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("ParticipantRunner lifecycle", () => {
	test("starts child pi only when the first prompt owns the startup slot", async () => {
		// Purpose: participant credential loading must begin only after the runner owns serialized startup.
		// Input and expected output: factory creation stays process-free, then the first prompt spawns Pi with the configured session args.
		// Edge case: child resource-disabling and extension args are both propagated.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const runner = await fake.factory(createRunnerOptions());
		expect(fake.spawned).toHaveLength(0);

		const prompt = runner.prompt("first task", undefined);
		await waitForSpawnCount(fake, 1);
		const child = fake.spawned[0]?.process;
		expect(child).toBeDefined();
		expect(fake.spawned[0]).toMatchObject({
			command: "pi",
			args: [
				"--mode",
				"rpc",
				"--session",
				"/tmp/session/llm1.jsonl",
				"--session-dir",
				"/tmp/session",
				"--model",
				"openai/model-a",
				"--thinking",
				"medium",
				"--system-prompt",
				"participant prompt",
				"--no-context-files",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"-e",
				"./pi-package",
				"--tools",
				"read",
			],
			options: {
				cwd: "/tmp/project",
				env: {
					[CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE,
					PI_CODING_AGENT_DIR: "/tmp/pi-agent",
				},
			},
		});

		respond(child as FakeProcess, "1", "prompt");
		completePrompt(child as FakeProcess, "first answer");
		expect((await prompt).content).toEqual([
			{ type: "text", text: "first answer" },
		]);
		await runner.dispose();
	});

	test("removes leading slashes before sending a participant prompt", async () => {
		// Purpose: council tasks must not enter Pi's extension-command path before native auth preflight.
		// Input and expected output: every leading slash is removed from the RPC prompt message.
		// Edge case: a slash inside the task remains unchanged.
		// Dependencies: fake child stdin captures the outgoing prompt command.
		const fake = createFakeRunnerFactory();
		const runner = await fake.factory(createRunnerOptions());

		const prompt = runner.prompt("///review /tmp/input", undefined);
		await waitForSpawnCount(fake, 1);
		const child = fake.spawned[0]?.process as FakeProcess;
		const promptCommand = JSON.parse(child.stdin.writes[0] ?? "{}") as {
			readonly message?: string;
		};
		expect(promptCommand.message).toBe("review /tmp/input");

		respond(child, "1", "prompt");
		completePrompt(child, "answer");
		await prompt;
		await runner.dispose();
	});

	test("serializes participant startup only through prompt preflight", async () => {
		// Purpose: concurrent council participants must not read OAuth credentials at the same time.
		// Input and expected output: the second process starts after the first prompt response, while the first model turn is still running.
		// Edge case: prompt completion is deliberately withheld when the second process starts.
		// Dependencies: two runners sharing one fake factory and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const firstRunner = await fake.factory(createRunnerOptions());
		const secondRunner = await fake.factory({
			...createRunnerOptions(),
			participantId: "llm2",
			sessionFile: "/tmp/session/llm2.jsonl",
		});
		expect(fake.spawned).toHaveLength(0);

		const firstPrompt = firstRunner.prompt("first task", undefined);
		const secondPrompt = secondRunner.prompt("second task", undefined);
		await waitForSpawnCount(fake, 1);
		expect(fake.spawned).toHaveLength(1);

		const firstChild = fake.spawned[0]?.process as FakeProcess;
		respond(firstChild, "1", "prompt");
		await waitForSpawnCount(fake, 2);
		expect(fake.spawned).toHaveLength(2);

		const secondChild = fake.spawned[1]?.process as FakeProcess;
		respond(secondChild, "1", "prompt");
		completePrompt(firstChild, "first answer");
		completePrompt(secondChild, "second answer");
		expect((await firstPrompt).content).toEqual([
			{ type: "text", text: "first answer" },
		]);
		expect((await secondPrompt).content).toEqual([
			{ type: "text", text: "second answer" },
		]);
		await Promise.all([firstRunner.dispose(), secondRunner.dispose()]);
	});

	test("rechecks parent authentication before every participant startup attempt", async () => {
		// Purpose: council participants must use the same per-attempt parent credential check as subagents.
		// Input and expected output: two transient auth misses occur before one child process is accepted.
		// Edge case: unavailable parent credentials never spawn or stop a participant process.
		// Dependencies: the production participant runner, shared retry policy, and a model-registry fake.
		let authChecks = 0;
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			startupGate: new ChildStartupGate(),
			childStartupConfig: {
				authRetry: { maxRetries: 2, delayMs: 1 },
			},
		});
		const runner = await fake.factory(
			createRunnerOptions({
				find: () => createModel("openai", "model-a"),
				hasConfiguredAuth: () => true,
				getApiKeyAndHeaders: async () => {
					authChecks += 1;
					return authChecks < 3
						? {
								ok: false as const,
								error: "OAuth storage is temporarily unavailable",
							}
						: { ok: true as const };
				},
			}),
		);

		const prompt = runner.prompt("first task", undefined);
		await waitForSpawnCount(fake, 1);
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "prompt");
		completePrompt(child, "answer");
		await prompt;

		expect(authChecks).toBe(3);
		expect(fake.spawned).toHaveLength(1);
		await runner.dispose();
	});

	test("retries a first-prompt auth race despite service activity", async () => {
		// Purpose: service events must not override the direct first-prompt acceptance boundary.
		// Input and expected output: the first process emits status, rejects prompt auth, and a fresh process succeeds.
		// Edge case: the service event arrives before the failed prompt response.
		// Dependencies: sequential fake RPC transcripts and the shared bounded retry policy.
		const diagnosticEntries: Array<{ type: string; data: unknown }> = [];
		const recordChildStartupAttempt = createChildAuthStartupDiagnosticRecorder({
			appendEntry(type: string, data?: unknown): void {
				diagnosticEntries.push({ type, data });
			},
		});
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			recordChildStartupAttempt,
			onSpawn: (process, attempt) => {
				process.stdin.once("write", () => {
					if (attempt === 1) {
						process.stdout.emit(
							"data",
							`${JSON.stringify({ type: "agent_start" })}\n`,
						);
						rejectPrompt(process, NO_OPENAI_API_KEY_ERROR);
						return;
					}
					respond(process, "1", "prompt");
					completePrompt(process, "recovered answer");
				});
			},
		});
		const runner = await fake.factory(createRunnerOptions());

		const result = await runner.prompt("recover auth", undefined);

		expect(result.content).toEqual([
			{ type: "text", text: "recovered answer" },
		]);
		expect(fake.spawned).toHaveLength(2);
		expect(fake.spawned[0]?.process.killedSignals).toEqual(["SIGTERM"]);
		expect(fake.spawned[1]?.args).toEqual(fake.spawned[0]?.args);
		expect(
			diagnosticEntries.map(({ type, data }) => ({
				type,
				owner: (data as ChildAuthStartupAttemptRecord).owner,
				provider: (data as ChildAuthStartupAttemptRecord).provider,
				decision: (data as ChildAuthStartupAttemptRecord).decision,
				reason: (data as ChildAuthStartupAttemptRecord).reason,
			})),
		).toEqual([
			{
				type: CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE,
				owner: "convene-council",
				provider: "openai",
				decision: "retry",
				reason: "prompt_auth_unavailable",
			},
			{
				type: CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE,
				owner: "convene-council",
				provider: "openai",
				decision: "accepted",
				reason: "prompt_accepted",
			},
		]);
		await runner.dispose();
	});

	test("stops after ten retries when participant auth startup keeps failing", async () => {
		// Purpose: child auth recovery must remain bounded when every fresh process misses OAuth credentials.
		// Input and expected output: eleven identical prompt preflight failures return the original auth error and report.
		// Edge case: every failed process exits before the next launch.
		// Dependencies: repeating fake RPC failure and the shared configured retry limit.
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			onSpawn: (process) => {
				process.stdin.once("write", () =>
					rejectPrompt(process, NO_OPENAI_API_KEY_ERROR),
				);
			},
		});
		const runner = await fake.factory(createRunnerOptions());

		await expect(runner.prompt("recover auth", undefined)).rejects.toThrow(
			"No API key found for openai. Use /login to log into a provider via OAuth or API key.\nChild startup recovery stopped after 11/11 attempts: prompt_auth_unavailable.",
		);
		expect(fake.spawned).toHaveLength(11);
		expect(
			fake.spawned.every(({ process }) =>
				process.killedSignals.includes("SIGTERM"),
			),
		).toBe(true);
	});

	test("does not retry unrelated first-prompt failures", async () => {
		// Purpose: startup recovery must not hide model, configuration, or transport failures.
		// Input and expected output: a non-auth prompt rejection is returned after one process attempt.
		// Edge case: the failure occurs before prompt preflight succeeds.
		// Dependencies: one fake RPC rejection.
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			onSpawn: (process) => {
				process.stdin.once("write", () =>
					rejectPrompt(process, "prompt rejected"),
				);
			},
		});
		const runner = await fake.factory(createRunnerOptions());

		await expect(runner.prompt("fail once", undefined)).rejects.toThrow(
			"prompt rejected",
		);
		expect(fake.spawned).toHaveLength(1);
	});

	test("does not retry auth errors after the participant has started", async () => {
		// Purpose: recovery must not replace a persistent participant after its first prompt was accepted.
		// Input and expected output: the first turn succeeds and an auth-shaped second prompt failure uses the same process once.
		// Edge case: the later error text exactly matches the startup recovery pattern.
		// Dependencies: one persistent fake process and two RPC prompt commands.
		const fake = createFakeRunnerFactory();
		const {
			runner,
			child,
			prompt: firstPrompt,
		} = await startRunnerPrompt(fake, "first task", undefined);
		respond(child, "1", "prompt");
		completePrompt(child, "first answer");
		await firstPrompt;

		const secondPrompt = runner.prompt("second task", undefined);
		rejectPrompt(child, NO_OPENAI_API_KEY_ERROR, "2");

		await expect(secondPrompt).rejects.toThrow(NO_OPENAI_API_KEY_ERROR);
		expect(fake.spawned).toHaveLength(1);
		await runner.dispose();
	});

	test("does not spawn after cancellation wins the startup acquisition race", async () => {
		// Purpose: a cancelled queued participant must not write abort and then start a prompt.
		// Input and expected output: cancellation after gate resolution but before runner continuation produces no process.
		// Edge case: the gate returns a valid release callback before cancellation is observed.
		// Dependencies: a gate subclass deterministically aborts at the acquisition boundary.
		const controller = new AbortController();
		class AbortAfterAcquireGate extends ChildStartupGate {
			override async acquire(signal: AbortSignal | undefined) {
				const release = await super.acquire(signal);
				controller.abort();
				return release;
			}
		}
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			startupGate: new AbortAfterAcquireGate(),
		});
		const runner = await fake.factory(createRunnerOptions());

		await expect(
			runner.prompt("cancelled task", controller.signal),
		).rejects.toThrow("participant request aborted");
		expect(fake.spawned).toHaveLength(0);
		await runner.dispose();
	});

	test("cancels participant auth recovery during retry backoff", async () => {
		// Purpose: parent cancellation must stop delayed auth recovery without creating another process.
		// Input and expected output: the first startup misses auth, then abort cancels the pending retry.
		// Edge case: no child process is active when cancellation arrives.
		// Dependencies: AbortController and one automatic fake RPC rejection.
		const controller = new AbortController();
		const fake = createFakeRunnerFactory({
			scheduler: createFakeScheduler(),
			onSpawn: (process) => {
				process.stdin.once("write", () =>
					rejectPrompt(process, NO_OPENAI_API_KEY_ERROR),
				);
			},
		});
		const runner = await fake.factory(createRunnerOptions());
		const prompt = runner.prompt("recover auth", controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));

		controller.abort();

		await expect(prompt).rejects.toThrow();
		expect(fake.spawned).toHaveLength(1);
	});

	test("reuses the same child process for multiple participant prompts", async () => {
		// Purpose: participant context must stay in one child session across rounds.
		// Input and expected output: two prompts write to one fake process and return two answers.
		// Edge case: prompt command success does not complete without agent_settled.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const {
			runner,
			child,
			prompt: first,
		} = await startRunnerPrompt(fake, "first task", undefined);

		respond(child, "1", "prompt");
		completePrompt(child, "first answer");
		const second = runner.prompt("second task", undefined);
		respond(child, "2", "prompt");
		completePrompt(child, "second answer");

		expect(fake.spawned).toHaveLength(1);
		expect(JSON.stringify(child.stdin.writes)).toContain("first task");
		expect(JSON.stringify(child.stdin.writes)).toContain("second task");
		expect((await first).content).toEqual([
			{ type: "text", text: "first answer" },
		]);
		expect((await second).content).toEqual([
			{ type: "text", text: "second answer" },
		]);
	});

	test("forwards child session events through the participant runner", async () => {
		// Purpose: production runner wiring must preserve child RPC events for live council progress.
		// Input and expected output: a child tool event reaches the factory-provided session-event callback.
		// Edge case: command responses are still protocol-only and do not reach the callback.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const events: unknown[] = [];
		const { child, prompt } = await startRunnerPrompt(
			fake,
			"inspect files",
			undefined,
			{
				...createRunnerOptions(),
				onSessionEvent: (event) => events.push(event),
			},
		);

		respond(child, "1", "prompt");
		child.stdout.emit(
			"data",
			`${JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } })}\n`,
		);
		completePrompt(child, "answer");

		expect((await prompt).content).toEqual([{ type: "text", text: "answer" }]);
		expect(events).toContainEqual({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "README.md" },
		});
		expect(events).not.toContainEqual({
			type: "response",
			id: "1",
			command: "prompt",
			success: true,
		});
	});

	test("accepts Buffer stdout chunks from child processes", async () => {
		// Purpose: real child stdout emits Buffer chunks, not only strings.
		// Input and expected output: Buffer response accepts the active prompt.
		// Edge case: transport stringifies the chunk before JSONL parsing.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const { child, prompt } = await startRunnerPrompt(
			fake,
			"buffer task",
			undefined,
		);

		child.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
			),
		);
		completePrompt(child, "buffer answer");

		expect((await prompt).content).toEqual([
			{ type: "text", text: "buffer answer" },
		]);
	});

	test("escalates parent abort from RPC abort to SIGTERM and SIGKILL", async () => {
		// Purpose: parent abort must give the child RPC session a chance to stop before process kills.
		// Input and expected output: abort command, then SIGTERM after 10s, then SIGKILL after 5s.
		// Edge case: SIGKILL is conditional on the child still running.
		// Dependencies: fake child process and fake scheduler.
		const scheduler = createFakeScheduler();
		const fake = createFakeRunnerFactory({ scheduler });
		const abortController = new AbortController();
		const { child, prompt } = await startRunnerPrompt(
			fake,
			"long task",
			abortController.signal,
			{
				...createRunnerOptions(),
				signal: abortController.signal,
			},
		);
		prompt.catch(() => undefined);
		respond(child, "1", "prompt");

		abortController.abort();

		expect(
			child.stdin.writes.some(
				(write) => (JSON.parse(write) as { type?: string }).type === "abort",
			),
		).toBe(true);
		expect(scheduler.scheduled[0]?.delayMs).toBe(COUNCIL_RPC_ABORT_GRACE_MS);
		expect(child.killedSignals).toEqual([]);
		scheduler.runNext();
		expect(child.killedSignals).toEqual(["SIGTERM"]);
		expect(scheduler.scheduled[0]?.delayMs).toBe(COUNCIL_RPC_TERM_GRACE_MS);
		scheduler.runNext();
		expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("does not send SIGKILL when child exits after SIGTERM", async () => {
		// Purpose: escalation must not kill an already exited process.
		// Input and expected output: exit after SIGTERM clears the pending SIGKILL timer.
		// Edge case: process emits exit between escalation stages.
		// Dependencies: fake child process and fake scheduler.
		const scheduler = createFakeScheduler();
		const fake = createFakeRunnerFactory({ scheduler });
		const abortController = new AbortController();
		const { child, prompt } = await startRunnerPrompt(
			fake,
			"long task",
			abortController.signal,
			{
				...createRunnerOptions(),
				signal: abortController.signal,
			},
		);
		prompt.catch(() => undefined);
		respond(child, "1", "prompt");

		abortController.abort();
		scheduler.runNext();
		child.exit();

		expect(scheduler.scheduled).toHaveLength(0);
		expect(child.killedSignals).toEqual(["SIGTERM"]);
	});

	test("rejects active prompt when child exits during recovery wait", async () => {
		// Purpose: a persistent child process exit must clear active participant prompt ownership.
		// Input and expected output: prompt waiting for child retry rejects after child exit.
		// Edge case: exit happens after non-final retryable agent_end and before auto_retry_end.
		// Dependencies: fake child process and participant runner lifecycle.
		const fake = createFakeRunnerFactory();
		const { child, prompt: result } = await startRunnerPrompt(
			fake,
			"task",
			undefined,
		);
		respond(child, "1", "prompt");
		retryablePromptFailure(child);
		child.exit();

		await expect(result).rejects.toThrow("child process exited");
	});

	test("rejects active prompt when child errors during recovery wait", async () => {
		// Purpose: child process error must clear active participant prompt ownership.
		// Input and expected output: prompt waiting for child retry rejects after child process error.
		// Edge case: process error happens before child exit.
		// Dependencies: fake child process and participant runner lifecycle.
		const fake = createFakeRunnerFactory();
		const { child, prompt: result } = await startRunnerPrompt(
			fake,
			"task",
			undefined,
		);
		respond(child, "1", "prompt");
		retryablePromptFailure(child);

		child.error(new Error("spawn failure"));

		await expect(result).rejects.toThrow("spawn failure");
	});

	test("preserves a spawn failure when close occurs without exit", async () => {
		// Purpose: Node spawn failures must remain actionable instead of becoming false termination timeouts.
		// Input and expected output: error followed by close rejects with the original ENOENT failure.
		// Edge case: the process never emits exit and does not auto-exit after termination signals.
		// Dependencies: Node-like fake process events, fake termination timers, and first-prompt startup recovery.
		const scheduler = createFakeScheduler();
		const failure = new Error("spawn pi ENOENT");
		const fake = createFakeRunnerFactory({
			scheduler,
			onSpawn: (process) => {
				process.stdin.once("write", () => {
					process.error(failure);
					process.close();
				});
			},
			startupGate: new ChildStartupGate(),
			childStartupConfig: {
				authRetry: { maxRetries: 0, delayMs: 1 },
			},
			exitOnSignal: "NEVER",
		});
		const runner = await fake.factory(createRunnerOptions());
		let settled = false;
		const outcomePromise = runner
			.prompt("spawn failure", undefined)
			.catch((error: unknown) => error)
			.then((outcome) => {
				settled = true;
				return outcome;
			});
		await waitForSpawnCount(fake, 1);
		for (let index = 0; index < 10 && !settled; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (scheduler.scheduled.length > 0) {
				scheduler.runNext();
			}
		}

		const outcome = await outcomePromise;

		expect(settled).toBe(true);
		expect(outcome).toMatchObject({ message: failure.message });
		expect(fake.spawned[0]?.process.killedSignals).toEqual([]);
	});

	test("rejects active prompt when child stdin errors during recovery wait", async () => {
		// Purpose: child stdin stream errors must not crash the parent process or leave active prompts hanging.
		// Input and expected output: stdin emits EPIPE and the active prompt rejects with that error.
		// Edge case: stream error happens while the child is between retryable agent turns.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const { child, prompt: result } = await startRunnerPrompt(
			fake,
			"task",
			undefined,
		);
		respond(child, "1", "prompt");
		retryablePromptFailure(child);

		expect(() => {
			child.stdin.emit("error", new Error("EPIPE"));
		}).not.toThrow();

		await expect(result).rejects.toThrow("EPIPE");
	});

	test("does not write UI responses after disposal", async () => {
		// Purpose: cleanup may receive buffered child UI requests after SIGTERM and must not write into a closed stdin pipe.
		// Input and expected output: after a completed prompt and disposal, a late UI request leaves stdin writes unchanged.
		// Edge case: blocking child UI request arrives after the runner is logically closed.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const { runner, child, prompt } = await startRunnerPrompt(
			fake,
			"task",
			undefined,
		);
		respond(child, "1", "prompt");
		completePrompt(child, "answer");
		await prompt;

		await runner.dispose();
		const writesAfterDispose = [...child.stdin.writes];

		child.stdout.emit(
			"data",
			`${JSON.stringify({
				type: "extension_ui_request",
				id: "late-ui",
				method: "input",
			})}\n`,
		);

		expect(child.stdin.writes).toEqual(writesAfterDispose);
	});

	test("kills the child process during disposal", async () => {
		// Purpose: successful council completion must not leave participant processes running.
		// Input and expected output: dispose terminates the single child process.
		// Edge case: dispose is idempotent for repeated cleanup paths.
		// Dependencies: fake child process.
		const fake = createFakeRunnerFactory();
		const { runner, child, prompt } = await startRunnerPrompt(
			fake,
			"task",
			undefined,
		);
		prompt.catch(() => undefined);

		await runner.dispose();
		await runner.dispose();

		expect(child.killedSignals).toEqual(["SIGTERM"]);
	});
});
