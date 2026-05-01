import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import {
	COUNCIL_RPC_ABORT_GRACE_MS,
	COUNCIL_RPC_TERM_GRACE_MS,
	createParticipantRunnerFactory,
} from "./runner";
import type { ParticipantRunnerFactory } from "./types";

interface FakeProcess {
	readonly stdin: { readonly writes: string[]; write(chunk: string): boolean };
	readonly stdout: EventEmitter;
	readonly stderr: EventEmitter;
	readonly killedSignals: string[];
	kill(signal?: string): boolean;
	on(event: "exit", handler: () => void): unknown;
	exit(): void;
}

/** Creates one fake child process with writable stdin and evented stdout/stderr. */
function createFakeProcess(): FakeProcess {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const killedSignals: string[] = [];
	return {
		stdin: {
			writes: [],
			write(chunk: string): boolean {
				this.writes.push(chunk);
				return true;
			},
		},
		stdout,
		stderr,
		killedSignals,
		kill(signal = "SIGTERM"): boolean {
			killedSignals.push(signal);
			return true;
		},
		on(event: "exit", handler: () => void): unknown {
			return stdout.on(event, handler);
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

function createFakeRunnerFactory(scheduler = createFakeScheduler()): {
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
			contextWindowUsageLimit: 0.7,
			contextSummary: {},
		},
		startupPlan: {
			extensionArgs: ["-e", "./pi-package"],
			env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" },
		},
		toolArgs: ["--tools", "read"],
		tools: [],
		ctx: { cwd: "/tmp/project" } as never,
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

/** Emits one assistant answer and agent_end for the active prompt. */
function completePrompt(process: FakeProcess, content: string): void {
	process.stdout.emit(
		"data",
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: content }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
	);
	process.stdout.emit("data", `${JSON.stringify({ type: "agent_end" })}\n`);
}

describe("ParticipantRunner lifecycle", () => {
	test("spawns child pi with persistent session args and disables auto-retry before returning", async () => {
		// Purpose: participant runner startup must configure one persistent child RPC session.
		// Input and expected output: spawn receives session/model/tool args and waits for set_auto_retry success.
		// Edge case: child resource-disabling and extension args are both propagated.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const runnerPromise = fake.factory(createRunnerOptions());
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
				env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" },
			},
		});
		expect(JSON.parse(child?.stdin.writes[0] ?? "{}")).toMatchObject({
			type: "set_auto_retry",
			enabled: false,
		});

		respond(child as FakeProcess, "1", "set_auto_retry");
		await runnerPromise;
	});

	test("reuses the same child process for multiple participant prompts", async () => {
		// Purpose: participant context must stay in one child session across rounds.
		// Input and expected output: two prompts write to one fake process and return two answers.
		// Edge case: prompt command success does not complete without agent_end.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const runnerPromise = fake.factory(createRunnerOptions());
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "set_auto_retry");
		const runner = await runnerPromise;

		const first = runner.prompt("first task", undefined);
		respond(child, "2", "prompt");
		completePrompt(child, "first answer");
		const second = runner.prompt("second task", undefined);
		respond(child, "3", "prompt");
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
		const runnerPromise = fake.factory({
			...createRunnerOptions(),
			onSessionEvent: (event) => events.push(event),
		});
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "set_auto_retry");
		const runner = await runnerPromise;

		const prompt = runner.prompt("inspect files", undefined);
		respond(child, "2", "prompt");
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
			id: "2",
			command: "prompt",
			success: true,
		});
	});

	test("kills the child process when initialization fails", async () => {
		// Purpose: failed set_auto_retry must not leak a spawned child process.
		// Input and expected output: initialization rejection kills the process before propagating the error.
		// Edge case: failure happens after spawn but before the runner is returned.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const runnerPromise = fake.factory(createRunnerOptions());
		const child = fake.spawned[0]?.process as FakeProcess;
		child.stdout.emit(
			"data",
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: false, error: "denied" })}\n`,
		);

		await expect(runnerPromise).rejects.toThrow("denied");
		expect(child.killedSignals).toEqual(["SIGTERM"]);
	});

	test("accepts Buffer stdout chunks from child processes", async () => {
		// Purpose: real child stdout emits Buffer chunks, not only strings.
		// Input and expected output: Buffer response initializes the runner.
		// Edge case: transport stringifies the chunk before JSONL parsing.
		// Dependencies: fake child process and CouncilRpcClient protocol.
		const fake = createFakeRunnerFactory();
		const runnerPromise = fake.factory(createRunnerOptions());
		const child = fake.spawned[0]?.process as FakeProcess;
		child.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
			),
		);

		await runnerPromise;
	});

	test("escalates parent abort from RPC abort to SIGTERM and SIGKILL", async () => {
		// Purpose: parent abort must give the child RPC session a chance to stop before process kills.
		// Input and expected output: abort command, then SIGTERM after 10s, then SIGKILL after 5s.
		// Edge case: SIGKILL is conditional on the child still running.
		// Dependencies: fake child process and fake scheduler.
		const scheduler = createFakeScheduler();
		const fake = createFakeRunnerFactory(scheduler);
		const abortController = new AbortController();
		const runnerPromise = fake.factory({
			...createRunnerOptions(),
			signal: abortController.signal,
		});
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "set_auto_retry");
		const runner = await runnerPromise;
		const prompt = runner.prompt("long task", abortController.signal);
		prompt.catch(() => undefined);
		respond(child, "2", "prompt");

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
		const runnerPromise = fake.factory({
			...createRunnerOptions(),
			signal: abortController.signal,
		});
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "set_auto_retry");
		const runner = await runnerPromise;
		const prompt = runner.prompt("long task", abortController.signal);
		prompt.catch(() => undefined);
		respond(child, "2", "prompt");

		abortController.abort();
		scheduler.runNext();
		child.exit();

		expect(scheduler.scheduled).toHaveLength(0);
		expect(child.killedSignals).toEqual(["SIGTERM"]);
	});

	test("kills the child process during disposal", async () => {
		// Purpose: successful council completion must not leave participant processes running.
		// Input and expected output: dispose terminates the single child process.
		// Edge case: dispose is idempotent for repeated cleanup paths.
		// Dependencies: fake child process.
		const fake = createFakeRunnerFactory();
		const runnerPromise = fake.factory(createRunnerOptions());
		const child = fake.spawned[0]?.process as FakeProcess;
		respond(child, "1", "set_auto_retry");
		const runner = await runnerPromise;

		await runner.dispose();
		await runner.dispose();

		expect(child.killedSignals).toEqual(["SIGTERM"]);
	});
});
