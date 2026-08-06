import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type KnowledgeRootRuntime,
	registerKnowledgeRootRuntime,
} from "../../shared/knowledge-runtime";
import {
	cancelKnowledgeRuntimeOwner,
	createWorkerKnowledgeHierarchyClient,
	handleKnowledgeRuntimeRequest,
} from "./knowledge-runtime";
import type { WorkerRuntimeBridge } from "./runtime-bridge";
import type { RuntimeRequest } from "./runtime-wire";

const OWNER_ID = "runtime-1";
const SCOPE = {
	projectDirectoryName: `project-${"a".repeat(64)}`,
	branchName: "feature/a",
} as const;

/** Creates one extension API carrier shared by run-subagent and knowledge. */
function createPi(): ExtensionAPI {
	return { events: new EventEmitter() } as unknown as ExtensionAPI;
}

/** Adds the common validated runtime identity to one operation-specific request. */
function request(
	operation: RuntimeRequest["operation"],
	payload: RuntimeRequest["payload"],
): RuntimeRequest {
	return {
		requestId: `request-${operation}`,
		runtimeLeaseId: OWNER_ID,
		ownerPiSessionId: "owner-1",
		operation,
		payload,
	} as RuntimeRequest;
}

describe("run-subagent knowledge runtime integration", () => {
	/**
	 * Proves the root adapter routes every knowledge operation and owner cancellation without owning semantics.
	 * Inputs and expected outputs: read, acquire, release, cancel, and disconnect cleanup reach the registered coordinator with exact values.
	 * Edge case: unrelated run-subagent operations remain unhandled for their existing dispatcher.
	 * Dependencies: the shared registry publishes the knowledge-owned root coordinator.
	 */
	test("routes only knowledge operations to the registered root coordinator", async () => {
		// Arrange: one recording root runtime exposes the narrow knowledge contract.
		const pi = createPi();
		const calls: unknown[] = [];
		const root: KnowledgeRootRuntime = {
			read: async (scope) => {
				calls.push(["read", scope]);
				return { global: "global", local: "local" };
			},
			acquire: async (ownerId, scope) => {
				calls.push(["acquire", ownerId, scope]);
				return {
					leaseId: "lease-1",
					snapshots: { global: "global", local: "local" },
				};
			},
			release: async (ownerId, leaseId) => {
				calls.push(["release", ownerId, leaseId]);
			},
			cancel: (ownerId, requestId) => {
				calls.push(["cancel", ownerId, requestId]);
			},
		};
		registerKnowledgeRootRuntime(pi, root);

		// Act: route all approved operations and one unrelated existing request.
		const read = await handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("knowledge_read", { scope: SCOPE }),
		);
		const acquire = await handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("knowledge_acquire", { scope: SCOPE }),
		);
		const release = await handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("knowledge_release", { leaseId: "lease-1" }),
		);
		const cancel = await handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("knowledge_cancel", { requestId: "request-knowledge_acquire" }),
		);
		const unrelated = await handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("delivery_acknowledgment", {}),
		);
		cancelKnowledgeRuntimeOwner(pi, OWNER_ID);

		// Assert: adapter results and calls contain no generic broker behavior.
		expect(read).toEqual({ global: "global", local: "local" });
		expect(acquire).toMatchObject({ leaseId: "lease-1" });
		expect(release).toEqual({ acknowledged: true });
		expect(cancel).toEqual({ acknowledged: true });
		expect(unrelated).toBeUndefined();
		expect(calls).toEqual([
			["read", SCOPE],
			["acquire", OWNER_ID, SCOPE],
			["release", OWNER_ID, "lease-1"],
			["cancel", OWNER_ID, "request-knowledge_acquire"],
			["cancel", OWNER_ID, undefined],
		]);
	});

	/**
	 * Proves child bridge methods are exposed as a narrow hierarchy client without transport details.
	 * Inputs and expected outputs: read, acquire, and release delegate exact values to one active worker bridge.
	 * Edge case: the caller's AbortSignal is preserved by identity.
	 * Dependencies: bridge request/response behavior is owned by its dedicated tests.
	 */
	test("creates a narrow child hierarchy client", async () => {
		// Arrange: one structural worker bridge records method arguments.
		const calls: unknown[] = [];
		const signal = new AbortController().signal;
		const bridge = {
			requestKnowledgeRead: async (scope: unknown) => {
				calls.push(["read", scope]);
				return { global: null, local: "local" };
			},
			requestKnowledgeAcquire: async (scope: unknown, value: unknown) => {
				calls.push(["acquire", scope, value]);
				return {
					leaseId: "lease-1",
					snapshots: { global: null, local: "local" },
				};
			},
			requestKnowledgeRelease: async (leaseId: string) => {
				calls.push(["release", leaseId]);
			},
		} as WorkerRuntimeBridge;
		const client = createWorkerKnowledgeHierarchyClient(bridge);

		// Act: use only the knowledge hierarchy interface.
		await client.read(SCOPE);
		await client.acquire(SCOPE, signal);
		await client.release("lease-1");

		// Assert: exact scope, signal, and lease values reach the bridge.
		expect(calls).toEqual([
			["read", SCOPE],
			["acquire", SCOPE, signal],
			["release", "lease-1"],
		]);
	});

	/**
	 * Proves hierarchy failures cross IPC only as one fixed safe error.
	 * Inputs and expected outputs: a root storage error containing URL credentials, prompt, and knowledge rejects generically.
	 * Edge case: the raw error is not present in the outgoing error message.
	 * Dependencies: runtime-wire already rejects malformed values before this adapter.
	 */
	test("maps root knowledge failures to a fixed safe error", async () => {
		// Arrange: root runtime throws prohibited sensitive content.
		const pi = createPi();
		const secret =
			"https://user:password@example.invalid prompt private knowledge";
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		registerKnowledgeRootRuntime(pi, {
			read: async () => {
				throw new Error(secret);
			},
			acquire: async () => {
				throw new Error(secret);
			},
			release: async () => {
				throw new Error(secret);
			},
			cancel: () => undefined,
		});

		// Act: request one read through the adapter.
		const result = handleKnowledgeRuntimeRequest(
			pi,
			OWNER_ID,
			request("knowledge_read", { scope: SCOPE }),
		);

		try {
			// Assert: only the fixed transport-safe failure crosses the boundary.
			await expect(result).rejects.toThrow(
				"knowledge hierarchy operation failed",
			);
			await expect(result).rejects.not.toThrow(secret);
			// The original error is logged locally for root-side diagnosability.
			expect(writes.some((w) => w.includes(secret))).toBe(true);
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});
