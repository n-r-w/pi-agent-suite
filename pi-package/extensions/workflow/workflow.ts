import {
	isModelId,
	type ModelSettings,
	parseModelSettings,
} from "../../shared/model-settings";
import {
	isReasoningLevel,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
import {
	isSingleLineText,
	isTechnicalIdentifier,
} from "../../shared/text-contracts";
import { toWorkflowMatchKey } from "../../shared/workflow-policy";
import type { WorkflowTrigger } from "../../shared/workflow-trigger-runtime";

export type WorkflowTransitionType = "advance" | "rework";
export type WorkflowStageStatus = "not_started" | "in_progress" | "completed";
export type WorkflowSource = "catalog" | "dynamic";

/** Captures the runtime values that must be restored when a workflow completes. */
export interface WorkflowRestorationSettings {
	readonly modelId: string;
	readonly thinking: ReasoningLevel;
}

/** One normalized workflow stage with explicit boolean flags. */
export interface WorkflowStage {
	readonly id: string;
	readonly description: string;
	readonly prompt: string;
	readonly goal?: string;
	readonly triggers: readonly WorkflowTrigger[];
	readonly workflow?: string;
	readonly initial: boolean;
	readonly final: boolean;
	readonly model?: ModelSettings;
}

/** A named condition for taking a transition. */
export interface WorkflowGround {
	readonly id: string;
	readonly when: string;
}

/** One directed edge in a validated workflow graph. */
export interface WorkflowTransition {
	readonly from: string;
	readonly to: string;
	readonly type: WorkflowTransitionType;
	readonly grounds?: readonly WorkflowGround[];
	readonly workflow?: string;
}

/** Keeps the checked parent request with the bound workflow that owns its permission. */
export interface PendingWorkflowTransition {
	readonly stageId: string;
	readonly ground?: string;
}

/** A complete workflow definition accepted at a runtime boundary. */
export interface WorkflowDefinition {
	readonly version?: 2 | 3;
	readonly nested?: boolean;
	readonly kind?: string;
	readonly id: string;
	readonly description: string;
	readonly prompt?: string;
	readonly model?: ModelSettings;
	readonly stages: readonly WorkflowStage[];
	readonly transitions: readonly WorkflowTransition[];
}

/** The only mutable workflow state: one saved definition, its lifecycle, and its actual route. */
export interface WorkflowState {
	readonly source: WorkflowSource;
	readonly workflow: WorkflowDefinition;
	readonly route: readonly string[];
	readonly restoration?: WorkflowRestorationSettings;
	readonly pendingTransition?: PendingWorkflowTransition;
}

/** Orders running workflows from the root to the active top. */
export type WorkflowChain<T = WorkflowState> = readonly T[];

/** Selects the active workflow through the shared chain boundary. */
export function getTopWorkflow<T>(chain: WorkflowChain<T>): T | undefined {
	return chain.at(-1);
}

/** Adds one new workflow by its declared nesting rule after rejecting running identities. */
export function addWorkflow(
	chain: WorkflowChain,
	state: WorkflowState,
): WorkflowChain {
	if (
		chain.some(
			({ workflow }) =>
				toWorkflowMatchKey(workflow.id) ===
				toWorkflowMatchKey(state.workflow.id),
		)
	) {
		throw new Error(`workflow ${state.workflow.id} already runs in the chain`);
	}
	if (state.pendingTransition !== undefined) {
		const parent = getTopWorkflow(chain);
		if (
			state.source !== "catalog" ||
			state.workflow.nested !== true ||
			parent === undefined
		) {
			throw new Error(
				"pending transition requires a catalog nested workflow and a waiting parent",
			);
		}
		const { stageId, ground } = state.pendingTransition;
		transitionWorkflow(parent, stageId, ground);
		const edge = getAvailableTransitions(parent).find(
			({ to }) => to === stageId,
		);
		if (edge?.workflow !== state.workflow.id) {
			throw new Error("pending transition must bind the started workflow");
		}
	}
	return state.workflow.nested === true ? [...chain, state] : [state];
}

/** Removes the top and resolves its pending parent transition when permission is given. */
export function exitWorkflow(
	chain: WorkflowChain,
	allow?: boolean,
): WorkflowChain {
	const top = getTopWorkflow(chain);
	if (top === undefined) {
		throw new Error("no workflow is active");
	}
	const remaining = chain.slice(0, -1);
	if (top.pendingTransition === undefined) {
		return remaining;
	}
	if (typeof allow !== "boolean") {
		throw new Error("allow must be a boolean for a pending transition");
	}
	if (!allow) {
		return remaining;
	}
	const parent = getTopWorkflow(remaining);
	if (parent === undefined) {
		throw new Error("pending transition has no waiting parent");
	}
	const { stageId, ground } = top.pendingTransition;
	return [
		...remaining.slice(0, -1),
		transitionWorkflow(parent, stageId, ground),
	];
}

/** Requires every catalog identity bound to a transition or a stage to name a workflow intended for nested execution. */
export function validateWorkflowBindings(
	workflow: WorkflowDefinition,
	catalog: readonly WorkflowDefinition[],
): void {
	for (const binding of [
		...workflow.transitions.map((edge) => edge.workflow),
		...workflow.stages.map((stage) => stage.workflow),
	]) {
		if (binding !== undefined) {
			const bound = findBoundWorkflow(binding, catalog);
			if (bound.nested !== true) {
				throw new Error(`bound workflow ${binding} must have nested: true`);
			}
		}
	}
}

/** Returns the catalog workflow that a binding names, and rejects a binding whose workflow is absent from the catalog. */
export function findBoundWorkflow(
	binding: string,
	catalog: readonly WorkflowDefinition[],
): WorkflowDefinition {
	const bound = catalog.find(
		({ id }) => toWorkflowMatchKey(id) === toWorkflowMatchKey(binding),
	);
	if (bound === undefined) {
		throw new Error(`bound workflow ${binding} does not exist in the catalog`);
	}
	return bound;
}

/** Returns the catalog workflow that the active stage of the top workflow starts on entry, if the stage names one. */
export function findStageWorkflow(
	chain: WorkflowChain,
	catalog: readonly WorkflowDefinition[],
): WorkflowDefinition | undefined {
	const top = getTopWorkflow(chain);
	const binding = top?.workflow.stages.find(
		({ id }) => id === top.route.at(-1),
	)?.workflow;
	return binding === undefined
		? undefined
		: findBoundWorkflow(binding, catalog);
}

/** Rejects a chain whose entered stages would start a missing workflow or one that already runs in the chain. */
export function validateStageWorkflowStarts(
	chain: WorkflowChain,
	catalog: readonly WorkflowDefinition[],
): void {
	let current = chain;
	for (
		let workflow = findStageWorkflow(current, catalog);
		workflow !== undefined;
		workflow = findStageWorkflow(current, catalog)
	) {
		current = addWorkflow(current, activateWorkflow(workflow));
	}
}

/** Result of replaying workflow operations and the last empty-chain restoration. */
export interface WorkflowChainReplayResult {
	readonly chain: WorkflowChain;
	readonly restoration: WorkflowRestorationSettings | undefined;
	readonly warnings: readonly string[];
}

/** Accepted root fields of a catalog definition. */
const ROOT_KEYS = new Set([
	"kind",
	"version",
	"nested",
	"description",
	"prompt",
	"model",
	"stages",
	"transitions",
]);
const CREATED_ROOT_KEYS = new Set([
	"kind",
	"id",
	"nested",
	"description",
	"prompt",
	"stages",
	"transitions",
]);
const STAGE_KEYS = new Set([
	"id",
	"description",
	"prompt",
	"triggers",
	"initial",
	"final",
	"model",
]);
const CREATED_STAGE_KEYS = new Set([
	"id",
	"description",
	"prompt",
	"triggers",
	"initial",
	"final",
	"model",
]);
const CREATED_MODEL_KEYS = new Set(["thinking"]);
/** Accepted replacement fields shared by live edits and saved edit replay. */
const STAGE_EDIT_KEYS = new Set([
	"stageId",
	"description",
	"goal",
	"prompt",
	"model",
]);
const TRIGGER_KEYS = new Set(["type"]);
const TRANSITION_KEYS = new Set(["from", "to", "type"]);
const SAVED_WORKFLOW_KEYS = new Set(["id", ...ROOT_KEYS]);
/** Allowed root fields of a saved dynamic definition. */
const SAVED_DYNAMIC_WORKFLOW_KEYS = new Set([...CREATED_ROOT_KEYS, "version"]);
const RESTORATION_KEYS = new Set(["modelId", "thinking"]);

/** Definition format that permits nested execution. */
const WORKFLOW_NESTED_FORMAT_VERSION = 3;

/** Journal contract required by persisted workflow root snapshots. */
export const WORKFLOW_STATE_JOURNAL_VERSION = 2;

/** Warning emitted when a workflow snapshot predates the current persisted state contract. */
export const WORKFLOW_LEGACY_STATE_WARNING =
	"[workflow] ignored workflow state from an older format; start a new workflow to continue";

/** Validates YAML-derived data before it enters workflow domain logic. */
export function validateWorkflowDefinition(
	id: string,
	value: unknown,
	source: string,
): WorkflowDefinition {
	try {
		const normalizedId = id.normalize("NFC");
		assertSingleLineText(normalizedId, "workflow id");
		const root = requireObject(value, "workflow", ROOT_KEYS);
		return parseWorkflowDefinition(normalizedId, root);
	} catch (error) {
		throw new Error(`${source}: ${errorMessage(error)}`);
	}
}

/** Validates a complete workflow_create boundary object. */
export function validateCreatedWorkflowDefinition(
	value: unknown,
	source: string,
): WorkflowDefinition {
	try {
		const root = requireObject(value, "workflow", CREATED_ROOT_KEYS);
		const id = readSingleLineText(root, "id").normalize("NFC");
		return parseWorkflowDefinition(id, { ...root, version: 3 }, "created");
	} catch (error) {
		throw new Error(`${source}: ${errorMessage(error)}`);
	}
}

/** Starts a catalog workflow at its sole initial stage. */
export function activateWorkflow(workflow: WorkflowDefinition): WorkflowState {
	return startWorkflow(workflow, "catalog");
}

/** Starts a dynamic workflow at its sole initial stage. */
export function createWorkflow(workflow: WorkflowDefinition): WorkflowState {
	return startWorkflow(workflow, "dynamic");
}

/** Starts a validated workflow without conflating its policy source. */
function startWorkflow(
	workflow: WorkflowDefinition,
	source: WorkflowSource,
): WorkflowState {
	const initial = workflow.stages.find((stage) => stage.initial);
	if (initial === undefined) {
		throw new Error("validated workflow has no initial stage");
	}
	return { source, workflow, route: [initial.id] };
}

/** Attaches the pre-workflow runtime snapshot before the activation is persisted. */
export function withWorkflowRestoration(
	state: WorkflowState,
	restoration: WorkflowRestorationSettings,
): WorkflowState {
	if (state.restoration !== undefined) {
		throw new Error("workflow restoration settings are already assigned");
	}
	return { ...state, restoration };
}

/** Returns the ground that a transition call selects: the named ground, or the sole ground when the call names none. */
export function findSelectedGround(
	transition: WorkflowTransition,
	groundId: string | undefined,
): WorkflowGround | undefined {
	const grounds = transition.grounds ?? [];
	if (groundId === undefined) {
		return grounds.length === 1 ? grounds[0] : undefined;
	}
	return grounds.find(({ id }) => id === groundId);
}

/** Applies one currently available transition without mutating the prior state. */
export function transitionWorkflow(
	state: WorkflowState,
	stageId: string,
	ground?: string,
): WorkflowState {
	assertTechnicalIdentifier(stageId, "stageId");
	const availableTransitions = getAvailableTransitions(state);
	const transition = availableTransitions.find(
		(candidate) => candidate.to === stageId,
	);
	if (transition === undefined) {
		const available = availableTransitions.map(({ to }) => to);
		throw new Error(
			`transition to ${stageId} is not allowed; available transitions: ${available.length === 0 ? "none" : available.join(", ")}`,
		);
	}
	const grounds = transition.grounds ?? [];
	if (grounds.length > 0) {
		if (findSelectedGround(transition, ground) === undefined) {
			const allowed = grounds.map(({ id, when }) => `- ${id}: ${when}`);
			throw new Error(
				`transition to ${stageId} requires a declared ground; allowed grounds:\n${allowed.join("\n")}`,
			);
		}
	} else if (ground !== undefined) {
		throw new Error(`transition to ${stageId} has no grounds; omit ground`);
	}
	if (transition.type === "advance") {
		return {
			...state,
			route: [...state.route, transition.to],
		};
	}
	const targetIndex = state.route.lastIndexOf(transition.to);
	return {
		...state,
		route: state.route.slice(0, targetIndex + 1),
	};
}

/** Replaces only the editable fields of one stage in the current active workflow. */
export function editWorkflowStage(
	state: WorkflowState,
	value: unknown,
	source: string,
): WorkflowState {
	if (state.source !== "dynamic") {
		throw new Error(
			"only workflows created through workflow_create can be inspected or edited",
		);
	}
	try {
		const root = requireObject(value, "stage edit", STAGE_EDIT_KEYS);
		const stageId = readTechnicalIdentifier(root, "stageId");
		const description = readSingleLineText(root, "description");
		const stageFields = selectWorkflowFormat(
			state.workflow.version,
		).stageFields({
			...root,
			id: stageId,
		});
		const prompt = readPromptText(root, "prompt");
		const model = requireObject(
			Reflect.get(root, "model"),
			"model",
			CREATED_MODEL_KEYS,
		);
		const thinking = Reflect.get(model, "thinking");
		if (!isReasoningLevel(thinking)) {
			throw new Error("model.thinking is invalid");
		}
		const stageIndex = state.workflow.stages.findIndex(
			(stage) => stage.id === stageId,
		);
		if (stageIndex < 0) {
			throw new Error(`stage ${stageId} does not exist in active workflow`);
		}
		const stage = state.workflow.stages[stageIndex];
		if (stage === undefined) {
			throw new Error(`stage ${stageId} does not exist in active workflow`);
		}
		const stages = [...state.workflow.stages];
		stages[stageIndex] = {
			...stage,
			description,
			...stageFields,
			prompt,
			model: { ...stage.model, thinking },
		};
		return {
			...state,
			workflow: { ...state.workflow, stages },
		};
	} catch (error) {
		throw new Error(`${source}: ${errorMessage(error)}`);
	}
}

/** Derives every stage status from route membership and the active route tail. */
export function getStageStatuses(
	state: WorkflowState,
): ReadonlyMap<string, WorkflowStageStatus> {
	const activeStageId = state.route.at(-1);
	const routeIds = new Set(state.route);
	return new Map(
		state.workflow.stages.map((stage) => [
			stage.id,
			deriveStageStatus(stage.id, activeStageId, routeIds),
		]),
	);
}

/** Applies the route precedence rule for one stage without nested conditions. */
function deriveStageStatus(
	stageId: string,
	activeStageId: string | undefined,
	routeIds: ReadonlySet<string>,
): WorkflowStageStatus {
	if (stageId === activeStageId) {
		return "in_progress";
	}
	if (routeIds.has(stageId)) {
		return "completed";
	}
	return "not_started";
}

/** Selects outgoing graph edges permitted by the actual completed route. */
export function getAvailableTransitions(
	state: WorkflowState,
): readonly WorkflowTransition[] {
	const activeStageId = state.route.at(-1);
	if (activeStageId === undefined) {
		return [];
	}
	return state.workflow.transitions.filter(
		(transition) =>
			transition.from === activeStageId &&
			(transition.type === "advance" || state.route.includes(transition.to)),
	);
}

/** Reconstructs running workflows and restoration settings from the active branch. */
export function replayWorkflowChain(
	entries: readonly unknown[],
): WorkflowChainReplayResult {
	const cursor: WorkflowReplayCursor = {
		chain: [],
		restoration: undefined,
		journalVersion: undefined,
		legacyCompleted: undefined,
		ignoringLegacy: false,
		warnings: [],
	};
	for (const entry of entries) {
		if (!isWorkflowStateEntry(entry)) {
			continue;
		}
		try {
			const data = requireObject(
				Reflect.get(entry, "data"),
				"workflow-state data",
			);
			const action = classifyWorkflowReplayAction(data, cursor.ignoringLegacy);
			if (action === "ignore") {
				continue;
			}
			if (action === "legacy") {
				cursor.chain = [];
				cursor.restoration = undefined;
				cursor.legacyCompleted = undefined;
				cursor.ignoringLegacy = true;
				cursor.warnings = [WORKFLOW_LEGACY_STATE_WARNING];
				continue;
			}
			cursor.ignoringLegacy = false;
			cursor.warnings = [];
			applyWorkflowReplayEntry(cursor, entry, data);
		} catch (error) {
			throw new Error(`invalid workflow-state entry: ${errorMessage(error)}`);
		}
	}
	return {
		chain: cursor.chain,
		restoration: cursor.restoration,
		warnings: cursor.warnings,
	};
}

/** Holds journal compatibility evidence alongside the running chain during replay. */
interface WorkflowReplayCursor {
	chain: WorkflowChain;
	restoration: WorkflowRestorationSettings | undefined;
	journalVersion: number | undefined;
	legacyCompleted: WorkflowState | undefined;
	ignoringLegacy: boolean;
	warnings: string[];
}

/** Applies one supported operation to the replay cursor. */
function applyWorkflowReplayEntry(
	cursor: WorkflowReplayCursor,
	entry: object,
	data: Record<string, unknown>,
): void {
	if (Reflect.get(entry, "type") !== "custom") {
		throw new Error("entry type must be custom");
	}
	const kind = data["kind"];
	const starts = kind === "activated" || kind === "created";
	if (starts) {
		requireWorkflowJournalVersion(data);
		cursor.journalVersion = data["journalVersion"] as number;
		cursor.legacyCompleted = undefined;
	} else if (
		!isSupportedWorkflowOperationVersion(data, cursor.journalVersion)
	) {
		throw new Error(`journalVersion is unsupported for ${String(kind)} entry`);
	}
	if (kind === "exited" || kind === "completed") {
		applyWorkflowReplayExit(cursor, data);
		return;
	}
	const historical =
		kind === "transitioned" &&
		data["journalVersion"] === undefined &&
		cursor.journalVersion === 1
			? cursor.legacyCompleted
			: undefined;
	const next = replayWorkflowStateEntry(
		getTopWorkflow(cursor.chain) ?? historical,
		entry,
	);
	cursor.chain = starts
		? addWorkflow(cursor.chain, next)
		: [...cursor.chain.slice(0, -1), next];
	cursor.restoration = undefined;
	cursor.legacyCompleted = undefined;
}

/** Checks operation versions against the supported root's journal contract. */
export function isSupportedWorkflowOperationVersion(
	data: Readonly<Record<string, unknown>>,
	rootJournalVersion: number | undefined,
): boolean {
	const version = data["journalVersion"];
	const legacy = rootJournalVersion === 1 && version === undefined;
	switch (data["kind"]) {
		case "completed":
			return legacy;
		case "exited":
			return version === 2;
		default:
			// Orphan shared operations reach their missing-snapshot validation.
			return (
				version === 2 || (version === undefined && rootJournalVersion !== 2)
			);
	}
}

/** Removes completed legacy workflows while retaining evidence for historical rework. */
function applyWorkflowReplayExit(
	cursor: WorkflowReplayCursor,
	data: Record<string, unknown>,
): void {
	const kind = data["kind"];
	assertExactKeys(
		data,
		new Set(
			kind === "completed"
				? ["kind", "route", "journalVersion"]
				: ["kind", "journalVersion", "allow"],
		),
		`${kind} entry`,
	);
	const state = getTopWorkflow(cursor.chain);
	if (state === undefined) {
		throw new Error(`${kind} entry has no active snapshot`);
	}
	cursor.legacyCompleted = undefined;
	if (kind === "completed") {
		const route = validateRoute(state.workflow, data["route"]);
		if (!state.workflow.stages.find(({ id }) => id === route.at(-1))?.final) {
			throw new Error("only a final workflow stage can complete the workflow");
		}
		cursor.legacyCompleted = { ...state, route };
	}
	const restoration = cursor.chain[0]?.restoration;
	if ("allow" in data && typeof data["allow"] !== "boolean") {
		throw new Error("allow must be a boolean");
	}
	cursor.chain = exitWorkflow(
		cursor.chain,
		data["allow"] as boolean | undefined,
	);
	cursor.restoration = cursor.chain.length === 0 ? restoration : undefined;
}

/** Selects whether one persisted entry starts, continues, or ends a legacy chain. */
function classifyWorkflowReplayAction(
	data: Readonly<Record<string, unknown>>,
	ignoringLegacyState: boolean,
): "ignore" | "legacy" | "replay" {
	const kind = Reflect.get(data, "kind");
	if (ignoringLegacyState) {
		if (kind !== "activated" && kind !== "created") {
			return "ignore";
		}
		return isLegacyWorkflowStateData(data) ? "legacy" : "replay";
	}
	return isLegacyWorkflowStateData(data) ? "legacy" : "replay";
}

/** Applies one exact saved entry while preserving source across route-only updates. */
function replayWorkflowStateEntry(
	state: WorkflowState | undefined,
	entry: object,
): WorkflowState {
	if (Reflect.get(entry, "type") !== "custom") {
		throw new Error("entry type must be custom");
	}
	const data = requireObject(Reflect.get(entry, "data"), "workflow-state data");
	const kind = Reflect.get(data, "kind");
	if (kind === "activated" || kind === "created") {
		return replayWorkflowStart(data, kind);
	}
	if (kind === "stage_edited") {
		return replayWorkflowStageEdit(state, data);
	}
	if (kind === "transitioned") {
		assertExactKeys(
			data,
			new Set(["kind", "route", "journalVersion"]),
			"transitioned entry",
		);
		if (state === undefined) {
			throw new Error("transitioned entry has no active snapshot");
		}
		return {
			...state,
			route: validateRoute(state.workflow, Reflect.get(data, "route")),
		};
	}
	throw new Error(
		"entry kind must be activated, created, stage_edited, transitioned, exited, or completed for legacy replay",
	);
}

/** Validates a saved start before the shared chain rule applies it. */
function replayWorkflowStart(
	data: Record<string, unknown>,
	kind: "activated" | "created",
): WorkflowState {
	assertExactKeys(
		data,
		new Set([
			"kind",
			"workflow",
			"route",
			"restoration",
			"journalVersion",
			"mode",
			"pendingTransition",
		]),
		`${kind} entry`,
	);
	requireWorkflowJournalVersion(data);
	const workflow = validateSavedWorkflow(
		data["workflow"],
		kind === "activated",
	);
	const mode = data["mode"] ?? "replace";
	if (
		mode !== (workflow.nested === true ? "push" : "replace") ||
		(mode === "push" &&
			data["journalVersion"] !== WORKFLOW_STATE_JOURNAL_VERSION)
	) {
		throw new Error(
			"workflow start mode must match its nested definition and journal version",
		);
	}
	const restoration = validateRestorationSettings(data["restoration"]);
	const pending = data["pendingTransition"];
	let pendingTransition: PendingWorkflowTransition | undefined;
	if ("pendingTransition" in data) {
		if (
			kind !== "activated" ||
			data["journalVersion"] !== WORKFLOW_STATE_JOURNAL_VERSION
		) {
			throw new Error("pending transition requires a journal2 catalog start");
		}
		const value = requireObject(
			pending,
			"pendingTransition",
			new Set(["stageId", "ground"]),
		);
		pendingTransition = {
			stageId: readTechnicalIdentifier(value, "stageId"),
			...("ground" in value
				? { ground: readTechnicalIdentifier(value, "ground") }
				: {}),
		};
	}
	return {
		source: kind === "activated" ? "catalog" : "dynamic",
		workflow,
		route: validateRoute(workflow, data["route"]),
		...(restoration !== undefined ? { restoration } : {}),
		...(pendingTransition === undefined ? {} : { pendingTransition }),
	};
}

/** Applies one persisted edit only to an active dynamic workflow snapshot. */
function replayWorkflowStageEdit(
	state: WorkflowState | undefined,
	data: Record<string, unknown>,
): WorkflowState {
	assertExactKeys(
		data,
		new Set(["kind", "journalVersion", ...STAGE_EDIT_KEYS]),
		"stage_edited entry",
	);
	if (state === undefined) {
		throw new Error("stage_edited entry has no active snapshot");
	}
	return editWorkflowStage(
		state,
		{
			stageId: Reflect.get(data, "stageId"),
			description: Reflect.get(data, "description"),
			...("goal" in data ? { goal: Reflect.get(data, "goal") } : {}),
			prompt: Reflect.get(data, "prompt"),
			model: Reflect.get(data, "model"),
		},
		"stage_edited entry",
	);
}

/** Identifies an activation or creation entry from before restoration was persisted. */
function requireWorkflowJournalVersion(
	data: Readonly<Record<string, unknown>>,
): void {
	if (data["journalVersion"] !== 1 && data["journalVersion"] !== 2) {
		throw new Error("journalVersion must be 1 or 2");
	}
}

function isLegacyWorkflowStateData(
	data: Readonly<Record<string, unknown>>,
): boolean {
	const kind = Reflect.get(data, "kind");
	if (kind !== "activated" && kind !== "created") {
		return false;
	}
	return !Object.hasOwn(data, "journalVersion");
}

/** Identifies every entry claiming workflow ownership before outer-shape validation. */
function isWorkflowStateEntry(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Reflect.get(value, "customType") === "workflow-state"
	);
}

