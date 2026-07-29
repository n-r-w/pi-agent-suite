import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	AgentOperationPayload,
	AgentOperationResponse,
} from "./agent-operation-wire";
import { readCancellationError } from "./cancellation-reason";
import type { OwnerIdentity } from "./domain";
import {
	readSubagentOwnerSessionId,
	readSubagentRuntimeLeaseId,
} from "./environment";
import { errorMessage } from "./error-message";
import type { QueryBranchResponse } from "./query-branch-wire";
import {
	parseRuntimeOperationPayload,
	parseRuntimeResponseResult,
	parseWireMessage,
	type RuntimeOperationCancellationAcknowledgment,
	type RuntimeRequest,
	type RuntimeWireMessage,
	wireRuntimeLeaseId,
} from "./runtime-wire";

/** Lists runtime-channel failure reasons. */
type RuntimeChannelFailureReason =
	| "channel_disconnected"
	| "response_send_failed"
	| "response_delivery_unknown";

/** Reports one latched runtime-channel failure. */
export interface RuntimeChannelFailure {
	readonly runtimeLeaseId: string;
	readonly reason: RuntimeChannelFailureReason;
	readonly requestId?: string;
}

/** Defines one root-side runtime lease registration. */
interface RuntimeLeaseRegistration {
	readonly runtimeLeaseId: string;
	readonly owner: OwnerIdentity;
	readonly process: ChildProcess;
	readonly onRequest: (request: RuntimeRequest) => Promise<unknown>;
	readonly onFailure: (failure: RuntimeChannelFailure) => void;
	readonly onReady?: (owner: OwnerIdentity) => void;
}

interface PendingRequest {
	readonly operation: RuntimeRequest["operation"];
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface CorrelatedWorkerRequest {
	readonly requestId: string;
	readonly response: Promise<unknown>;
}

interface RuntimeLease {
	readonly registration: RuntimeLeaseRegistration;
	readonly pendingRootRequests: Map<string, PendingRequest>;
	readonly pendingWorkerSettlements: Set<string>;
	readonly ready: Promise<OwnerIdentity>;
	readonly resolveReady: (owner: OwnerIdentity) => void;
	readonly rejectReady: (error: Error) => void;
	failed: boolean;
	closing: boolean;
	readyOwner?: OwnerIdentity;
}

/** Owns validated root/worker IPC correlations and failure latching. */
export class RootRuntimeBridge {
	private readonly leases = new Map<string, RuntimeLease>();

	/** Registers one process channel for one runtime lease. */
	public registerLease(registration: RuntimeLeaseRegistration): void {
		if (this.leases.has(registration.runtimeLeaseId)) {
			throw new Error(`runtime lease ${registration.runtimeLeaseId} exists`);
		}
		let resolveReady: (owner: OwnerIdentity) => void = () => undefined;
		let rejectReady: (error: Error) => void = () => undefined;
		const ready = new Promise<OwnerIdentity>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		ready.catch(() => undefined);
		const lease: RuntimeLease = {
			registration,
			pendingRootRequests: new Map(),
			pendingWorkerSettlements: new Set(),
			ready,
			resolveReady,
			rejectReady,
			failed: false,
			closing: false,
		};
		this.leases.set(registration.runtimeLeaseId, lease);
		registration.process.on("message", (value: unknown) => {
			this.handleMessage(lease, value).catch(() => undefined);
		});
		registration.process.on("disconnect", () => {
			if (!lease.closing && !lease.failed) {
				const requestId = lease.pendingWorkerSettlements.values().next().value;
				this.failLease(
					lease,
					requestId === undefined
						? { reason: "channel_disconnected" }
						: { reason: "response_delivery_unknown", requestId },
				);
			}
		});
	}

	/** Waits until the worker reports its public Pi owner identity and file. */
	public waitUntilReady(runtimeLeaseId: string): Promise<OwnerIdentity> {
		return this.requireLease(runtimeLeaseId).ready;
	}

