import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	getTopWorkflow,
	isSupportedWorkflowOperationVersion,
	type WorkflowChain,
} from "../workflow/workflow";

/** Custom entry type persisted by the workflow extension on every state change. */
const WORKFLOW_STATE_CUSTOM_TYPE = "workflow-state";

/** Identifies supported workflow journal operations, including legacy completion. */
type WorkflowStateKind =
	| "created"
	| "activated"
	| "transitioned"
	| "stage_edited"
	| "completed"
	| "exited";

/** Workflow ID and active stage description extracted from session entries. */
export interface WorkflowStatus {
	readonly workflowId: string;
	readonly stageDescription: string;
}

/** Minimum fields needed from a persisted WorkflowDefinition to render a status row. */
interface TrackedWorkflowDefinition {
	readonly id: string;
	readonly stages: ReadonlyMap<string, string>;
}

/** Reports whether a session entry is a workflow-state custom entry. */
function isWorkflowStateEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" &&
		(entry as { customType?: unknown }).customType ===
			WORKFLOW_STATE_CUSTOM_TYPE
	);
}

/** Reads and validates the data payload from a custom entry. */
function readEntryData(
	entry: SessionEntry,
): Record<string, unknown> | undefined {
	const data = (entry as { data?: unknown }).data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	return data as Record<string, unknown>;
}

/** Reads the workflow state change kind from validated entry data. */
function readKind(
	data: Record<string, unknown>,
): WorkflowStateKind | undefined {
	const kind = data["kind"];
	if (
		kind === "created" ||
		kind === "activated" ||
		kind === "transitioned" ||
		kind === "stage_edited" ||
		kind === "completed" ||
		kind === "exited"
	) {
		return kind;
	}
	return undefined;
}

