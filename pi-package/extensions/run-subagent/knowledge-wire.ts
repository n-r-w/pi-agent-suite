import type {
	KnowledgeMutationLease,
	KnowledgeScope,
	KnowledgeSnapshots,
} from "../../shared/knowledge-runtime";
import {
	hasExactKeys,
	readField,
	readNonEmptyString,
} from "./boundary-validation";

const PROJECT_DIRECTORY_NAME = /^[\p{L}\p{N}\p{M}._-]+-[0-9a-f]{64}$/u;

/** Narrow operation names reserved for root-hierarchy knowledge coordination. */
export type KnowledgeRuntimeOperationName =
	| "knowledge_read"
	| "knowledge_acquire"
	| "knowledge_release"
	| "knowledge_cancel";

/** Closed knowledge operation payload after boundary validation. */
export type KnowledgeRuntimeOperation =
	| {
			readonly operation: "knowledge_read";
			readonly payload: { readonly scope: KnowledgeScope };
	  }
	| {
			readonly operation: "knowledge_acquire";
			readonly payload: { readonly scope: KnowledgeScope };
	  }
	| {
			readonly operation: "knowledge_release";
			readonly payload: { readonly leaseId: string };
	  }
	| {
			readonly operation: "knowledge_cancel";
			readonly payload: { readonly requestId: string };
	  };

/** Parses one knowledge operation without casting unvalidated payload data. */
export function parseKnowledgeRuntimeOperation(
	operation: KnowledgeRuntimeOperationName,
	payload: unknown,
): KnowledgeRuntimeOperation | undefined {
	if (operation === "knowledge_read" || operation === "knowledge_acquire") {
		if (!hasExactKeys(payload, ["scope"])) {
			return undefined;
		}
		const scope = parseScope(readField(payload, "scope"));
		return scope === undefined ? undefined : { operation, payload: { scope } };
	}
	const key = operation === "knowledge_release" ? "leaseId" : "requestId";
	if (!hasExactKeys(payload, [key])) {
		return undefined;
	}
	const id = readNonEmptyString(payload, key);
	if (id === undefined) {
		return undefined;
	}
	return operation === "knowledge_release"
		? { operation, payload: { leaseId: id } }
		: { operation, payload: { requestId: id } };
}

/** Parses one operation-specific root response after the common wire envelope. */
export function parseKnowledgeRuntimeResponse(
	operation: KnowledgeRuntimeOperationName,
	value: unknown,
):
	| KnowledgeSnapshots
	| KnowledgeMutationLease
	| { readonly acknowledged: true }
	| undefined {
	if (operation === "knowledge_read") {
		return parseSnapshots(value);
	}
	if (operation === "knowledge_acquire") {
		if (!hasExactKeys(value, ["leaseId", "snapshots"])) {
			return undefined;
		}
		const leaseId = readNonEmptyString(value, "leaseId");
		const snapshots = parseSnapshots(readField(value, "snapshots"));
		return leaseId === undefined || snapshots === undefined
			? undefined
			: { leaseId, snapshots };
	}
	return hasExactKeys(value, ["acknowledged"]) &&
		readField(value, "acknowledged") === true
		? { acknowledged: true }
		: undefined;
}

/** Validates generated project identity plus exact active-branch scope. */
function parseScope(value: unknown): KnowledgeScope | undefined {
	if (!hasExactKeys(value, ["projectDirectoryName", "branchName"])) {
		return undefined;
	}
	const projectDirectoryName = readNonEmptyString(
		value,
		"projectDirectoryName",
	);
	const branchName = readField(value, "branchName");
	return projectDirectoryName !== undefined &&
		PROJECT_DIRECTORY_NAME.test(projectDirectoryName) &&
		(branchName === null ||
			(typeof branchName === "string" && branchName.length > 0))
		? { projectDirectoryName, branchName }
		: undefined;
}

/** Validates both nullable knowledge fields before text can leave unknown state. */
function parseSnapshots(value: unknown): KnowledgeSnapshots | undefined {
	if (!hasExactKeys(value, ["global", "local"])) {
		return undefined;
	}
	const global = readField(value, "global");
	const local = readField(value, "local");
	return (global === null || typeof global === "string") &&
		(local === null || typeof local === "string")
		? { global, local }
		: undefined;
}