	/** Sends one correlated command to a live worker runtime. */
	public async request(
		runtimeLeaseId: string,
		operation: RuntimeRequest["operation"],
		payload: unknown,
	): Promise<unknown> {
		const lease = this.requireLiveLease(runtimeLeaseId);
		const owner = lease.readyOwner ?? (await lease.ready);
		const parsedOperation = parseRuntimeOperationPayload(operation, payload);
		if (parsedOperation === undefined) {
			throw new Error("runtime operation payload is invalid");
		}
		const requestId = randomUUID();
		const result = new Promise<unknown>((resolve, reject) => {
			lease.pendingRootRequests.set(requestId, { operation, resolve, reject });
		});
		const request: RuntimeRequest = {
			requestId,
			runtimeLeaseId,
			ownerPiSessionId: owner.ownerPiSessionId,
			...parsedOperation,
		};
		try {
			await sendToChild(lease.registration.process, {
				kind: "subagents-v2-request",
				source: "root",
				request,
			} satisfies RuntimeWireMessage);
		} catch (error) {
			lease.pendingRootRequests.delete(requestId);
			this.failLease(lease, {
				reason: "response_send_failed",
				requestId,
			});
			throw error;
		}
		return result;
	}

	/** Marks intentional teardown while still accepting final worker requests. */
	public beginCloseLease(runtimeLeaseId: string): void {
		const lease = this.leases.get(runtimeLeaseId);
		if (lease !== undefined) {
			lease.closing = true;
		}
	}

	/** Closes one lease intentionally after process teardown. */
	public closeLease(runtimeLeaseId: string): void {
		const lease = this.leases.get(runtimeLeaseId);
		if (lease === undefined) {
			return;
		}
		lease.closing = true;
		for (const pending of lease.pendingRootRequests.values()) {
			pending.reject(new Error("runtime lease closed"));
		}
		lease.pendingRootRequests.clear();
		lease.pendingWorkerSettlements.clear();
		lease.rejectReady(new Error("runtime lease closed before ready"));
		this.leases.delete(runtimeLeaseId);
	}

	/** Routes one validated worker message without trusting raw IPC data. */
	private async handleMessage(
		lease: RuntimeLease,
		value: unknown,
	): Promise<void> {
		const message = parseWireMessage(value);
		if (
			message === undefined ||
			wireRuntimeLeaseId(message) !== lease.registration.runtimeLeaseId ||
			lease.failed
		) {
			return;
		}
		switch (message.kind) {
			case "subagents-v2-ready":
				this.handleReady(lease, message);
				return;
			case "subagents-v2-request":
				await this.handleRequestMessage(lease, message);
				return;
			case "subagents-v2-response":
				this.handleResponseMessage(lease, message);
				return;
			case "subagents-v2-settled":
				this.handleSettlementMessage(lease, message.requestId);
		}
	}

	/** Activates one validated worker owner exactly once. */
	private handleReady(
		lease: RuntimeLease,
		message: Extract<RuntimeWireMessage, { kind: "subagents-v2-ready" }>,
	): void {
		if (
			message.ownerPiSessionId !== lease.registration.owner.ownerPiSessionId ||
			lease.readyOwner !== undefined
		) {
			this.failLease(lease, { reason: "response_delivery_unknown" });
			return;
		}
		const owner: OwnerIdentity = {
			ownerPiSessionId: message.ownerPiSessionId,
			ownerSessionFile: message.ownerSessionFile,
		};
		lease.readyOwner = owner;
		lease.resolveReady(owner);
		lease.registration.onReady?.(owner);
	}

	/** Accepts only worker-originated requests with the assigned owner identity. */
	private async handleRequestMessage(
		lease: RuntimeLease,
		message: Extract<RuntimeWireMessage, { kind: "subagents-v2-request" }>,
	): Promise<void> {
		if (
			message.source !== "worker" ||
			message.request.ownerPiSessionId !==
				lease.registration.owner.ownerPiSessionId
		) {
			return;
		}
		await this.handleWorkerRequest(lease, message.request);
	}