/** Revalidates a persisted definition instead of trusting session JSON. */
function validateSavedWorkflow(
	value: unknown,
	allowModelSettings: boolean,
): WorkflowDefinition {
	const saved = requireObject(
		value,
		"saved workflow",
		allowModelSettings ? SAVED_WORKFLOW_KEYS : SAVED_DYNAMIC_WORKFLOW_KEYS,
	);
	const id = readSingleLineText(saved, "id").normalize("NFC");
	if (!allowModelSettings) {
		return parseWorkflowDefinition(id, saved, "saved-created");
	}
	return validateWorkflowDefinition(
		id,
		{
			version: Reflect.get(saved, "version"),
			...(Object.hasOwn(saved, "nested") ? { nested: saved["nested"] } : {}),
			...(Object.hasOwn(saved, "kind") ? { kind: saved["kind"] } : {}),
			description: Reflect.get(saved, "description"),
			prompt: Reflect.get(saved, "prompt"),
			model: Reflect.get(saved, "model"),
			stages: Reflect.get(saved, "stages"),
			transitions: Reflect.get(saved, "transitions"),
		},
		"saved workflow",
	);
}

/** Checks that a persisted route starts correctly and follows only advance edges. */
function validateRestorationSettings(
	value: unknown,
): WorkflowRestorationSettings | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const restoration = requireObject(
		value,
		"workflow restoration",
		RESTORATION_KEYS,
	);
	const modelId = restoration["modelId"];
	if (!isModelId(modelId)) {
		throw new Error("workflow restoration modelId must use provider/model");
	}
	const thinking = restoration["thinking"];
	if (!isReasoningLevel(thinking)) {
		throw new Error("workflow restoration thinking is invalid");
	}
	return { modelId, thinking };
}

