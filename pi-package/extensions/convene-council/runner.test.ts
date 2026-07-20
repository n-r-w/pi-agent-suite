import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import {
	COUNCIL_RPC_ABORT_GRACE_MS,
	COUNCIL_RPC_TERM_GRACE_MS,
	createParticipantRunnerFactory,
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
		event: "error" | "exit",
		handler: ((error: Error) => void) | (() => void),
	): unknown;
	error(error: Error): void;
	exit(): void;
}

/** Creates one fake child process with writable stdin and evented stdout/stderr. */
function createFakeProcess(): FakeProcess {
	const stdin = new EventEmitter() as FakeStdin;
	Object.defineProperty(stdin, "writes", { value: [] });
	stdin.write = function write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	};
	const stdout = new EventEmitter();
	stdout.on("error", () => {});
	const stderr = new EventEmitter();
	const killedSignals: string[] = [];
	return {
		stdin,
		stdout,
		stderr,
		killedSignals,
		kill(signal = "SIGTERM"): boolean {
			killedSignals.push(signal);
			return true;
		},
		on(
			event: "error" | "exit",
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
	};
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

function createFakeRunnerFactory(
	scheduler = createFakeScheduler(),
	onSpawn?: (process: FakeProcess, attempt: number) => void,
): {
	readonly factory: ParticipantRunnerFactory;
	readonly spawned: Array<{
		readonly command: string;
		readonly args: readonly string[];
		readonly options: {
			readonly cwd: string;
			readonly env: Record<string, string>;
		};
		readonly process: FakeProcess;
	}>;
} {
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
			clearTimeout: scheduler.clearTimeout,
			spawnPi(command, args, options) {
				const process = createFakeProcess();
				spawned.push({ command, args, options, process });
				onSpawn?.(process, spawned.length);
				return process;
			},
		}),
	};
}

/** Returns a minimal runner factory input for lifecycle tests. */
function createRunnerOptions() {
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
			modelRegistry: {
				find(provider: string, modelId: string) {
					return provider === "openai" && modelId === "model-a"
						? createModel("openai", "model-a")
						: undefined;
				},
			},
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

/** Emits one assistant answer and agent_end for the active prompt. */
function retryablePromptFailure(process: FakeProcess): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "temporary failure" }], api: "test", provider: "openai", model: "model-a", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "server error 500", timestamp: 1 } })}\n`,
	);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_end" })}\n`);
}

function completePrompt(process: FakeProcess, content: string): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: content }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
	);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_end" })}\n`);
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
	await Promise.resolve();
	const child = fake.spawned.at(-1)?.process as FakeProcess;
	return { runner, child, prompt };
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
		await Promise.resolve();
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
		await Promise.resolve();
		expect(fake.spawned).toHaveLength(1);

		const firstChild = fake.spawned[0]?.process as FakeProcess;
		respond(firstChild, "1", "prompt");
		await new Promise((resolve) => setTimeout(resolve, 0));
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

	test("retries a first-prompt auth race with a fresh participant process", async () => {
		// Purpose: a child-only OAuth miss must recover after the parent runtime already resolved credentials.
		// Input and expected output: the first process rejects prompt auth, the replacement completes with the same session arguments.
		// Edge case: the failed process emits no session events before prompt rejection.
		// Dependencies: sequential fake RPC transcripts and the shared bounded retry policy.
		const fake = createFakeRunnerFactory(
			createFakeScheduler(),
			(process, attempt) => {
				queueMicrotask(() => {
					if (attempt === 1) {
						rejectPrompt(process, NO_OPENAI_API_KEY_ERROR);
						return;
					}
					respond(process, "1", "prompt");
					completePrompt(process, "recovered answer");
				});
			},
		);
		const runner = await fake.factory(createRunnerOptions());

		const result = await runner.prompt("recover auth", undefined);

		expect(result.content).toEqual([
			{ type: "text", text: "recovered answer" },
		]);
		expect(fake.spawned).toHaveLength(2);
		expect(fake.spawned[0]?.process.killedSignals).toEqual(["SIGTERM"]);
		expect(fake.spawned[1]?.args).toEqual(fake.spawned[0]?.args);
		await runner.dispose();
	});

	test("stops after three retries when participant auth startup keeps failing", async () => {
		// Purpose: child auth recovery must remain bounded when every fresh process misses OAuth credentials.
		// Input and expected output: four identical prompt preflight failures return the original auth error.
		// Edge case: every failed process is terminated before the next launch.
		// Dependencies: repeating fake RPC failure and the shared retry limit.
		const fake = createFakeRunnerFactory(createFakeScheduler(), (process) => {
			queueMicrotask(() => rejectPrompt(process, NO_OPENAI_API_KEY_ERROR));
		});
		const runner = await fake.factory(createRunnerOptions());

		await expect(runner.prompt("recover auth", undefined)).rejects.toThrow(
			NO_OPENAI_API_KEY_ERROR,
		);
		expect(fake.spawned).toHaveLength(4);
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
		const fake = createFakeRunnerFactory(createFakeScheduler(), (process) => {
			queueMicrotask(() => rejectPrompt(process, "prompt rejected"));
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

	test("cancels participant auth recovery during retry backoff", async () => {
		// Purpose: parent cancellation must stop delayed auth recovery without creating another process.
		// Input and expected output: the first startup misses auth, then abort cancels the pending retry.
		// Edge case: no child process is active when cancellation arrives.
		// Dependencies: AbortController and one automatic fake RPC rejection.
		const controller = new AbortController();
		const fake = createFakeRunnerFactory(createFakeScheduler(), (process) => {
			queueMicrotask(() => rejectPrompt(process, NO_OPENAI_API_KEY_ERROR));
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
		// Edge case: prompt command success does not complete without agent_end.
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
		const fake = createFakeRunnerFactory(scheduler);
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
		const fake = createFakeRunnerFactory(scheduler);
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