/** Reads a non-empty string array field from untrusted entry data. */
function readStringArray(
	data: Record<string, unknown>,
	key: string,
): readonly string[] | undefined {
	const value = data[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.every((item) => typeof item === "string" && item.length > 0)
		? (value as readonly string[])
		: undefined;
}

/** Extracts workflow ID and stage descriptions from a created or activated entry. */
function readWorkflowDefinition(
	data: Record<string, unknown>,
): TrackedWorkflowDefinition | undefined {
	const workflow = data["workflow"];
	if (typeof workflow !== "object" || workflow === null) {
		return undefined;
	}
	const id = (workflow as Record<string, unknown>)["id"];
	if (typeof id !== "string" || id.length === 0) {
		return undefined;
	}
	const rawStages = (workflow as Record<string, unknown>)["stages"];
	if (!Array.isArray(rawStages)) {
		return undefined;
	}
	const stages = new Map<string, string>();
	for (const stage of rawStages) {
		if (typeof stage !== "object" || stage === null) {
			continue;
		}
		const stageRecord = stage as Record<string, unknown>;
		const stageId = stageRecord["id"];
		const stageDescription = stageRecord["description"];
		if (
			typeof stageId === "string" &&
			stageId.length > 0 &&
			typeof stageDescription === "string" &&
			stageDescription.length > 0
		) {
			stages.set(stageId, stageDescription);
		}
	}
	if (stages.size === 0) {
		return undefined;
	}
	return { id, stages };
}

/** Tracks the latest workflow definition and route across iterated entries. */
interface WorkflowStateTracking {
	chain: WorkflowChain<{
		readonly definition: TrackedWorkflowDefinition;
		readonly route: readonly string[];
		readonly pendingTransition?: { readonly stageId: string };
	}>;
	journalVersion: number | undefined;
	legacyCompleted: WorkflowStateTracking["chain"][number] | undefined;
}

/** Updates tracked workflow definition and route from one workflow-state entry. */
function applyWorkflowStateEntry(
	entry: SessionEntry,
	tracking: WorkflowStateTracking,
): void {
	if (!isWorkflowStateEntry(entry)) {
		return;
	}
	const data = readEntryData(entry);
	if (data === undefined) {
		return;
	}
	const kind = readKind(data);
	if (kind === "created" || kind === "activated") {
		restoreWorkflowRoot(data, tracking);
		return;
	}
	applyWorkflowStatusOperation(data, tracking, kind);
}

/** Projects supported route, edit, and exit operations without rejecting an entire status history. */
function applyWorkflowStatusOperation(
	data: Record<string, unknown>,
	tracking: WorkflowStateTracking,
	kind: WorkflowStateKind | undefined,
): void {
	if (!isSupportedWorkflowOperationVersion(data, tracking.journalVersion)) {
		return;
	}
	const historical =
		kind === "transitioned" &&
		tracking.journalVersion === 1 &&
		data["journalVersion"] === undefined
			? tracking.legacyCompleted
			: undefined;
	const top = getTopWorkflow(tracking.chain) ?? historical;
	if (top === undefined) {
		return;
	}
	switch (kind) {
		case "completed":
		case "exited": {
			const remaining = resolveWorkflowStatusExit(
				tracking.chain,
				data["allow"],
			);
			if (remaining !== undefined) {
				tracking.legacyCompleted = kind === "completed" ? top : undefined;
				tracking.chain = remaining;
			}
			return;
		}
		case "stage_edited":
			tracking.chain = [
				...tracking.chain.slice(0, -1),
				applyStageDescription(top, data),
			];
			return;
		case "transitioned": {
			const route = readStringArray(data, "route");
			if (route !== undefined) {
				tracking.chain = [...tracking.chain.slice(0, -1), { ...top, route }];
				tracking.legacyCompleted = undefined;
			}
		}
	}
}

/** Projects one exit and its permitted route change without exposing an intermediate parent stage. */
function resolveWorkflowStatusExit(
	chain: WorkflowStateTracking["chain"],
	allow: unknown,
): WorkflowStateTracking["chain"] | undefined {
	const top = getTopWorkflow(chain);
	const pending = top?.pendingTransition;
	const remaining = chain.slice(0, -1);
	if (pending === undefined) {
		return remaining;
	}
	const parent = getTopWorkflow(remaining);
	if (typeof allow !== "boolean" || parent === undefined) {
		return undefined;
	}
	if (!allow) {
		return remaining;
	}
	if (!parent.definition.stages.has(pending.stageId)) {
		return undefined;
	}
	const index = parent.route.lastIndexOf(pending.stageId);
	const route =
		index < 0
			? [...parent.route, pending.stageId]
			: parent.route.slice(0, index + 1);
	return [...remaining.slice(0, -1), { ...parent, route }];
}

/** Accepts supported root snapshots while ignoring malformed definitions. */
function restoreWorkflowRoot(
	data: Record<string, unknown>,
	tracking: WorkflowStateTracking,
): void {
	tracking.legacyCompleted = undefined;
	const version = data["journalVersion"];
	if (version !== 1 && version !== 2) {
		tracking.chain = [];
		tracking.journalVersion = undefined;
		return;
	}
	const definition = readWorkflowDefinition(data);
	const route = readStringArray(data, "route");
	if (definition !== undefined && route !== undefined) {
		const pending = data["pendingTransition"];
		if (
			pending !== undefined &&
			(version !== 2 ||
				data["mode"] !== "push" ||
				pending === null ||
				typeof pending !== "object" ||
				typeof Reflect.get(pending, "stageId") !== "string")
		) {
			return;
		}
		const state = {
			definition,
			route,
			...(pending === undefined
				? {}
				: {
						pendingTransition: {
							stageId: Reflect.get(pending as object, "stageId") as string,
						},
					}),
		};
		tracking.chain =
			version === 2 && data["mode"] === "push"
				? [...tracking.chain, state]
				: [state];
		tracking.journalVersion = version;
	}
}

/** Projects only a valid edit to a known stage description. */
function applyStageDescription(
	top: WorkflowStateTracking["chain"][number],
	data: Record<string, unknown>,
): WorkflowStateTracking["chain"][number] {
	const stageId = data["stageId"];
	const description = data["description"];
	if (
		typeof stageId !== "string" ||
		typeof description !== "string" ||
		!top.definition.stages.has(stageId)
	) {
		return top;
	}
	const stages = new Map(top.definition.stages);
	stages.set(stageId, description);
	return { ...top, definition: { ...top.definition, stages } };
}

/** Maps the latest tracked definition and route to a displayable status. */
function resolveWorkflowStatus(
	tracking: WorkflowStateTracking,
): WorkflowStatus | undefined {
	const top = getTopWorkflow(tracking.chain);
	if (top === undefined) {
		return undefined;
	}
	const { definition, route } = top;
	const activeStageId = route[route.length - 1];
	if (activeStageId === undefined) {
		return undefined;
	}
	const stageDescription = definition.stages.get(activeStageId);
	return stageDescription === undefined
		? undefined
		: { workflowId: definition.id, stageDescription };
}

/**
 * Extracts the current workflow status from session entries.
 *
 * Iterates entries in append order, tracking the latest workflow definition
 * (from created/activated entries) and route updates through explicit exits. Returns the
 * workflow ID and active stage description, or undefined when no workflow
 * state is available.
 */
export function extractWorkflowStatus(
	entries: readonly SessionEntry[],
): WorkflowStatus | undefined {
	const tracking: WorkflowStateTracking = {
		chain: [],
		journalVersion: undefined,
		legacyCompleted: undefined,
	};
	for (const entry of entries) {
		applyWorkflowStateEntry(entry, tracking);
	}
	return resolveWorkflowStatus(tracking);
}