/** Checks that a persisted route starts correctly and follows only advance edges. */
function validateRoute(
	workflow: WorkflowDefinition,
	value: unknown,
): readonly string[] {
	const route = requireArray(value, "route");
	if (route.length === 0) {
		throw new Error("route must be non-empty");
	}
	const ids = route.map((item, index) => {
		if (typeof item !== "string") {
			throw new Error(`route[${index}] must be a string`);
		}
		return item;
	});
	const initial = workflow.stages.find((stage) => stage.initial)?.id;
	if (ids[0] !== initial) {
		throw new Error("route must start at the initial stage");
	}
	for (let index = 1; index < ids.length; index += 1) {
		const from = ids[index - 1];
		const to = ids[index];
		if (
			!workflow.transitions.some(
				(edge) =>
					edge.type === "advance" && edge.from === from && edge.to === to,
			)
		) {
			throw new Error(`route contains invalid advance ${from} -> ${to}`);
		}
	}
	return ids;
}

/** Format-specific validation rules for catalog and saved definitions. */
interface WorkflowFormatRules {
	readonly definitionFields: { readonly version?: 2 | 3 };
	stageFields(stage: Record<string, unknown>): Pick<WorkflowStage, "goal">;
	transitionFields(
		transition: Record<string, unknown>,
	): Pick<WorkflowTransition, "grounds">;
	validateTransitions(transitions: readonly WorkflowTransition[]): void;
}

