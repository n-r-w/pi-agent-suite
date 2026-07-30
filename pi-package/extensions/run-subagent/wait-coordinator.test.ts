import { describe, expect, test } from "bun:test";
import type { OwnerIdentity } from "./domain";
import { WaitCoordinator } from "./wait-coordinator";

const OWNER: OwnerIdentity = {
	ownerPiSessionId: "owner",
	ownerSessionFile: "/tmp/owner.jsonl",
};

/** Creates a real timer handle while retaining manual deadline control. */
function createWaitHarness(): {
	readonly waits: WaitCoordinator;
	readonly clearedTimers: () => number;
	fireTimeout(): void;
} {
	let timeoutHandler: (() => void) | undefined;
	let clearedTimers = 0;
	return {
		waits: new WaitCoordinator({
			now: () => 10,
			setTimer: (handler) => {
				timeoutHandler = handler;
				return setTimeout(() => undefined, 60_000);
			},
			clearTimer: (timer) => {
				clearedTimers += 1;
				clearTimeout(timer);
			},
		}),
		clearedTimers: () => clearedTimers,
		fireTimeout: () => timeoutHandler?.(),
	};
}

describe("WaitCoordinator", () => {
	test("settles one owner resolver once", async () => {
		// Purpose: resolver mechanics must not create a second normal response.
		// Input and expected output: one admitted wait settles as timeout and a repeated settlement returns false.
		// Edge case: one same-owner admission is rejected while the first resolver exists.
		// Dependencies: controlled timer callback and production wait coordinator.
		const { waits } = createWaitHarness();
		const pending = waits.admit(
			{
				owner: OWNER,
				toolCallId: "wait-1",
				requestId: "request-1",
				expiresAt: 110,
			},
			() => undefined,
		);
		const duplicate = waits
			.admit(
				{
					owner: OWNER,
					toolCallId: "wait-2",
					requestId: "request-2",
					expiresAt: 110,
				},
				() => undefined,
			)
			.then(() => "accepted")
			.catch(() => "rejected");
		const firstSettlement = waits.settle(OWNER, { outcome: "timeout" });
		const secondSettlement = waits.settle(OWNER, { outcome: "timeout" });

		expect({
			result: await pending,
			duplicate: await duplicate,
			firstSettlement,
			secondSettlement,
		}).toEqual({
			result: { outcome: "timeout" },
			duplicate: "rejected",
			firstSettlement: true,
			secondSettlement: false,
		});
	});

	test("re-arms a timer that fires before its monotonic deadline", async () => {
		// Purpose: timer rounding must never leave a wait pending forever after one early callback.
		// Input and expected output: an early callback re-arms for the remaining fraction, and the deadline callback settles once.
		// Edge case: the monotonic clock remains strictly below expiry on the first callback.
		// Dependencies: controlled monotonic clock and injected timer callbacks.
		let now = 10;
		let timeoutCalls = 0;
		const handlers: Array<() => void> = [];
		const delays: number[] = [];
		const waits = new WaitCoordinator({
			now: () => now,
			setTimer: (handler, delayMs) => {
				handlers.push(handler);
				delays.push(delayMs);
				return {} as NodeJS.Timeout;
			},
			clearTimer: () => undefined,
		});
		const pending = waits.admit(
			{
				owner: OWNER,
				toolCallId: "wait-early",
				requestId: "request-early",
				expiresAt: 110,
			},
			() => {
				timeoutCalls += 1;
				waits.settle(OWNER, { outcome: "timeout" });
			},
		);

		now = 109.5;
		handlers[0]?.();
		const callsAfterEarlyTimer = timeoutCalls;
		now = 110;
		handlers[1]?.();

		expect({
			callsAfterEarlyTimer,
			timeoutCalls,
			delays,
			result: await pending,
		}).toEqual({
			callsAfterEarlyTimer: 0,
			timeoutCalls: 1,
			delays: [100, 0.5],
			result: { outcome: "timeout" },
		});
	});

	test("cancels one exact request and clears its timer before rejection", async () => {
		// Purpose: tool abort must target one admitted correlation and remove its resolver and timer before rejection is observed.
		// Input and expected output: a stale request cannot cancel; the exact request rejects with the supplied reason and permits readmission.
		// Edge case: owner, tool call, request, and optional runtime lease must all match.
		// Dependencies: controlled timer handle and production wait coordinator.
		const { waits, clearedTimers } = createWaitHarness();
		const correlation = {
			owner: OWNER,
			toolCallId: "wait-exact",
			requestId: "request-exact",
			runtimeLeaseId: "lease-exact",
		};
		const pending = waits
			.admit({ ...correlation, expiresAt: 110 }, () => undefined)
			.then(() => "normal")
			.catch((error: unknown) =>
				error instanceof Error ? error.message : String(error),
			);

		const staleCancelled = waits.cancel(
			{ ...correlation, requestId: "request-stale" },
			new Error("stale abort"),
		);
		const exactCancelled = waits.cancel(
			correlation,
			new Error("subagent_wait was aborted"),
		);
		if (!exactCancelled) {
			waits.cancelOwner(OWNER);
		}
		const outcome = await pending;
		const later = waits.admit(
			{
				owner: OWNER,
				toolCallId: "wait-later",
				requestId: "request-later",
				expiresAt: 110,
			},
			() => undefined,
		);
		waits.settle(OWNER, { outcome: "timeout" });

		expect({
			staleCancelled,
			exactCancelled,
			outcome,
			clearedTimers: clearedTimers(),
			later: await later,
		}).toEqual({
			staleCancelled: false,
			exactCancelled: true,
			outcome: "subagent_wait was aborted",
			clearedTimers: 2,
			later: { outcome: "timeout" },
		});
	});

	test("cancels lease-owned waits without a normal result", async () => {
		// Purpose: runtime fail-stop must cease nested waits instead of sending another result.
		// Input and expected output: cancelLease rejects only the matching runtime lease resolver.
		// Edge case: cancelling an unknown owner or lease has no effect.
		// Dependencies: controlled timer handle and production wait coordinator.
		const { waits, fireTimeout } = createWaitHarness();
		const pending = waits
			.admit(
				{
					owner: OWNER,
					toolCallId: "wait-lease",
					requestId: "request-lease",
					runtimeLeaseId: "lease-1",
					expiresAt: 110,
				},
				() => undefined,
			)
			.then(() => "normal")
			.catch(() => "ceased");
		waits.cancelOwner({
			ownerPiSessionId: "unknown",
			ownerSessionFile: "/tmp/unknown.jsonl",
		});
		fireTimeout();
		waits.cancelLease("lease-1");

		expect(await pending).toBe("ceased");
	});
});