	/** Resolves one root command response or fails on an unknown correlation. */
	private handleResponseMessage(
		lease: RuntimeLease,
		message: Extract<RuntimeWireMessage, { kind: "subagents-v2-response" }>,
	): void {
		if (message.source !== "worker") {
			return;
		}
		const pending = lease.pendingRootRequests.get(message.requestId);
		if (pending === undefined) {
			this.failLease(lease, {
				reason: "response_delivery_unknown",
				requestId: message.requestId,
			});
			return;
		}
		const parsed = parsePendingResponseResult(pending, message);
		if (parsed === undefined) {
			return;
		}
		lease.pendingRootRequests.delete(message.requestId);
		if (message.succeeded) {
			pending.resolve(parsed.result);
		} else {
			pending.reject(new Error(message.error ?? "worker request failed"));
		}
	}

	/** Confirms one worker tool consumed its delivered nested response. */
	private handleSettlementMessage(
		lease: RuntimeLease,
		requestId: string,
	): void {
		if (!lease.pendingWorkerSettlements.delete(requestId)) {
			this.failLease(lease, {
				reason: "response_delivery_unknown",
				requestId,
			});
		}
	}

	/** Sends one root result and waits for the worker's settlement acknowledgment. */
	private async handleWorkerRequest(
		lease: RuntimeLease,
		request: RuntimeRequest,
	): Promise<void> {
		let response: RuntimeWireMessage;
		try {
			response = {
				kind: "subagents-v2-response",
				source: "root",
				runtimeLeaseId: request.runtimeLeaseId,
				requestId: request.requestId,
				succeeded: true,
				result: await lease.registration.onRequest(request),
			};
		} catch (error) {
			response = {
				kind: "subagents-v2-response",
				source: "root",
				runtimeLeaseId: request.runtimeLeaseId,
				requestId: request.requestId,
				succeeded: false,
				error: errorMessage(error),
			};
		}
		if (lease.failed) {
			return;
		}
		lease.pendingWorkerSettlements.add(request.requestId);
		try {
			await sendToChild(lease.registration.process, response);
		} catch {
			this.failLease(lease, {
				reason: "response_send_failed",
				requestId: request.requestId,
			});
		}
	}

	/** Latches one failure, rejects correlations, and invalidates the lease once. */
	private failLease(
		lease: RuntimeLease,
		failure:
			| { readonly reason: "channel_disconnected" }
			| {
					readonly reason: "response_send_failed" | "response_delivery_unknown";
					readonly requestId?: string;
			  },
	): void {
		if (lease.failed || lease.closing) {
			return;
		}
		lease.failed = true;
		const error = new Error(`runtime channel failed: ${failure.reason}`);
		lease.rejectReady(error);
		for (const pending of lease.pendingRootRequests.values()) {
			pending.reject(error);
		}
		lease.pendingRootRequests.clear();
		lease.pendingWorkerSettlements.clear();
		const requestId = "requestId" in failure ? failure.requestId : undefined;
		const event: RuntimeChannelFailure =
			requestId === undefined
				? {
						runtimeLeaseId: lease.registration.runtimeLeaseId,
						reason: failure.reason,
					}
				: {
						runtimeLeaseId: lease.registration.runtimeLeaseId,
						reason: failure.reason,
						requestId,
					};
		lease.registration.onFailure(event);
	}

	/** Resolves one known lease regardless of failed state. */
	private requireLease(runtimeLeaseId: string): RuntimeLease {
		const lease = this.leases.get(runtimeLeaseId);
		if (lease === undefined) {
			throw new Error(`runtime lease ${runtimeLeaseId} is unknown`);
		}
		return lease;
	}