/** Validation rules for each accepted workflow format version. */
const WORKFLOW_FORMATS: Readonly<Record<number, WorkflowFormatRules>> = {
	1: {
		definitionFields: {},
		stageFields(stage) {
			if ("goal" in stage) {
				throw new Error("stage goal requires workflow format version 2");
			}
			return {};
		},
		transitionFields(transition) {
			if ("grounds" in transition) {
				throw new Error("transition grounds require workflow format version 2");
			}
			return {};
		},
		validateTransitions() {},
	},
	2: {
		definitionFields: { version: 2 },
		stageFields(stage) {
			try {
				return { goal: readPromptText(stage, "goal") };
			} catch (error) {
				throw new Error(`stage ${String(stage["id"])}: ${errorMessage(error)}`);
			}
		},
		transitionFields(transition) {
			try {
				const value = transition["grounds"];
				if (value === undefined) {
					return {};
				}
				const ids = new Set<string>();
				const grounds = requireArray(value, "grounds").map((value) => {
					const ground = requireObject(value, "ground", GROUND_KEYS);
					const id = readTechnicalIdentifier(ground, "id");
					if (ids.has(id)) {
						throw new Error(`duplicate ground id ${id}`);
					}
					ids.add(id);
					return { id, when: readPromptText(ground, "when") };
				});
				return { grounds };
			} catch (error) {
				throw new Error(
					`transition ${String(transition["from"])} -> ${String(transition["to"])}: ${errorMessage(error)}`,
				);
			}
		},
		validateTransitions(transitions) {
			for (const edge of transitions) {
				const required =
					edge.type === "rework" ||
					transitions.filter(
						(candidate) =>
							candidate.from === edge.from && candidate.type === "advance",
					).length > 1;
				if (required && !edge.grounds?.length) {
					throw new Error(
						`transition ${edge.from} -> ${edge.to} requires grounds`,
					);
				}
			}
		},
	},
};

