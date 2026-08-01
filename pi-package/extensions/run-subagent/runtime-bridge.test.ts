import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	RootRuntimeBridge,
	type RuntimeChannelFailure,
	WorkerRuntimeBridge,
	type WorkerRuntimeChannel,
} from "./runtime-bridge";

/** Captures worker-side IPC without mutating the current process channel. */
class WorkerChannelFake implements WorkerRuntimeChannel {
	public connected = true;
	public readonly sent: unknown[] = [];
	private readonly handlers: Array<(value: unknown) => void> = [];

	/** Reports the controlled connection state. */
	public isConnected(): boolean {
		return this.connected;
	}

	/** Registers one worker message handler. */
	public onMessage(handler: (value: unknown) => void): void {
		this.handlers.push(handler);
	}

	/** Records one worker message without retry. */
	public async send(message: unknown): Promise<void> {
		this.sent.push(message);
	}

	/** Emits one untrusted root message to every registered handler. */
	public emit(value: unknown): void {
		for (const handler of this.handlers) {
			handler(value);
		}
	}
}

type ControlledProcess = ChildProcess & { readonly sent: unknown[] };

/** Creates the minimum evented child-process channel used by the bridge boundary. */
function createProcessChannel(): ControlledProcess {
	const process = new EventEmitter();
	const sent: unknown[] = [];
	Object.assign(process, {
		sent,
		connected: true,
		send: (message: unknown, callback?: (error: Error | null) => void) => {
			sent.push(message);
			callback?.(null);
			return true;
		},
		disconnect: () => {
			Object.assign(process, { connected: false });
			process.emit("disconnect");
		},
	});
	return process as ControlledProcess;
}

