import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Custom entry type persisted by the workflow extension on every state change. */
const WORKFLOW_STATE_CUSTOM_TYPE = "workflow-state";

/** Identifies one of the three workflow state change kinds. */
type WorkflowStateKind = "created" | "activated" | "transitioned";

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
	if (kind === "created" || kind === "activated" || kind === "transitioned") {
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
	definition: TrackedWorkflowDefinition | undefined;
	route: readonly string[] | undefined;
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
		const candidate = readWorkflowDefinition(data);
		if (candidate !== undefined) {
			tracking.definition = candidate;
		}
	}
	const candidateRoute = readStringArray(data, "route");
	if (candidateRoute !== undefined) {
		tracking.route = candidateRoute;
	}
}

/** Maps the latest tracked definition and route to a displayable status. */
function resolveWorkflowStatus(
	tracking: WorkflowStateTracking,
): WorkflowStatus | undefined {
	const { definition, route } = tracking;
	if (definition === undefined || route === undefined) {
		return undefined;
	}
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
 * (from created/activated entries) and route (from any entry). Returns the
 * workflow ID and active stage description, or undefined when no workflow
 * state is available.
 */
export function extractWorkflowStatus(
	entries: readonly SessionEntry[],
): WorkflowStatus | undefined {
	const tracking: WorkflowStateTracking = {
		definition: undefined,
		route: undefined,
	};
	for (const entry of entries) {
		applyWorkflowStateEntry(entry, tracking);
	}
	return resolveWorkflowStatus(tracking);
}
