import { describe, expect, test } from "bun:test";
import type { OwnerIdentity } from "./domain";
import { WorkerRuntimeBridge } from "./runtime-bridge";
import type { RuntimeWireMessage } from "./runtime-wire";

const RUNTIME_LEASE_ID = "runtime-1";
const OWNER: OwnerIdentity = {
	ownerPiSessionId: "owner-1",
	ownerSessionFile: "/tmp/owner.jsonl",
};
const SCOPE = {
	projectDirectoryName: `project-${"a".repeat(64)}`,
	branchName: "feature/a",
} as const;

/** In-memory child channel that records requests and delivers controlled root messages. */
class WorkerChannelFake {
	readonly sent: RuntimeWireMessage[] = [];
	#handler: ((value: unknown) => void) | undefined;

	/** Keeps the worker channel available for every deterministic request. */
	public isConnected(): boolean {
		return true;
	}

	/** Records the bridge's one inbound message callback. */
	public onMessage(handler: (value: unknown) => void): void {
		this.#handler = handler;
	}

	/** Captures one validated outgoing message without process IPC. */
	public async send(value: RuntimeWireMessage): Promise<void> {
		this.sent.push(value);
	}

	/** Delivers one root message through the production parser and correlation path. */
	public emit(value: RuntimeWireMessage): void {
		this.#handler?.(value);
	}
}

/** Reads one worker request from the fake channel or fails with missing transport evidence. */
function requestAt(channel: WorkerChannelFake, index: number) {
	const message = channel.sent[index];
	if (message?.kind !== "subagents-request") {
		throw new Error(`worker request ${index} missing`);
	}
	return message.request;
}

/** Allows async dispatch and response handlers to publish their next channel message. */
async function settleBridge(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("knowledge worker runtime bridge", () => {
	/**
	 * Proves child reads and releases use typed request correlations on existing run-subagent IPC.
	 * Inputs and expected outputs: one scope returns snapshots and one lease ID receives a root acknowledgment.
	 * Edge case: knowledge text stays in the validated result and never enters an error field.
	 * Dependencies: WorkerRuntimeBridge common dispatch, response validation, and settlement acknowledgment.
	 */
	test("routes knowledge read and release through existing IPC", async () => {
		// Arrange: activate one child bridge with a controlled in-memory channel.
		const channel = new WorkerChannelFake();
		const bridge = new WorkerRuntimeBridge(
			RUNTIME_LEASE_ID,
			OWNER.ownerPiSessionId,
			channel,
		);
		bridge.activate(OWNER, async () => ({ acknowledged: true }));

		// Act: request a read, settle its root response, then release one mutation lease.
		const readPromise = bridge.requestKnowledgeRead(SCOPE);
		await settleBridge();
		const readRequest = requestAt(channel, 1);
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: RUNTIME_LEASE_ID,
			requestId: readRequest.requestId,
			succeeded: true,
			result: { global: "global", local: "local" },
		});
		const read = await readPromise;
		const releasePromise = bridge.requestKnowledgeRelease("lease-1");
		await settleBridge();
		const releaseRequest = requestAt(channel, 3);
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: RUNTIME_LEASE_ID,
			requestId: releaseRequest.requestId,
			succeeded: true,
			result: { acknowledged: true },
		});
		await releasePromise;

		// Assert: operation payloads and validated response values preserve the narrow contract.
		expect(read).toEqual({ global: "global", local: "local" });
		expect(readRequest).toMatchObject({
			operation: "knowledge_read",
			payload: { scope: SCOPE },
		});
		expect(releaseRequest).toMatchObject({
			operation: "knowledge_release",
			payload: { leaseId: "lease-1" },
		});
	});

	/**
	 * Proves child cancellation removes a queued acquisition through a separate root correlation.
	 * Inputs and expected outputs: aborting one pending acquire sends knowledge_cancel for its exact request ID and rejects with caller reason.
	 * Edge case: the original failed response is settled before the local cancellation returns, preventing a pending-request leak.
	 * Dependencies: the common bridge can process cancellation while the original root request remains pending.
	 */
	test("cancels a pending knowledge acquisition by request correlation", async () => {
		// Arrange: one active child bridge starts an abortable acquisition.
		const channel = new WorkerChannelFake();
		const bridge = new WorkerRuntimeBridge(
			RUNTIME_LEASE_ID,
			OWNER.ownerPiSessionId,
			channel,
		);
		bridge.activate(OWNER, async () => ({ acknowledged: true }));
		const abortController = new AbortController();
		const acquisition = bridge.requestKnowledgeAcquire(
			SCOPE,
			abortController.signal,
		);
		await settleBridge();
		const acquireRequest = requestAt(channel, 1);

		// Act: abort, acknowledge root cancellation, and settle the cancelled original request.
		abortController.abort(new Error("caller cancelled"));
		await settleBridge();
		const cancelRequest = requestAt(channel, 2);
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: RUNTIME_LEASE_ID,
			requestId: cancelRequest.requestId,
			succeeded: true,
			result: { acknowledged: true },
		});
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: RUNTIME_LEASE_ID,
			requestId: acquireRequest.requestId,
			succeeded: false,
			error: "knowledge hierarchy operation failed",
		});

		// Assert: cancellation targets only the original acquisition and preserves the caller reason.
		await expect(acquisition).rejects.toThrow("caller cancelled");
		expect(cancelRequest).toMatchObject({
			operation: "knowledge_cancel",
			payload: { requestId: acquireRequest.requestId },
		});
	});
});
