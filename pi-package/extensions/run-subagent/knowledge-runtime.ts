import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getKnowledgeRootRuntime,
	type KnowledgeHierarchyClient,
	type KnowledgeMutationLease,
	type KnowledgeSnapshots,
} from "../../shared/knowledge-runtime";
import type { WorkerRuntimeBridge } from "./runtime-bridge";
import type { RuntimeRequest } from "./runtime-wire";

/** Results produced by knowledge-specific root runtime requests. */
export type KnowledgeRuntimeRequestResult =
	| KnowledgeSnapshots
	| KnowledgeMutationLease
	| { readonly acknowledged: true };

/** Creates the narrow knowledge hierarchy client around one active child bridge. */
export function createWorkerKnowledgeHierarchyClient(
	bridge: WorkerRuntimeBridge,
): KnowledgeHierarchyClient {
	return {
		read: (scope) => bridge.requestKnowledgeRead(scope),
		acquire: (scope, signal) => bridge.requestKnowledgeAcquire(scope, signal),
		release: (leaseId) => bridge.requestKnowledgeRelease(leaseId),
	};
}

/** Routes one validated knowledge request to the root-owned coordinator. */
export async function handleKnowledgeRuntimeRequest(
	pi: ExtensionAPI,
	ownerId: string,
	request: RuntimeRequest,
): Promise<KnowledgeRuntimeRequestResult | undefined> {
	if (!isKnowledgeOperation(request.operation)) {
		return undefined;
	}
	const runtime = getKnowledgeRootRuntime(pi);
	if (runtime === undefined) {
		throw new Error("knowledge hierarchy operation failed");
	}
	try {
		switch (request.operation) {
			case "knowledge_read":
				return await runtime.read(request.payload.scope);
			case "knowledge_acquire":
				return await runtime.acquire(ownerId, request.payload.scope);
			case "knowledge_release":
				await runtime.release(ownerId, request.payload.leaseId);
				return { acknowledged: true };
			case "knowledge_cancel":
				runtime.cancel(ownerId, request.payload.requestId);
				return { acknowledged: true };
		}
	} catch {
		// Root errors cross IPC only as a fixed message without paths, prompts, URLs, or knowledge.
		throw new Error("knowledge hierarchy operation failed");
	}
}

/** Removes queued or active knowledge work owned by one unavailable runtime lease. */
export function cancelKnowledgeRuntimeOwner(
	pi: ExtensionAPI,
	ownerId: string,
	requestId?: string,
): void {
	try {
		getKnowledgeRootRuntime(pi)?.cancel(ownerId, requestId);
	} catch {
		// Runtime cleanup must not block existing run-subagent recovery or shutdown.
	}
}

/** Narrows dispatch without turning run-subagent into a generic extension broker. */
function isKnowledgeOperation(
	operation: RuntimeRequest["operation"],
): operation is
	| "knowledge_read"
	| "knowledge_acquire"
	| "knowledge_release"
	| "knowledge_cancel" {
	return (
		operation === "knowledge_read" ||
		operation === "knowledge_acquire" ||
		operation === "knowledge_release" ||
		operation === "knowledge_cancel"
	);
}
