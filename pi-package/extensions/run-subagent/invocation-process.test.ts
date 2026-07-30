import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InvocationLaunchConfiguration } from "./invocation-contracts";
import {
	buildChildArgs,
	defaultRuntimeFacts,
	formatExitFailure,
	readAssistantText,
	terminalObservation,
	terminateProcess,
	withTimeout,
} from "./invocation-process";

/** Creates a child process that exits at a controlled shutdown stage. */
function createShutdownChild(exitAt: "abort" | "term" | "kill" | "stubborn"): {
	readonly child: ChildProcess;
	readonly writes: string[];
	readonly signals: string[];
} {
	const child = new EventEmitter();
	const stdin = new EventEmitter();
	const writes: string[] = [];
	const signals: string[] = [];
	Object.assign(stdin, {
		writable: true,
		end: (value: string) => {
			writes.push(value);
			if (exitAt === "abort") {
				queueMicrotask(() => child.emit("close", 0, null));
			}
		},
	});
	Object.assign(child, {
		stdin,
		exitCode: null,
		signalCode: null,
		kill: (signal: string) => {
			signals.push(signal);
			if (
				(exitAt === "term" && signal === "SIGTERM") ||
				(exitAt === "kill" && signal === "SIGKILL")
			) {
				queueMicrotask(() => child.emit("close", null, signal));
			}
			return true;
		},
	});
	return { child: child as ChildProcess, writes, signals };
}

describe("invocation process helpers", () => {
	test("builds new and resumed worker arguments with explicit launch policy", () => {
		// Purpose: process arguments must isolate extensions and preserve exactly one session selection mode.
		// Input and expected output: new and resumed launches share package, model, and thinking arguments.
		// Edge case: prompt-free launch omits model policy while a resumed launch omits a new session ID.
		// Dependencies: pure production argument builder.
		const launch: InvocationLaunchConfiguration = {
			cwd: "/tmp",
			modelId: "openai/test-model",
			provider: "openai",
			thinking: "off",
			depth: 1,
			parentAuthVerified: true,
			runtimeFacts: defaultRuntimeFacts(),
		};

		expect({
			created: buildChildArgs({
				packagePath: "/package",
				childPiSessionId: "child-id",
				childSessionDir: "/sessions",
				launch,
			}),
			resumed: buildChildArgs({
				packagePath: "/package",
				childPiSessionId: "ignored-id",
				childSessionDir: "/sessions",
				childSessionFile: "/sessions/child.jsonl",
				launch,
			}),
			promptFree: buildChildArgs({
				packagePath: "/package",
				childPiSessionId: "child-id",
				childSessionDir: "/sessions",
			}),
		}).toEqual({
			created: [
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				"/package",
				"--session-dir",
				"/sessions",
				"--session-id",
				"child-id",
				"--model",
				"openai/test-model",
				"--thinking",
				"off",
			],
			resumed: [
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				"/package",
				"--session-dir",
				"/sessions",
				"--session",
				"/sessions/child.jsonl",
				"--model",
				"openai/test-model",
				"--thinking",
				"off",
			],
			promptFree: [
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				"/package",
				"--session-dir",
				"/sessions",
				"--session-id",
				"child-id",
			],
		});
	});

	test("maps shared completion and assistant text boundaries", () => {
		// Purpose: supervisor terminal events must use one shared completion decision mapping.
		// Input and expected output: success, failure, and abort decisions become the corresponding observations.
		// Edge case: malformed content is ignored and stderr exit diagnostics remain bounded.
		// Dependencies: pure production completion and boundary helpers.
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
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
			stopReason: "stop",
			timestamp: 1,
		};

		expect({
			success: terminalObservation({ kind: "success", message }, "fallback"),
			failure: terminalObservation(
				{ kind: "failure", reason: "provider failed" },
				"",
			),
			abort: terminalObservation({ kind: "abort", reason: "cancelled" }, ""),
			text: readAssistantText(message),
			malformed: readAssistantText({ content: [{ type: "image", text: "x" }] }),
			exit: formatExitFailure(9, null, "stderr detail"),
		}).toEqual({
			success: { status: "success", text: "first\nsecond" },
			failure: { status: "failure", text: "provider failed" },
			abort: { status: "abort", text: "cancelled" },
			text: "first\nsecond",
			malformed: undefined,
			exit: "exit code 9: stderr detail",
		});
	});

	test("rejects termination when the child remains active after SIGKILL", async () => {
		// Purpose: writer release must never follow a teardown that did not observe process closure.
		// Input and expected output: a stubborn child receives abort, TERM, and KILL before termination rejects.
		// Edge case: exitCode and signalCode remain null after every grace deadline.
		// Dependencies: production termination escalation and a controlled child that never emits close.
		// Arrange.
		const stubborn = createShutdownChild("stubborn");

		// Act.
		let error = "";
		try {
			await terminateProcess(stubborn.child);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}

		// Assert.
		expect({ error, signals: stubborn.signals }).toEqual({
			error: "child process remained active after SIGKILL",
			signals: ["SIGTERM", "SIGKILL"],
		});
	}, 25_000);

	test("owns timeout settlement and graceful shutdown", async () => {
		// Purpose: process and timer cleanup must settle through bounded owned resources.
		// Input and expected output: resolved work clears its timer and a child exits after the RPC abort command.
		// Edge case: a never-settling operation rejects at its deadline without retaining the timer.
		// Dependencies: controlled evented child and production timeout and teardown helpers.
		const abort = createShutdownChild("abort");
		await terminateProcess(abort.child);
		const resolved = await withTimeout(Promise.resolve("done"), 100, "late");
		let timedOut = false;
		try {
			await withTimeout(new Promise<never>(() => undefined), 0, "deadline");
		} catch (error) {
			timedOut = error instanceof Error && error.message === "deadline";
		}

		expect({
			resolved,
			timedOut,
			abortWrites: abort.writes,
			abortSignals: abort.signals,
		}).toEqual({
			resolved: "done",
			timedOut: true,
			abortWrites: ['{"id":"abort","type":"abort"}\n'],
			abortSignals: [],
		});
	});
});
