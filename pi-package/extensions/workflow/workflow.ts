import {
	type ModelSettings,
	parseModelSettings,
} from "../../shared/model-settings";
import {
	isSingleLineText,
	isTechnicalIdentifier,
} from "../../shared/text-contracts";
import type { WorkflowTrigger } from "../../shared/workflow-trigger-runtime";

export type WorkflowTransitionType = "advance" | "rework";
export type WorkflowStageStatus = "not_started" | "in_progress" | "completed";
export type WorkflowSource = "catalog" | "dynamic";

/** One normalized workflow stage with explicit boolean flags. */
export interface WorkflowStage {
	readonly id: string;
	readonly description: string;
	readonly prompt: string;
	readonly triggers: readonly WorkflowTrigger[];
	readonly initial: boolean;
	readonly final: boolean;
	readonly model?: ModelSettings;
}

/** One directed edge in a validated workflow graph. */
export interface WorkflowTransition {
	readonly from: string;
	readonly to: string;
	readonly type: WorkflowTransitionType;
}

/** A complete workflow definition accepted at a runtime boundary. */
export interface WorkflowDefinition {
	readonly id: string;
	readonly description: string;
	readonly prompt?: string;
	readonly model?: ModelSettings;
	readonly stages: readonly WorkflowStage[];
	readonly transitions: readonly WorkflowTransition[];
}

/** The only mutable workflow state: one saved definition, its source, and its actual route. */
export interface WorkflowState {
	readonly source: WorkflowSource;
	readonly workflow: WorkflowDefinition;
	readonly route: readonly string[];
}

const ROOT_KEYS = new Set([
	"description",
	"prompt",
	"model",
	"stages",
	"transitions",
]);
const CREATED_ROOT_KEYS = new Set([
	"id",
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
]);
const TRIGGER_KEYS = new Set(["type"]);
const TRANSITION_KEYS = new Set(["from", "to", "type"]);
const SAVED_WORKFLOW_KEYS = new Set(["id", ...ROOT_KEYS]);
const SAVED_DYNAMIC_WORKFLOW_KEYS = new Set(CREATED_ROOT_KEYS);

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
		return parseWorkflowDefinition(id, root, false);
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

/** Applies one currently available transition without mutating the prior state. */
export function transitionWorkflow(
	state: WorkflowState,
	stageId: string,
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
	if (transition.type === "advance") {
		return { ...state, route: [...state.route, transition.to] };
	}
	const targetIndex = state.route.lastIndexOf(transition.to);
	return { ...state, route: state.route.slice(0, targetIndex + 1) };
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

/** Reconstructs state from validated matching entries on the active branch. */
export function replayWorkflowState(
	entries: readonly unknown[],
): WorkflowState | undefined {
	let state: WorkflowState | undefined;
	for (const entry of entries) {
		if (!isWorkflowStateEntry(entry)) {
			continue;
		}
		try {
			state = replayWorkflowStateEntry(state, entry);
		} catch (error) {
			throw new Error(`invalid workflow-state entry: ${errorMessage(error)}`);
		}
	}
	return state;
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
		assertExactKeys(
			data,
			new Set(["kind", "workflow", "route"]),
			`${kind} entry`,
		);
		const workflow = validateSavedWorkflow(
			Reflect.get(data, "workflow"),
			kind === "activated",
		);
		return {
			source: kind === "activated" ? "catalog" : "dynamic",
			workflow,
			route: validateRoute(workflow, Reflect.get(data, "route")),
		};
	}
	if (kind === "transitioned") {
		assertExactKeys(data, new Set(["kind", "route"]), "transitioned entry");
		if (state === undefined) {
			throw new Error("transitioned entry has no active snapshot");
		}
		return {
			...state,
			route: validateRoute(state.workflow, Reflect.get(data, "route")),
		};
	}
	throw new Error("entry kind must be activated, created, or transitioned");
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
	return validateWorkflowDefinition(
		id,
		{
			description: Reflect.get(saved, "description"),
			prompt: Reflect.get(saved, "prompt"),
			...(allowModelSettings ? { model: Reflect.get(saved, "model") } : {}),
			stages: Reflect.get(saved, "stages"),
			transitions: Reflect.get(saved, "transitions"),
		},
		"saved workflow",
	);
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

/** Parses one exact-key workflow object and applies the shared graph rules. */
function parseWorkflowDefinition(
	id: string,
	root: Readonly<Record<string, unknown>>,
	allowModelSettings = true,
): WorkflowDefinition {
	const description = readSingleLineText(root, "description");
	const prompt = readOptionalPromptText(root, "prompt");
	const model = allowModelSettings
		? parseModelSettings(Reflect.get(root, "model"), "workflow.model")
		: undefined;
	const rawStages = requireArray(Reflect.get(root, "stages"), "stages");
	const rawTransitions = requireArray(
		Reflect.get(root, "transitions"),
		"transitions",
	);
	const stages = rawStages.map((stage, index) =>
		parseStage(stage, index, allowModelSettings),
	);
	const transitions = rawTransitions.map((transition, index) =>
		parseTransition(transition, index),
	);
	const modelSettings = model === undefined ? {} : { model };
	const workflow =
		prompt === undefined
			? { id, description, ...modelSettings, stages, transitions }
			: { id, description, prompt, ...modelSettings, stages, transitions };
	validateGraph(workflow);
	return workflow;
}

/** Parses one stage with closed keys and explicit defaults. */
function parseStage(
	value: unknown,
	index: number,
	allowModelSettings: boolean,
): WorkflowStage {
	const stage = requireObject(
		value,
		`stages[${index}]`,
		allowModelSettings ? STAGE_KEYS : CREATED_STAGE_KEYS,
	);
	const model = allowModelSettings
		? parseModelSettings(Reflect.get(stage, "model"), `stages[${index}].model`)
		: undefined;
	return {
		id: readTechnicalIdentifier(stage, "id"),
		description: readSingleLineText(stage, "description"),
		prompt: readPromptText(stage, "prompt"),
		triggers: parseTriggers(Reflect.get(stage, "triggers"), index),
		initial: readOptionalBoolean(stage, "initial"),
		final: readOptionalBoolean(stage, "final"),
		...(model === undefined ? {} : { model }),
	};
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
function parseTransition(value: unknown, index: number): WorkflowTransition {
	const transition = requireObject(
		value,
		`transitions[${index}]`,
		TRANSITION_KEYS,
	);
	const type = Reflect.get(transition, "type");
	if (type !== "advance" && type !== "rework") {
		throw new Error(`transitions[${index}].type must be advance or rework`);
	}
	return {
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
