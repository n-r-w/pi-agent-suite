import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExitTarget, LaunchGate } from "./launch-gate";

/** Process stand-in that records the exit listeners and the exit code. */
interface ExitTargetFake extends ExitTarget {
	/** Listeners that the code under test registered for the exit event. */
	readonly listeners: Array<() => void>;
}

/** Session context that records shutdown requests. */
interface ContextFake extends ExtensionContext {
	/** One entry per shutdown request. */
	readonly shutdowns: number[];
}

/** Creates a process stand-in, so that a test never changes the exit code of the test run. */
function createExitTarget(): ExitTargetFake {
	const listeners: Array<() => void> = [];
	return {
		listeners,
		exitCode: undefined,
		once: (_event: "exit", listener: () => void) => {
			listeners.push(listener);
		},
	};
}

/** Creates a session context that counts shutdown requests. */
function createContext(): ContextFake {
	const shutdowns: number[] = [];
	return {
		shutdowns,
		shutdown: () => {
			shutdowns.push(shutdowns.length);
		},
	} as unknown as ContextFake;
}

/** Returns a promise that settles when the caller resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/** Reports whether a promise settles before the next macrotask. */
function isSettled(promise: Promise<void>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
	]);
}

describe("launch gate", () => {
	test("holds input until the first session start settles", async () => {
		// Purpose: input that arrives before the definition is applied must wait for it.
		// Input and expected output: wait stays pending before a session start and while its run is open, and settles when the run settles.
		// Edge case: the wait was requested before the run began.
		// Dependencies: none.
		const gate = new LaunchGate(createExitTarget());
		const run = deferred();

		const waiting = gate.wait();
		expect(await isSettled(waiting)).toBe(false);
		const running = gate.run(() => run.promise);
		expect(await isSettled(waiting)).toBe(false);
		expect(await isSettled(gate.wait())).toBe(false);

		run.resolve();
		await running;
		expect(await isSettled(waiting)).toBe(true);
		expect(await isSettled(gate.wait())).toBe(true);
	});

	test("settles the wait when the run rejects and returns the failure to its caller", async () => {
		// Purpose: an unexpected error of session start must not hold input forever.
		// Input and expected output: the run promise rejects with the original error, and wait settles.
		// Edge case: the rejection reaches only the caller of run.
		// Dependencies: none.
		const gate = new LaunchGate(createExitTarget());
		const failure = new Error("session start failed");

		const result = gate.run(() => Promise.reject(failure));

		await expect(result).rejects.toBe(failure);
		expect(await isSettled(gate.wait())).toBe(true);
	});

	test("reports a failed launch, requests shutdown, and marks a nonzero exit", async () => {
		// Purpose: the launcher gets the reason, and the process ends with a nonzero exit code, also when Pi exits with code 0.
		// Input and expected output: stderr holds the reason, one shutdown is requested, the gate reports the failure, and the exit listener turns code 0 into 1.
		// Edge case: Pi sets exit code 0 before the exit event, as it does in RPC mode.
		// Dependencies: process stderr and the exit target.
		const target = createExitTarget();
		const gate = new LaunchGate(target);
		const ctx = createContext();
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			await gate.run(async () => {
				gate.fail(ctx, "agent Worker was not found");
			});

			expect(stderr.mock.calls.flat().join("")).toContain(
				"agent Worker was not found",
			);
		} finally {
			stderr.mockRestore();
		}
		expect(ctx.shutdowns).toHaveLength(1);
		expect(gate.failed).toBe(true);
		expect(target.listeners).toHaveLength(1);
		target.exitCode = 0;
		target.listeners[0]?.();
		expect(target.exitCode).toBe(1);
	});

	test("marks the exit once and clears the failure when a new run begins", async () => {
		// Purpose: a repeated failure must not stack exit listeners, and a later successful session start must not stay failed.
		// Input and expected output: two failures register one exit listener, and the next run starts without a failure.
		// Edge case: the second failure happens in a later run.
		// Dependencies: process stderr and the exit target.
		const target = createExitTarget();
		const gate = new LaunchGate(target);
		const ctx = createContext();
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			await gate.run(async () => gate.fail(ctx, "first"));
			await gate.run(async () => gate.fail(ctx, "second"));
		} finally {
			stderr.mockRestore();
		}
		expect(target.listeners).toHaveLength(1);
		expect(gate.failed).toBe(true);

		await gate.run(async () => undefined);

		expect(gate.failed).toBe(false);
	});
});