/** Allowed fields of a transition ground. */
const GROUND_KEYS = new Set(["id", "when"]);

/** Selects validation rules for a workflow format version. */
function selectWorkflowFormat(version: unknown): WorkflowFormatRules {
	if (version === WORKFLOW_NESTED_FORMAT_VERSION) {
		return { ...selectWorkflowFormat(2), definitionFields: { version: 3 } };
	}
	const selected = version === undefined ? 1 : version;
	const rules =
		typeof selected === "number" ? WORKFLOW_FORMATS[selected] : undefined;
	if (rules === undefined) {
		throw new Error(
			`unknown workflow format version ${typeof selected === "number" ? String(selected) : JSON.stringify(selected)}`,
		);
	}
	return rules;
}

/** Parses one exact-key workflow object and applies the shared graph rules. */
function parseWorkflowDefinition(
	id: string,
	root: Readonly<Record<string, unknown>>,
	modelSettingsSource: "catalog" | "created" | "saved-created" = "catalog",
): WorkflowDefinition {
	const format = selectWorkflowFormat(Reflect.get(root, "version"));
	if ("nested" in root && root["version"] !== WORKFLOW_NESTED_FORMAT_VERSION) {
		throw new Error("nested requires workflow format version 3");
	}
	if ("kind" in root && root["version"] !== WORKFLOW_NESTED_FORMAT_VERSION) {
		throw new Error("kind requires workflow format version 3");
	}
	const kind =
		"kind" in root
			? { kind: readSingleLineText(root, "kind").normalize("NFC") }
			: {};
	const nested =
		"nested" in root ? { nested: readOptionalBoolean(root, "nested") } : {};
	const description = readSingleLineText(root, "description");
	const prompt = readOptionalPromptText(root, "prompt");
	const model =
		modelSettingsSource === "catalog"
			? parseModelSettings(Reflect.get(root, "model"), "workflow.model")
			: undefined;
	const rawStages = requireArray(Reflect.get(root, "stages"), "stages");
	const rawTransitions = requireArray(
		Reflect.get(root, "transitions"),
		"transitions",
	);
	const stages = rawStages.map((stage, index) =>
		parseStage(stage, index, modelSettingsSource, format),
	);
	const transitions = rawTransitions.map((transition, index) =>
		parseTransition(
			transition,
			index,
			format,
			root["version"] === WORKFLOW_NESTED_FORMAT_VERSION,
		),
	);
	const modelSettings = model === undefined ? {} : { model };
	const workflow =
		prompt === undefined
			? { id, description, ...modelSettings, stages, transitions }
			: { id, description, prompt, ...modelSettings, stages, transitions };
	validateGraph(workflow);
	format.validateTransitions(transitions);
	return { ...workflow, ...format.definitionFields, ...nested, ...kind };
}