/** Observes one root-side acknowledgment without losing its correlation to malformed data. */
async function probeRootAcknowledgment(result: unknown): Promise<{
	readonly settledAfterMalformed: boolean;
	readonly result: unknown;
}> {
	const bridge = new RootRuntimeBridge();
	const process = createProcessChannel();
	bridge.registerLease({
		runtimeLeaseId: "lease-root-ack",
		owner: {
			ownerPiSessionId: "owner-root-ack",
			ownerSessionFile: "/tmp/owner-root-ack.jsonl",
		},
		process,
		onRequest: async () => ({ acknowledged: true }),
		onFailure: () => undefined,
	});
	process.emit("message", {
		kind: "subagents-ready",
		runtimeLeaseId: "lease-root-ack",
		ownerPiSessionId: "owner-root-ack",
		ownerSessionFile: "/tmp/owner-root-ack.jsonl",
	});
	await Promise.resolve();
	let settled = false;
	const pending = bridge
		.request("lease-root-ack", "append_journal", {
			kind: "history-committed",
			feedbackId: "feedback-root-ack",
			invocationId: "invocation-root-ack",
			sessionKey: {
				ownerPiSessionId: "owner-root-ack",
				ownerLocalSessionId: 1,
			},
		})
		.then((value) => {
			settled = true;
			return value;
		});
	await Promise.resolve();
	const request = process.sent.find(
		(message) => readKind(message) === "subagents-request",
	);
	const requestId = readNestedRequestId(request);
	if (requestId === undefined) {
		throw new Error("root acknowledgment correlation was not captured");
	}
	process.emit("message", {
		kind: "subagents-response",
		source: "worker",
		runtimeLeaseId: "lease-root-ack",
		requestId,
		succeeded: true,
		result,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	const settledAfterMalformed = settled;
	process.emit("message", {
		kind: "subagents-response",
		source: "worker",
		runtimeLeaseId: "lease-root-ack",
		requestId,
		succeeded: true,
		result: { acknowledged: true },
	});
	return { settledAfterMalformed, result: await pending };
}

/** Observes one worker-side acknowledgment without losing its correlation to malformed data. */
async function probeWorkerAcknowledgment(result: unknown): Promise<{
	readonly settledAfterMalformed: boolean;
	readonly result: unknown;
}> {
	const channel = new WorkerChannelFake();
	const bridge = new WorkerRuntimeBridge(
		"lease-worker-ack",
		"owner-worker-ack",
		channel,
	);
	bridge.activate(
		{
			ownerPiSessionId: "owner-worker-ack",
			ownerSessionFile: "/tmp/owner-worker-ack.jsonl",
		},
		async () => ({ acknowledged: true }),
	);
	let settled = false;
	const pending = bridge.request("owner_stopping", {}).then((value) => {
		settled = true;
		return value;
	});
	await Promise.resolve();
	const request = channel.sent.find(
		(message) => readKind(message) === "subagents-request",
	);
	const requestId = readNestedRequestId(request);
	if (requestId === undefined) {
		throw new Error("worker acknowledgment correlation was not captured");
	}
	channel.emit({
		kind: "subagents-response",
		source: "root",
		runtimeLeaseId: "lease-worker-ack",
		requestId,
		succeeded: true,
		result,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	const settledAfterMalformed = settled;
	channel.emit({
		kind: "subagents-response",
		source: "root",
		runtimeLeaseId: "lease-worker-ack",
		requestId,
		succeeded: true,
		result: { acknowledged: true },
	});
	return { settledAfterMalformed, result: await pending };
}

describe("RootRuntimeBridge", () => {
	test("invalidates a disconnected runtime lease once", async () => {
		// Purpose: one unexpected IPC disconnect must latch one lease failure and reject every later send.
		// Input and expected output: repeated disconnect signals emit one channel_disconnected event and a later request rejects.
		// Edge case: the second disconnect cannot produce another fail-stop observation.
		// Dependencies: evented in-memory ChildProcess IPC channel.
		const bridge = new RootRuntimeBridge();
		const process = createProcessChannel();
		const failures: RuntimeChannelFailure[] = [];
		try {
			bridge.registerLease({
				runtimeLeaseId: "lease-1",
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner-1.jsonl",
				},
				process,
				onRequest: async () => ({ acknowledged: true }),
				onFailure: (failure) => failures.push(failure),
			});
			process.emit("disconnect");
			process.emit("disconnect");
		} catch {}
		let laterSendRejected = false;
		try {
			await bridge.request("lease-1", "delivery_acknowledgment", {});
		} catch {
			laterSendRejected = true;
		}

		expect({ failures, laterSendRejected }).toEqual({
			failures: [
				{
					runtimeLeaseId: "lease-1",
					reason: "channel_disconnected",
				},
			],
			laterSendRejected: true,
		});
	});

	test("preserves both bridge correlations for malformed acknowledgments", async () => {
		// Purpose: operation acknowledgments must be exact before either bridge consumes pending correlation state.
		// Input and expected output: false, missing, and extra-field acknowledgments remain pending in both directions until exact true arrives.
		// Edge case: each malformed value uses a fresh lease so one consumed correlation cannot hide later probes.
		// Dependencies: production root and worker response handling with controlled channels.
		const malformed = [
			{ acknowledged: false },
			{},
			{ acknowledged: true, extra: true },
		];
		const root = await Promise.all(malformed.map(probeRootAcknowledgment));
		const worker = await Promise.all(malformed.map(probeWorkerAcknowledgment));

		expect({ root, worker }).toEqual({
			root: malformed.map(() => ({
				settledAfterMalformed: false,
				result: { acknowledged: true },
			})),
			worker: malformed.map(() => ({
				settledAfterMalformed: false,
				result: { acknowledged: true },
			})),
		});
	});

	test("rejects operation payloads before request handlers", async () => {
		// Purpose: operation-specific request parsing must precede shutdown, owner registration, coordinator, and writer handlers.
		// Input and expected output: malformed control payloads and agent envelopes produce zero root or worker handler calls and zero acknowledgments.
		// Edge case: every message has an exact outer request envelope and matching lease and owner identities.
		// Dependencies: production wire parser plus root and worker request routing.
		const process = createProcessChannel();
		const root = new RootRuntimeBridge();
		let rootRequestCalls = 0;
		root.registerLease({
			runtimeLeaseId: "lease-request-validation",
			owner: {
				ownerPiSessionId: "owner-request-validation",
				ownerSessionFile: "/tmp/owner-request-validation.jsonl",
			},
			process,
			onRequest: async () => {
				rootRequestCalls += 1;
				return { acknowledged: true };
			},
			onFailure: () => undefined,
		});
		process.emit("message", {
			kind: "subagents-ready",
			runtimeLeaseId: "lease-request-validation",
			ownerPiSessionId: "owner-request-validation",
			ownerSessionFile: "/tmp/owner-request-validation.jsonl",
		});
		for (const [requestId, operation, payload] of [
			["owner-stopping", "owner_stopping", { extra: true }],
			["delivery", "delivery_acknowledgment", false],
			[
				"agent-envelope",
				"agent_operation",
				{
					toolName: "subagent_start",
					toolCallId: "tool-envelope",
					params: {
						agentId: "SubAgentCoder",
						taskName: "Trace runtime",
						prompt: "Inspect runtime",
					},
					extra: true,
				},
			],
			[
				"agent-params",
				"agent_operation",
				{
					toolName: "subagent_start",
					toolCallId: "tool-params",
					params: {
						agentId: "SubAgentCoder",
						taskName: "Trace runtime",
						prompt: "Inspect runtime",
						extra: true,
					},
				},
			],
		] as const) {
			process.emit("message", {
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId,
					runtimeLeaseId: "lease-request-validation",
					ownerPiSessionId: "owner-request-validation",
					operation,
					payload,
				},
			});
		}
		const workerChannel = new WorkerChannelFake();
		const worker = new WorkerRuntimeBridge(
			"lease-worker-request",
			"owner-worker-request",
			workerChannel,
		);
		let workerHandlerCalls = 0;
		worker.activate(
			{
				ownerPiSessionId: "owner-worker-request",
				ownerSessionFile: "/tmp/owner-worker-request.jsonl",
			},
			async () => {
				workerHandlerCalls += 1;
				return { acknowledged: true };
			},
		);
		for (const [requestId, operation, payload] of [
			["owner-stopping", "owner_stopping", { extra: true }],
			["delivery", "delivery_acknowledgment", false],
		] as const) {
			workerChannel.emit({
				kind: "subagents-request",
				source: "root",
				request: {
					requestId,
					runtimeLeaseId: "lease-worker-request",
					ownerPiSessionId: "owner-worker-request",
					operation,
					payload,
				},
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect({
			rootRequestCalls,
			workerHandlerCalls,
			rootResponses: process.sent.filter(
				(message) => readKind(message) === "subagents-response",
			).length,
			workerResponses: workerChannel.sent.filter(
				(message) => readKind(message) === "subagents-response",
			).length,
		}).toEqual({
			rootRequestCalls: 0,
			workerHandlerCalls: 0,
			rootResponses: 0,
			workerResponses: 0,
		});
	});

	test("correlates worker requests and acknowledges delivered root responses", async () => {
		// Purpose: the worker endpoint must use one validated channel for readiness, nested operations, root commands, and settlement acknowledgment.
		// Input and expected output: one nested request receives timeout, sends settled, and one root delivery command receives acknowledged true.
		// Edge case: outer and nested extra-key responses cannot settle correlation state, and a wrong-owner request is ignored.
		// Dependencies: injected worker channel fake and production worker bridge.
		const channel = new WorkerChannelFake();
		const bridge = new WorkerRuntimeBridge(
			"lease-worker",
			"owner-worker",
			channel,
		);
		bridge.activate(
			{
				ownerPiSessionId: "owner-worker",
				ownerSessionFile: "/tmp/worker.jsonl",
			},
			async () => ({ handled: true }),
		);
		await Promise.resolve();
		let nestedSettled = false;
		const pending = bridge
			.request("agent_operation", {
				toolName: "subagent_wait",
				toolCallId: "wait-tool",
				params: { sessionIds: [1], timeout: 1 },
			})
			.then((result) => {
				nestedSettled = true;
				return result;
			});
		await Promise.resolve();
		const nestedRequest = channel.sent.find(
			(message) => readKind(message) === "subagents-request",
		);
		const nestedRequestId = readNestedRequestId(nestedRequest);
		if (nestedRequestId === undefined) {
			throw new Error("worker request correlation was not captured");
		}
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: "lease-worker",
			requestId: nestedRequestId,
			succeeded: true,
			result: { outcome: "malformed" },
			extra: true,
		});
		await Promise.resolve();
		const settledAfterMalformed = nestedSettled;
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: "lease-worker",
			requestId: nestedRequestId,
			succeeded: true,
			result: {
				kind: "ok",
				result: { outcome: "timeout", extra: true },
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const settledAfterNestedMalformed = nestedSettled;
		channel.emit({
			kind: "subagents-response",
			source: "root",
			runtimeLeaseId: "lease-worker",
			requestId: nestedRequestId,
			succeeded: true,
			result: { kind: "ok", result: { outcome: "timeout" } },
		});
		const nestedResult = await pending;
		await Promise.resolve();
		channel.emit({
			kind: "subagents-request",
			source: "root",
			request: {
				requestId: "wrong-owner",
				runtimeLeaseId: "lease-worker",
				ownerPiSessionId: "other-owner",
				operation: "delivery_acknowledgment",
				payload: {},
			},
		});
		channel.emit({
			kind: "subagents-request",
			source: "root",
			request: {
				requestId: "root-command",
				runtimeLeaseId: "lease-worker",
				ownerPiSessionId: "owner-worker",
				operation: "delivery_acknowledgment",
				payload: {},
			},
		});
		await Promise.resolve();

		expect({
			settledAfterMalformed,
			settledAfterNestedMalformed,
			nestedResult,
			kinds: channel.sent.map(readKind),
			rootResponses: channel.sent.filter(
				(message) =>
					readKind(message) === "subagents-response" &&
					readRequestId(message) === "root-command",
			),
		}).toEqual({
			settledAfterMalformed: false,
			settledAfterNestedMalformed: false,
			nestedResult: { kind: "ok", result: { outcome: "timeout" } },
			kinds: [
				"subagents-ready",
				"subagents-request",
				"subagents-settled",
				"subagents-response",
			],
			rootResponses: [
				{
					kind: "subagents-response",
					source: "worker",
					runtimeLeaseId: "lease-worker",
					requestId: "root-command",
					succeeded: true,
					result: { acknowledged: true },
				},
			],
		});
	});

	test("settles owner stopping before intentional bridge closure", async () => {
		// Purpose: normal worker teardown must not be classified as a runtime disconnect failure.
		// Input and expected output: one owner_stopping request settles before intentional disconnect with no failure.
		// Edge case: the bridge closes only after the worker acknowledges the root response settlement.
		// Dependencies: controlled root-side child-process channel and production bridge ordering.
		const failures: RuntimeChannelFailure[] = [];
		const operations: string[] = [];
		const bridge = new RootRuntimeBridge();
		const child = createProcessChannel();
		bridge.registerLease({
			runtimeLeaseId: "lease-stopping",
			owner: {
				ownerPiSessionId: "owner-stopping",
				ownerSessionFile: "/tmp/stopping.jsonl",
			},
			process: child,
			onRequest: async (request) => {
				operations.push(request.operation);
				return { acknowledged: true };
			},
			onFailure: (failure) => {
				failures.push(failure);
			},
		});
		child.emit("message", {
			kind: "subagents-request",
			source: "worker",
			request: {
				requestId: "owner-stopping-request",
				runtimeLeaseId: "lease-stopping",
				ownerPiSessionId: "owner-stopping",
				operation: "owner_stopping",
				payload: {},
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		child.emit("message", {
			kind: "subagents-settled",
			runtimeLeaseId: "lease-stopping",
			requestId: "owner-stopping-request",
		});
		bridge.beginCloseLease("lease-stopping");
		child.emit("disconnect");

		expect({ operations, failures }).toEqual({
			operations: ["owner_stopping"],
			failures: [],
		});
	});

	test("fails stop on an unknown settlement acknowledgment", async () => {
		// Purpose: validated but uncorrelated worker settlement messages must invalidate the lease once.
		// Input and expected output: malformed and wrong-lease messages are ignored, then one unknown settled request latches response_delivery_unknown.
		// Edge case: repeating the unknown acknowledgment cannot emit a second failure.
		// Dependencies: evented in-memory ChildProcess IPC channel.
		const bridge = new RootRuntimeBridge();
		const process = createProcessChannel();
		const failures: RuntimeChannelFailure[] = [];
		bridge.registerLease({
			runtimeLeaseId: "lease-2",
			owner: {
				ownerPiSessionId: "owner-2",
				ownerSessionFile: "/tmp/owner-2.jsonl",
			},
			process,
			onRequest: async () => ({ acknowledged: true }),
			onFailure: (failure) => failures.push(failure),
		});
		process.emit("message", { kind: "subagents-settled" });
		process.emit("message", {
			kind: "subagents-settled",
			runtimeLeaseId: "wrong-lease",
			requestId: "unknown",
		});
		process.emit("message", {
			kind: "subagents-settled",
			runtimeLeaseId: "lease-2",
			requestId: "unknown",
		});
		process.emit("message", {
			kind: "subagents-settled",
			runtimeLeaseId: "lease-2",
			requestId: "unknown",
		});
		await Promise.resolve();

		expect(failures).toEqual([
			{
				runtimeLeaseId: "lease-2",
				reason: "response_delivery_unknown",
				requestId: "unknown",
			},
		]);
	});
});

/** Reads one wire discriminator without casting untrusted test observations. */
function readKind(value: unknown): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, "kind")
		: undefined;
}

/** Reads one top-level request ID from an observed response. */
function readRequestId(value: unknown): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, "requestId")
		: undefined;
}

/** Reads one nested worker request correlation. */
function readNestedRequestId(value: unknown): string | undefined {
	const request =
		typeof value === "object" && value !== null
			? Reflect.get(value, "request")
			: undefined;
	const requestId =
		typeof request === "object" && request !== null
			? Reflect.get(request, "requestId")
			: undefined;
	return typeof requestId === "string" ? requestId : undefined;
}
