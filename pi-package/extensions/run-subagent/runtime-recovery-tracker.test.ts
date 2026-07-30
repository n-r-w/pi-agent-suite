import { describe, expect, test } from "bun:test";
import { RuntimeFailureRecoveryTracker } from "./runtime-recovery-tracker";

/** Creates a deterministic promise gate for recovery lifecycle tests. */
function createGate(): {
	readonly promise: Promise<void>;
	readonly release: () => void;
} {
	let release = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("RuntimeFailureRecoveryTracker", () => {
	test("awaits a recovery admitted before shutdown closes admission", async () => {
		// Purpose: shutdown must retain every recovery factory admitted while ownership is open.
		// Input and expected output: one gated recovery and root recovery each execute once; drain remains pending until both settle.
		// Edge case: root recovery fulfills before the earlier runtime recovery.
		// Dependencies: deterministic promise gate and tracker admission lifecycle only.
		const tracker = new RuntimeFailureRecoveryTracker();
		const recoveryGate = createGate();
		const calls: string[] = [];
		const admitted = tracker.start(async () => {
			calls.push("runtime");
			await recoveryGate.promise;
		});
		let settled = false;

		const shutdown = tracker
			.closeAndDrain(async () => {
				calls.push("root");
			})
			.then(() => {
				settled = true;
			});
		await Promise.resolve();

		expect({ admitted, calls, settled }).toEqual({
			admitted: true,
			calls: ["runtime", "root"],
			settled: false,
		});
		recoveryGate.release();
		await shutdown;
		expect(settled).toBe(true);
	});

	test("extends an open drain for a recovery admitted during its pending batch", async () => {
		// Purpose: an open drain must converge after factories admitted while its current batch is pending.
		// Input and expected output: the second gated recovery joins the first drain and both factories execute once.
		// Edge case: the first recovery settles while the later recovery remains pending.
		// Dependencies: deterministic promise gates and the open drain contract only.
		const tracker = new RuntimeFailureRecoveryTracker();
		const firstGate = createGate();
		const secondGate = createGate();
		const calls: string[] = [];
		tracker.start(async () => {
			calls.push("first");
			await firstGate.promise;
		});
		let settled = false;
		const drain = tracker.drain().then(() => {
			settled = true;
		});
		await Promise.resolve();

		const admitted = tracker.start(async () => {
			calls.push("second");
			await secondGate.promise;
		});
		firstGate.release();
		await Promise.resolve();
		await Promise.resolve();

		expect({ admitted, calls, settled }).toEqual({
			admitted: true,
			calls: ["first", "second"],
			settled: false,
		});
		secondGate.release();
		await drain;
		expect(settled).toBe(true);
	});

	test("does not execute a recovery factory admitted after shutdown closes", async () => {
		// Purpose: closing shutdown admission must prevent late recovery work from acquiring lifecycle ownership.
		// Input and expected output: a pending root drain closes admission; the later factory is rejected and never executes.
		// Edge case: late admission occurs while the closed drain is still pending.
		// Dependencies: deterministic promise gate and the closed admission contract only.
		const tracker = new RuntimeFailureRecoveryTracker();
		const rootGate = createGate();
		let lateCalls = 0;
		const shutdown = tracker.closeAndDrain(async () => {
			await rootGate.promise;
		});
		await Promise.resolve();

		const admitted = tracker.start(async () => {
			lateCalls += 1;
		});
		expect({ admitted, lateCalls }).toEqual({
			admitted: false,
			lateCalls: 0,
		});
		rootGate.release();
		await shutdown;
		expect(lateCalls).toBe(0);
	});

	test("shares one closed drain and failure outcome across concurrent shutdowns", async () => {
		// Purpose: concurrent shutdown drains must observe one admitted set and one rejection outcome.
		// Input and expected output: one gated rejection and only the first root factory execute; both callers receive the same rejection.
		// Edge case: the second shutdown supplies a different root factory after admission is closed.
		// Dependencies: deterministic promise gate and tracker close coalescing only.
		const tracker = new RuntimeFailureRecoveryTracker();
		const rejectionGate = createGate();
		const failure = new Error("controlled recovery failure");
		let runtimeCalls = 0;
		let firstRootCalls = 0;
		let secondRootCalls = 0;
		tracker.start(async () => {
			runtimeCalls += 1;
			await rejectionGate.promise;
			throw failure;
		});

		const first = tracker.closeAndDrain(async () => {
			firstRootCalls += 1;
		});
		const second = tracker.closeAndDrain(async () => {
			secondRootCalls += 1;
		});
		rejectionGate.release();
		const outcomes = await Promise.allSettled([first, second]);

		expect({
			sameDrain: first === second,
			runtimeCalls,
			firstRootCalls,
			secondRootCalls,
			outcomes,
		}).toEqual({
			sameDrain: true,
			runtimeCalls: 1,
			firstRootCalls: 1,
			secondRootCalls: 0,
			outcomes: [
				{ status: "rejected", reason: failure },
				{ status: "rejected", reason: failure },
			],
		});
	});

	test("preserves undefined as an explicit recovery rejection", async () => {
		// Purpose: every rejected recovery value must reject shutdown instead of matching a no-failure sentinel.
		// Input and expected output: a recovery rejects with undefined and the closed drain rejects with an Error.
		// Edge case: undefined is both a valid Promise rejection reason and the former empty-state value.
		// Dependencies: tracker settlement discrimination only.
		const tracker = new RuntimeFailureRecoveryTracker();
		tracker.start(() => Promise.reject(undefined));

		const outcome = await tracker
			.closeAndDrain(async () => undefined)
			.then(
				() => ({ status: "fulfilled" as const }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			);

		expect(outcome).toEqual({
			status: "rejected",
			reason: new Error("undefined"),
		});
	});
});