	/** Rejects sends after fail-stop or intentional closure. */
	private requireLiveLease(runtimeLeaseId: string): RuntimeLease {
		const lease = this.requireLease(runtimeLeaseId);
		if (lease.failed || lease.closing) {
			throw new Error(`runtime lease ${runtimeLeaseId} is unavailable`);
		}
		return lease;
	}
}

/** Provides the validated subset of process IPC used by the worker endpoint. */
export interface WorkerRuntimeChannel {
	isConnected(): boolean;
	onMessage(handler: (value: unknown) => void): void;
	send(message: unknown): Promise<void>;
}

/** Handles worker-side root commands and forwards nested agent operations. */
export class WorkerRuntimeBridge {
	private readonly pending = new Map<string, PendingRequest>();
	private handler:
		| ((
				operation: RuntimeRequest["operation"],
				payload: unknown,
		  ) => Promise<unknown>)
		| undefined;
	private owner: OwnerIdentity | undefined;

	/** Binds the endpoint to the validated lease identity from process environment. */
	public constructor(
		private readonly runtimeLeaseId: string,
		private readonly ownerPiSessionId: string,
		private readonly channel: WorkerRuntimeChannel = createProcessWorkerChannel(),
	) {
		this.channel.onMessage((value) => {
			this.handleMessage(value).catch(() => undefined);
		});
	}

	/** Activates the endpoint only after public SessionManager supplies the owner file. */
	public activate(
		owner: OwnerIdentity,
		handler: (
			operation: RuntimeRequest["operation"],
			payload: unknown,
		) => Promise<unknown>,
	): void {
		if (owner.ownerPiSessionId !== this.ownerPiSessionId) {
			throw new Error("worker owner identity does not match runtime lease");
		}
		this.owner = owner;
		this.handler = handler;
		this.send({
			kind: "subagents-v2-ready",
			runtimeLeaseId: this.runtimeLeaseId,
			ownerPiSessionId: owner.ownerPiSessionId,
			ownerSessionFile: owner.ownerSessionFile,
		}).catch(() => undefined);
	}

	/** Sends one nested agent operation to the root coordinator. */
	public request(
		operation: "agent_operation",
		payload: unknown,
	): Promise<AgentOperationResponse>;
	public request(
		operation: "cancel_operation",
		payload: unknown,
	): Promise<RuntimeOperationCancellationAcknowledgment>;
	public request(
		operation: "query_branch",
		payload: unknown,
	): Promise<QueryBranchResponse>;
	public request(
		operation: RuntimeRequest["operation"],
		payload: unknown,
	): Promise<unknown>;
	public async request(
		operation: RuntimeRequest["operation"],
		payload: unknown,
	): Promise<unknown> {
		return (await this.dispatch(operation, payload)).response;
	}

	/** Cancels one nested start or steer through a separate bridge correlation. */
	public requestOperation(
		payload: Extract<
			AgentOperationPayload,
			{ toolName: "subagent_start" | "subagent_steer" }
		>,
		signal: AbortSignal | undefined,
	): Promise<AgentOperationResponse> {
		return this.requestCancellableAgentOperation(
			payload,
			signal,
			(requestId, toolCallId) => ({
				operation: "cancel_operation",
				payload: {
					operationRequestId: requestId,
					operationToolCallId: toolCallId,
				},
			}),
		);
	}

	/** Cancels one nested wait through a separate bridge correlation. */
	public requestWait(
		payload: Extract<AgentOperationPayload, { toolName: "subagent_wait" }>,
		signal: AbortSignal | undefined,
	): Promise<AgentOperationResponse> {
		return this.requestCancellableAgentOperation(
			payload,
			signal,
			(requestId, toolCallId) => ({
				operation: "cancel_wait",
				payload: { waitRequestId: requestId, waitToolCallId: toolCallId },
			}),
		);
	}