/** Parses one stage with closed keys and explicit defaults. */
function parseStage(
	value: unknown,
	index: number,
	modelSettingsSource: "catalog" | "created" | "saved-created",
	format: WorkflowFormatRules,
): WorkflowStage {
	const allowWorkflow =
		modelSettingsSource === "catalog" &&
		format.definitionFields.version === WORKFLOW_NESTED_FORMAT_VERSION;
	const stage = requireObject(
		value,
		`stages[${index}]`,
		new Set([
			...(modelSettingsSource === "catalog" ? STAGE_KEYS : CREATED_STAGE_KEYS),
			"goal",
			...(allowWorkflow ? ["workflow"] : []),
		]),
	);
	const model =
		modelSettingsSource === "catalog"
			? parseModelSettings(
					Reflect.get(stage, "model"),
					`stages[${index}].model`,
				)
			: parseCreatedModelSettings(
					Reflect.get(stage, "model"),
					`stages[${index}].model`,
					modelSettingsSource === "created",
				);
	return {
		...format.stageFields(stage),
		id: readTechnicalIdentifier(stage, "id"),
		description: readSingleLineText(stage, "description"),
		prompt: readPromptText(stage, "prompt"),
		triggers: parseTriggers(Reflect.get(stage, "triggers"), index),
		...("workflow" in stage
			? { workflow: readSingleLineText(stage, "workflow").normalize("NFC") }
			: {}),
		initial: readOptionalBoolean(stage, "initial"),
		final: readOptionalBoolean(stage, "final"),
		...(model === undefined ? {} : { model }),
	};
}

