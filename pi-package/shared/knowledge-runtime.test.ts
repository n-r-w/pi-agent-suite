import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getKnowledgeHierarchyClient,
	getKnowledgeRootRuntime,
	type KnowledgeHierarchyClient,
	type KnowledgeRootRuntime,
	readKnowledgeBlock,
	registerKnowledgeContextRuntime,
	registerKnowledgeHierarchyClient,
	registerKnowledgeRootRuntime,
} from "./knowledge-runtime";

/** Creates one extension API carrier without loading unrelated extension behavior. */
function createPi(): ExtensionAPI {
	return { events: new EventEmitter() } as unknown as ExtensionAPI;
}

describe("knowledge runtime registry", () => {
	/**
	 * Proves explicit model-request builders see one process-local knowledge source when registered.
	 * Inputs and expected outputs: absence returns null, registration returns the source block, and disposal restores absence.
	 * Edge case: disposal cannot clear a newer replacement registration.
	 * Dependencies: one EventEmitter acts as Pi's process-local cross-extension carrier.
	 */
	test("publishes and disposes the context source without fallback", async () => {
		// Arrange: no source exists before the knowledge extension loads.
		const pi = createPi();
		const ctx = {} as ExtensionContext;
		const first = { readBlock: async () => "<knowledge>first</knowledge>" };
		const second = { readBlock: async () => "<knowledge>second</knowledge>" };

		// Act: replace the source, dispose the stale registration, then dispose the owner.
		expect(await readKnowledgeBlock(pi, ctx)).toBeNull();
		const disposeFirst = registerKnowledgeContextRuntime(pi, first);
		expect(await readKnowledgeBlock(pi, ctx)).toBe(
			"<knowledge>first</knowledge>",
		);
		const disposeSecond = registerKnowledgeContextRuntime(pi, second);
		disposeFirst();

		// Assert: stale disposal preserves the replacement and owner disposal removes it.
		expect(await readKnowledgeBlock(pi, ctx)).toBe(
			"<knowledge>second</knowledge>",
		);
		disposeSecond();
		expect(await readKnowledgeBlock(pi, ctx)).toBeNull();
	});

	/**
	 * Proves root and child hierarchy contracts use separate narrow registry slots.
	 * Inputs and expected outputs: both exact objects are retrievable and independently disposable.
	 * Edge case: removing the child client leaves the root coordinator available.
	 * Dependencies: transport behavior is tested separately by run-subagent bridge tests.
	 */
	test("keeps root coordination and child transport ownership separate", () => {
		// Arrange: minimal typed objects expose no generic message broker surface.
		const pi = createPi();
		const root = {} as KnowledgeRootRuntime;
		const child = {} as KnowledgeHierarchyClient;

		// Act: register both process-local roles.
		const disposeRoot = registerKnowledgeRootRuntime(pi, root);
		const disposeChild = registerKnowledgeHierarchyClient(pi, child);

		// Assert: each slot preserves exact ownership and disposal semantics.
		expect(getKnowledgeRootRuntime(pi)).toBe(root);
		expect(getKnowledgeHierarchyClient(pi)).toBe(child);
		disposeChild();
		expect(getKnowledgeHierarchyClient(pi)).toBeUndefined();
		expect(getKnowledgeRootRuntime(pi)).toBe(root);
		disposeRoot();
		expect(getKnowledgeRootRuntime(pi)).toBeUndefined();
	});
});