	/** Races one worker operation response against its local Pi abort signal. */
	private async requestCancellableAgentOperation(
		payload: AgentOperationPayload,
		signal: AbortSignal | undefined,
		createCancellation: (
			requestId: string,
			toolCallId: string,
		) => {
			readonly operation: "cancel_operation" | "cancel_wait";
			readonly payload: unknown;
		},
	): Promise<AgentOperationResponse> {
		if (signal?.aborted) {
			throw readCancellationError(signal);
		}
		const operation = await this.dispatch("agent_operation", payload);
		if (signal === undefined) {
			return (await operation.response) as AgentOperationResponse;
		}
		let markAborted = (): void => undefined;
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve;
		});
		signal.addEventListener("abort", markAborted, { once: true });
		try {
			const outcome = await Promise.race([
				operation.response.then(
					(response) => ({ kind: "response" as const, response }),
					(error: unknown) => ({ kind: "error" as const, error }),
				),
				aborted.then(() => ({ kind: "abort" as const })),
			]);
			if (outcome.kind === "response") {
				return outcome.response as AgentOperationResponse;
			}
			if (outcome.kind === "error") {
				throw outcome.error instanceof Error
					? outcome.error
					: new Error(String(outcome.error));
			}
			const cancellation = createCancellation(
				operation.requestId,
				payload.toolCallId,
			);
			const acceptedResult = await this.cancelAgentOperationRequest(
				operation,
				cancellation,
			);
			if (acceptedResult !== undefined) {
				return acceptedResult;
			}
			throw readCancellationError(signal);
		} finally {
			signal.removeEventListener("abort", markAborted);
		}
	}

	/** Creates one worker correlation before sending its validated request. */
	private async dispatch(
		operation: RuntimeRequest["operation"],
		payload: unknown,
	): Promise<CorrelatedWorkerRequest> {
		if (this.owner === undefined) {
			throw new Error("worker runtime bridge is not active");
		}
		const parsedOperation = parseRuntimeOperationPayload(operation, payload);
		if (parsedOperation === undefined) {
			throw new Error("runtime operation payload is invalid");
		}
		const requestId = randomUUID();
		const response = new Promise<unknown>((resolve, reject) => {
			this.pending.set(requestId, { operation, resolve, reject });
		});
		try {
			await this.send({
				kind: "subagents-v2-request",
				source: "worker",
				request: {
					requestId,
					runtimeLeaseId: this.runtimeLeaseId,
					ownerPiSessionId: this.ownerPiSessionId,
					...parsedOperation,
				},
			});
		} catch (error) {
			this.pending.delete(requestId);
			throw error;
		}
		return { requestId, response };
	}

	/** Waits for cancellation acknowledgment and original correlation cleanup. */
	private async cancelAgentOperationRequest(
		original: CorrelatedWorkerRequest,
		cancellation: {
			readonly operation: "cancel_operation" | "cancel_wait";
			readonly payload: unknown;
		},
	): Promise<AgentOperationResponse | undefined> {
		let cancellationWon = true;
		try {
			if (cancellation.operation === "cancel_operation") {
				const acknowledgment = await this.request(
					"cancel_operation",
					cancellation.payload,
				);
				cancellationWon = acknowledgment.cancellationWon;
			} else {
				await this.request("cancel_wait", cancellation.payload);
			}
		} catch {
			// A failed cancellation means the serialized root outcome already owns the result.
			return (await original.response) as AgentOperationResponse;
		}
		if (!cancellationWon) {
			// Root dispatch authority prevents local cancellation from discarding an accepted steer response.
			return (await original.response) as AgentOperationResponse;
		}
		try {
			const response = (await original.response) as AgentOperationResponse;
			if (response.kind === "failed") {
				return undefined;
			}
		} catch {
			return undefined;
		}
		throw new Error("cancelled nested operation produced a normal response");
	}

	/** Routes one validated root message to its worker correlation. */
	private async handleMessage(value: unknown): Promise<void> {
		const message = parseWireMessage(value);
		if (
			message === undefined ||
			wireRuntimeLeaseId(message) !== this.runtimeLeaseId
		) {
			return;
		}
		if (message.kind === "subagents-v2-request") {
			if (
				message.source !== "root" ||
				message.request.ownerPiSessionId !== this.ownerPiSessionId
			) {
				return;
			}
			await this.handleRootRequest(message.request);
			return;
		}
		if (message.kind !== "subagents-v2-response" || message.source !== "root") {
			return;
		}
		const pending = this.pending.get(message.requestId);
		if (pending === undefined) {
			return;
		}
		const parsed = parsePendingResponseResult(pending, message);
		if (parsed === undefined) {
			return;
		}
		this.pending.delete(message.requestId);
		if (message.succeeded) {
			pending.resolve(parsed.result);
		} else {
			pending.reject(new Error(message.error ?? "root request failed"));
		}
		await this.send({
			kind: "subagents-v2-settled",
			runtimeLeaseId: this.runtimeLeaseId,
			requestId: message.requestId,
		});
	}

	/** Handles one root command through the active owner writer. */
	private async handleRootRequest(request: RuntimeRequest): Promise<void> {
		let response: RuntimeWireMessage;
		try {
			const result =
				request.operation === "delivery_acknowledgment"
					? { acknowledged: true }
					: await this.requireHandler()(request.operation, request.payload);
			response = {
				kind: "subagents-v2-response",
				source: "worker",
				runtimeLeaseId: this.runtimeLeaseId,
				requestId: request.requestId,
				succeeded: true,
				result,
			};
		} catch (error) {
			response = {
				kind: "subagents-v2-response",
				source: "worker",
				runtimeLeaseId: this.runtimeLeaseId,
				requestId: request.requestId,
				succeeded: false,
				error: errorMessage(error),
			};
		}
		await this.send(response);
	}

	/** Requires session_start activation before persistence commands. */
	private requireHandler(): NonNullable<WorkerRuntimeBridge["handler"]> {
		if (this.handler === undefined) {
			throw new Error("worker owner writer is unavailable");
		}
		return this.handler;
	}

	/** Sends one message without reconnect or retry. */
	private async send(message: RuntimeWireMessage): Promise<void> {
		if (!this.channel.isConnected()) {
			throw new Error("worker runtime channel is disconnected");
		}
		await this.channel.send(message);
	}
}