/** Parses optional thinking-only model settings accepted by workflow_create. */
function parseCreatedModelSettings(
	value: unknown,
	fieldPath: string,
	required = false,
): ModelSettings | undefined {
	if (value === undefined) {
		if (required) {
			throw new Error(`${fieldPath}.thinking is required`);
		}
		return undefined;
	}
	const model = requireObject(value, fieldPath, CREATED_MODEL_KEYS);
	const thinking = Reflect.get(model, "thinking");
	if (thinking !== "low" && thinking !== "medium" && thinking !== "high") {
		throw new Error(`${fieldPath}.thinking must be one of low, medium, high`);
	}
	return { thinking };
}

/** Parses the optional ordered trigger list without collapsing duplicates. */
function parseTriggers(value: unknown, stageIndex: number): WorkflowTrigger[] {
	if (value === undefined) {
		return [];
	}
	return requireArray(value, `stages[${stageIndex}].triggers`).map(
		(trigger, triggerIndex) =>
			parseTrigger(trigger, `stages[${stageIndex}].triggers[${triggerIndex}]`),
	);
}

/** Validates one closed trigger object against the currently supported types. */
function parseTrigger(value: unknown, path: string): WorkflowTrigger {
	const trigger = requireObject(value, path, TRIGGER_KEYS);
	const type = Reflect.get(trigger, "type");
	if (
		type !== "local_knowledge_accumulation" &&
		type !== "global_knowledge_accumulation"
	) {
		throw new Error(`${path}.type must be a supported workflow trigger type`);
	}
	return { type };
}

/** Parses one transition with a closed finite type. */
function parseTransition(
	value: unknown,
	index: number,
	format: WorkflowFormatRules,
	allowBinding: boolean,
): WorkflowTransition {
	const transition = requireObject(
		value,
		`transitions[${index}]`,
		new Set([
			...TRANSITION_KEYS,
			"grounds",
			...(allowBinding ? ["workflow"] : []),
		]),
	);
	const type = Reflect.get(transition, "type");
	if (type !== "advance" && type !== "rework") {
		throw new Error(`transitions[${index}].type must be advance or rework`);
	}
	return {
		...format.transitionFields(transition),
		...("workflow" in transition
			? {
					workflow: readSingleLineText(transition, "workflow").normalize("NFC"),
				}
			: {}),
		from: readTechnicalIdentifier(transition, "from"),
		to: readTechnicalIdentifier(transition, "to"),
		type,
	};
}

/** Enforces graph invariants after structural validation. */
function validateGraph(workflow: WorkflowDefinition): void {
	const initialStageId = validateStageIdentity(workflow);
	const stageIds = new Set(workflow.stages.map(({ id }) => id));
	validateTransitionReferences(workflow.transitions, stageIds);
	const advances = workflow.transitions.filter(
		({ type }) => type === "advance",
	);
	validateAdvanceGraph(workflow.stages, advances, initialStageId);
	validateReworkTransitions(workflow.transitions, advances);
}

/** Checks stage identity and returns the sole initial ID for graph traversal. */
function validateStageIdentity(workflow: WorkflowDefinition): string {
	const stageIds = new Set(workflow.stages.map(({ id }) => id));
	if (stageIds.size !== workflow.stages.length) {
		throw new Error("stage ids must be unique");
	}
	const initialStages = workflow.stages.filter(({ initial }) => initial);
	if (initialStages.length !== 1) {
		throw new Error("workflow must have exactly one initial stage");
	}
	if (!workflow.stages.some(({ final }) => final)) {
		throw new Error("workflow must have at least one final stage");
	}
	const initialStageId = initialStages[0]?.id;
	if (initialStageId === undefined) {
		throw new Error("workflow must have exactly one initial stage");
	}
	return initialStageId;
}

