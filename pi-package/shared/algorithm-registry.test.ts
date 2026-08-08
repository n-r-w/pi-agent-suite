import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getTriggerAlgorithm,
	getTriggerAlgorithms,
	registerTriggerAlgorithm,
	type TriggerAlgorithm,
	type TriggerAlgorithmRunResult,
} from "./algorithm-registry";

/** One runnable algorithm used by registry contract tests. */
function algorithm(
	type: string,
	description = `Runs ${type}`,
): TriggerAlgorithm {
	return {
		type,
		description,
		async run() {
			return { ok: true };
		},
	};
}

/** Builds one extension API with an isolated shared event bus. */
function createPi(): ExtensionAPI {
	const bus = new EventEmitter();
	return {
		events: bus,
	} as unknown as ExtensionAPI;
}

describe("trigger algorithm registry", () => {
	/**
	 * Proves registration stores one algorithm per type and reads it back in order.
	 * Inputs and expected outputs: two distinct algorithms register and list in registration order.
	 * Edge case: the registry is scoped per pi instance.
	 * Dependencies: the WeakMap holder and the per-pi cache.
	 */
	test("registers and lists algorithms per pi instance", () => {
		// Arrange: two isolated pi instances.
		const firstPi = createPi();
		const secondPi = createPi();

		// Act: register one algorithm on each instance.
		const dispose = registerTriggerAlgorithm(firstPi, algorithm("a"));
		registerTriggerAlgorithm(secondPi, algorithm("b"));

		// Assert: each instance lists only its own algorithm and cleanup removes it.
		expect(getTriggerAlgorithms(firstPi).map(({ type }) => type)).toEqual([
			"a",
		]);
		expect(getTriggerAlgorithms(secondPi).map(({ type }) => type)).toEqual([
			"b",
		]);
		dispose();
		expect(getTriggerAlgorithms(firstPi)).toEqual([]);
		expect(getTriggerAlgorithms(secondPi).map(({ type }) => type)).toEqual([
			"b",
		]);
	});

	/**
	 * Proves duplicate types overwrite the stored algorithm rather than stacking.
	 * Input and expected output: the second registration of the same type replaces the first.
	 * Edge case: the previous entry's dispose callback does not clear the replacement.
	 * Dependencies: keyed storage with overwrite semantics.
	 */
	test("overwrites a duplicate type and keeps the replacement on old disposal", () => {
		// Arrange: one pi instance.
		const pi = createPi();

		// Act: register the same type twice.
		const disposeFirst = registerTriggerAlgorithm(pi, algorithm("a", "first"));
		registerTriggerAlgorithm(pi, algorithm("a", "second"));
		disposeFirst();

		// Assert: the replacement survives the old entry's disposal.
		expect(getTriggerAlgorithm(pi, "a")?.description).toBe("second");
	});

	/**
	 * Proves a fresh instance resolves algorithms registered by another extension through the event bus.
	 * Inputs and expected outputs: registration on one extension API is visible to a second instance with a shared bus.
	 * Edge case: unknown types resolve to undefined without throwing.
	 * Dependencies: the synchronous request-reply channel.
	 */
	test("resolves algorithms registered by another extension on a shared bus", () => {
		// Arrange: one extension registers on a shared bus; a second instance shares it.
		const bus = new EventEmitter();
		const first = { events: bus } as unknown as ExtensionAPI;
		const second = { events: bus } as unknown as ExtensionAPI;
		registerTriggerAlgorithm(first, algorithm("local"));
		registerTriggerAlgorithm(first, algorithm("global"));

		// Act: resolve through the second instance.
		const resolved = getTriggerAlgorithm(second, "local");
		const missing = getTriggerAlgorithm(second, "unknown");

		// Assert: the shared bus exposes the registered algorithm and unknown types stay undefined.
		expect(resolved?.type).toBe("local");
		expect(missing).toBeUndefined();
		expect(
			getTriggerAlgorithms(second)
				.map(({ type }) => type)
				.sort(),
		).toEqual(["global", "local"]);
	});

	/**
	 * Proves the run boundary returns the algorithm's own result.
	 * Inputs and expected outputs: a successful run returns { ok: true }.
	 * Edge case: the context and signal are forwarded unchanged.
	 * Dependencies: the registered run function is the single execution path.
	 */
	test("forwards the caller context and signal to the algorithm run", async () => {
		// Arrange: one algorithm captures its invocation inputs.
		const pi = createPi();
		const ctx = { marker: "initiating" } as unknown as ExtensionContext;
		const signal = new AbortController().signal;
		let receivedContext: ExtensionContext | undefined;
		let receivedSignal: AbortSignal | undefined;
		registerTriggerAlgorithm(pi, {
			type: "captured",
			description: "Captures inputs",
			async run(callCtx, callSignal) {
				receivedContext = callCtx;
				receivedSignal = callSignal;
				return { ok: true } as TriggerAlgorithmRunResult;
			},
		});

		// Act: run through the resolved algorithm.
		const result = await getTriggerAlgorithm(pi, "captured")?.run(ctx, signal);

		// Assert: the exact context and signal reached the algorithm.
		expect(result).toEqual({ ok: true });
		expect(receivedContext).toBe(ctx);
		expect(receivedSignal).toBe(signal);
	});
});