/** Adapts the current Node process to the worker channel contract. */
function createProcessWorkerChannel(): WorkerRuntimeChannel {
	return {
		isConnected: () => process.send !== undefined && process.connected,
		onMessage: (handler) => {
			process.on("message", handler);
		},
		send: (message) =>
			new Promise((resolve, reject) => {
				if (process.send === undefined) {
					reject(new Error("worker runtime channel is disconnected"));
					return;
				}
				process.send(message, (error) => {
					if (error === null) {
						resolve();
					} else {
						reject(error);
					}
				});
			}),
	};
}

/** Parses operation-specific nested results before either bridge mutates correlation state. */
function parsePendingResponseResult(
	pending: PendingRequest,
	message: Extract<RuntimeWireMessage, { kind: "subagents-v2-response" }>,
): { readonly result: unknown } | undefined {
	if (!message.succeeded) {
		return { result: undefined };
	}
	const result = parseRuntimeResponseResult(pending.operation, message.result);
	return result === undefined ? undefined : { result };
}

/** Installs the worker endpoint only for a validated Node IPC child process. */
export function installWorkerRuntimeBridge(): WorkerRuntimeBridge | undefined {
	const runtimeLeaseId = readSubagentRuntimeLeaseId();
	const ownerPiSessionId = readSubagentOwnerSessionId();
	if (
		process.send === undefined ||
		runtimeLeaseId === undefined ||
		ownerPiSessionId === undefined ||
		runtimeLeaseId.length === 0 ||
		ownerPiSessionId.length === 0
	) {
		return undefined;
	}
	return new WorkerRuntimeBridge(runtimeLeaseId, ownerPiSessionId);
}

/** Sends one root message and surfaces known channel send failure once. */
function sendToChild(
	child: ChildProcess,
	message: RuntimeWireMessage,
): Promise<void> {
	if (child.send === undefined || !child.connected) {
		return Promise.reject(new Error("runtime child IPC is disconnected"));
	}
	return new Promise((resolve, reject) => {
		child.send?.(message, (error) => {
			if (error === null) {
				resolve();
			} else {
				reject(error);
			}
		});
	});
}