/** Checks endpoint ownership and ordered-pair uniqueness for every edge. */
function validateTransitionReferences(
	transitions: readonly WorkflowTransition[],
	stageIds: ReadonlySet<string>,
): void {
	const pairs = new Set<string>();
	for (const edge of transitions) {
		if (!stageIds.has(edge.from) || !stageIds.has(edge.to)) {
			throw new Error("transition endpoints must reference existing stages");
		}
		const pair = `${edge.from}\u0000${edge.to}`;
		if (pairs.has(pair)) {
			throw new Error("ordered stage pair must have at most one transition");
		}
		pairs.add(pair);
	}
}

/** Checks stage terminal rules, acyclicity, and reachability in the advance graph. */
function validateAdvanceGraph(
	stages: readonly WorkflowStage[],
	advances: readonly WorkflowTransition[],
	initialStageId: string,
): void {
	for (const stage of stages) {
		const outgoing = advances.some(({ from }) => from === stage.id);
		if (stage.final && outgoing) {
			throw new Error("final stage must not have outgoing advance");
		}
		if (!stage.final && !outgoing) {
			throw new Error("non-final stage must have an outgoing advance");
		}
	}
	const reachable = collectReachable(initialStageId, advances);
	if (reachable.size !== stages.length) {
		throw new Error("every stage must be reachable from initial by advance");
	}
}

/** Checks that every rework target is a strict ancestor of its source. */
function validateReworkTransitions(
	transitions: readonly WorkflowTransition[],
	advances: readonly WorkflowTransition[],
): void {
	for (const edge of transitions.filter(({ type }) => type === "rework")) {
		if (
			edge.from === edge.to ||
			!collectReachable(edge.to, advances).has(edge.from)
		) {
			throw new Error("rework target must be a strict advance ancestor");
		}
	}
}

/** Traverses advance edges while rejecting cycles reachable from the selected root. */
function collectReachable(
	root: string,
	advances: readonly WorkflowTransition[],
): Set<string> {
	const reached = new Set<string>();
	const visiting = new Set<string>();
	/** Marks one depth-first branch and rejects a back edge before completion. */
	const visit = (stageId: string): void => {
		if (visiting.has(stageId)) {
			throw new Error("advance graph must be acyclic");
		}
		if (reached.has(stageId)) {
			return;
		}
		visiting.add(stageId);
		for (const edge of advances) {
			if (edge.from === stageId) {
				visit(edge.to);
			}
		}
		visiting.delete(stageId);
		reached.add(stageId);
	};
	visit(root);
	return reached;
}

/** Requires a plain object and optionally rejects every unknown key. */
function requireObject(
	value: unknown,
	field: string,
	keys?: ReadonlySet<string>,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	if (keys !== undefined) {
		assertExactKeys(value, keys, field);
	}
	return value as Record<string, unknown>;
}

/** Rejects unknown keys while allowing required-key checks to remain field-specific. */
function assertExactKeys(
	value: object,
	keys: ReadonlySet<string>,
	field: string,
): void {
	if (Object.keys(value).some((key) => !keys.has(key))) {
		throw new Error(`${field} contains an unsupported key`);
	}
}

/** Requires an array at an external boundary. */
function requireArray(value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array`);
	}
	return value;
}

/** Reads one human-readable single-line field without applying LLM budgets. */
function readSingleLineText(value: object, key: string): string {
	const text = Reflect.get(value, key);
	assertSingleLineText(text, key);
	return text;
}

/** Reads one technical identifier without applying LLM budgets. */
function readTechnicalIdentifier(value: object, key: string): string {
	const text = Reflect.get(value, key);
	assertTechnicalIdentifier(text, key);
	return text;
}

/** Normalizes optional prompt text and omits content empty after trimming. */
function readOptionalPromptText(
	value: object,
	key: string,
): string | undefined {
	const text = Reflect.get(value, key);
	if (text === undefined) {
		return undefined;
	}
	if (typeof text !== "string") {
		throw new Error(`${key} must be a string`);
	}
	const normalized = text.trim();
	return normalized.length === 0 ? undefined : normalized;
}

/** Normalizes required prompt text while preserving its internal line structure. */
function readPromptText(value: object, key: string): string {
	const text = Reflect.get(value, key);
	if (typeof text !== "string") {
		throw new Error(`${key} must be a non-empty string`);
	}
	const normalized = text.trim();
	if (normalized.length === 0) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return normalized;
}

/** Rejects invalid human-readable text at workflow runtime boundaries. */
function assertSingleLineText(
	value: unknown,
	field: string,
): asserts value is string {
	if (!isSingleLineText(value)) {
		throw new Error(`${field} must be a non-empty trimmed single-line string`);
	}
}

/** Rejects whitespace-bearing technical references at workflow runtime boundaries. */
function assertTechnicalIdentifier(
	value: unknown,
	field: string,
): asserts value is string {
	if (!isTechnicalIdentifier(value)) {
		throw new Error(`${field} must be a non-empty string without whitespace`);
	}
}

/** Reads an optional strict boolean and supplies the approved false default. */
function readOptionalBoolean(value: object, key: string): boolean {
	const candidate = Reflect.get(value, key);
	if (candidate === undefined) {
		return false;
	}
	if (typeof candidate !== "boolean") {
		throw new Error(`${key} must be boolean`);
	}
	return candidate;
}

/** Converts unknown thrown values into safe diagnostics. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
