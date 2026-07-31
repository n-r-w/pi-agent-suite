import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import { registerPackageTool } from "../../shared/tool-presentation/registry";
import {
	hasAllowedWorkflowSource,
	isWorkflowAllowed,
	parseChildWorkflowPolicy,
	publishWorkflowCatalogPolicy,
	type WorkflowPolicyResolution,
} from "../../shared/workflow-policy";
import {
	loadWorkflowCatalog,
	loadWorkflowPrompts,
	type WorkflowPrompts,
} from "./config";
import { projectWorkflowContext } from "./context";
import { readWorkflowPolicyEnvironment } from "./environment";
import {
	createWorkflowPresentationDetails,
	primeWorkflowRenderState,
	renderWorkflowActivateCall,
	renderWorkflowResult,
	renderWorkflowTransitionCall,
	type WorkflowToolPresentationDetails,
} from "./tool-rendering.ts";
import {
	activateWorkflow,
	replayWorkflowState,
	transitionWorkflow,
	type WorkflowDefinition,
	type WorkflowState,
} from "./workflow";

const EXTENSION_DIRECTORY = "workflow";
const WORKFLOW_STATE_ENTRY = "workflow-state";
const ACTIVATE_TOOL = "workflow_activate";
const TRANSITION_TOOL = "workflow_transition";
const WORKFLOW_TOOL_NAMES = new Set([ACTIVATE_TOOL, TRANSITION_TOOL]);
const SUCCESS_RESULT = {
	content: [{ type: "text" as const, text: '{"success":true}' }],
	details: {},
};

/** Provides the contribution event used after main-agent policy replaces active tools. */
interface WorkflowEventBus {
	on(
		eventName: typeof MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		listener: () => void,
	): () => void;
}

/** Distinguishes ordinary branch reconciliation from an explicit policy reset. */
type ReconciliationTrigger = "lifecycle" | "policy-reset";

/** Supplies the mutable workflow state boundaries used by registered tools. */
interface RegisterWorkflowToolsOptions {
	readonly pi: ExtensionAPI;
	readonly prompts: WorkflowPrompts;
	readonly getCatalog: () => readonly WorkflowDefinition[];
	readonly getState: () => WorkflowState | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly setState: (state: WorkflowState) => void;
}

interface WorkflowRuntime {
	catalog: readonly WorkflowDefinition[];
	state: WorkflowState | undefined;
	usable: boolean;
	readonly selfSuppressedNames: Set<string>;
}

interface SynchronizeWorkflowRuntimeOptions {
	readonly pi: ExtensionAPI;
	readonly branch: readonly unknown[];
	readonly runtime: WorkflowRuntime;
	readonly catalogResult: Awaited<ReturnType<typeof loadWorkflowCatalog>>;
	readonly promptError: Error | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
}

/** Registers definitions before lifecycle policies and then follows their active-name decisions. */
export default async function workflowExtension(
	pi: ExtensionAPI,
): Promise<void> {
	const extensionDirectory = getSuiteExtensionDir(EXTENSION_DIRECTORY);
	const [loadedCatalog, promptResult] = await Promise.all([
		loadWorkflowCatalog(join(extensionDirectory, "workflows")),
		loadPromptsForInitialization(extensionDirectory),
	]);
	const catalogPublication = publishWorkflowCatalogPolicy(pi, {
		ids: loadedCatalog.workflows.map(({ id }) => id),
		...(loadedCatalog.error === undefined
			? {}
			: { error: loadedCatalog.error }),
	});
	const catalogResult =
		catalogPublication.error === undefined
			? loadedCatalog
			: { workflows: [], error: catalogPublication.error };
	const runtime: WorkflowRuntime = {
		catalog: catalogResult.error === undefined ? catalogResult.workflows : [],
		state: undefined,
		usable:
			promptResult.error === undefined && catalogResult.workflows.length > 0,
		selfSuppressedNames: new Set<string>(),
	};
	const getPolicy = createWorkflowPolicyReader(pi);

	if (promptResult.error === undefined) {
		registerWorkflowRuntime(pi, promptResult.prompts, runtime, getPolicy);
	}
	const synchronize = (ctx: {
		readonly sessionManager: { getBranch(): readonly unknown[] };
	}): void => {
		synchronizeWorkflowRuntime({
			pi,
			branch: ctx.sessionManager.getBranch(),
			runtime,
			catalogResult,
			promptError: promptResult.error,
			getPolicy,
		});
	};
	const unsubscribeFromAgentChanges = (
		pi.events as unknown as WorkflowEventBus
	).on(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT, () => {
		reconcileTools(
			pi,
			runtime.usable,
			runtime.selfSuppressedNames,
			"policy-reset",
		);
	});

	pi.on("session_start", (_event, ctx) => synchronize(ctx));
	pi.on("session_tree", (_event, ctx) => synchronize(ctx));
	pi.on("session_shutdown", () => unsubscribeFromAgentChanges());
}

/** Reads immutable child transport or the current canonical main-agent metadata. */
function createWorkflowPolicyReader(
	pi: ExtensionAPI,
): () => WorkflowPolicyResolution {
	const environment = readWorkflowPolicyEnvironment();
	const childPolicy =
		environment.kind === "child"
			? parseChildWorkflowPolicy(pi, environment.rawPolicy)
			: undefined;
	return () =>
		childPolicy ?? {
			kind: "resolved",
			policy:
				getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent
					?.workflows,
		};
}

/** Registers tools and one filtered context projection over shared runtime state. */
function registerWorkflowRuntime(
	pi: ExtensionAPI,
	prompts: WorkflowPrompts,
	runtime: WorkflowRuntime,
	getPolicy: () => WorkflowPolicyResolution,
): void {
	registerWorkflowPresentationRuntime(pi, runtime);
	registerWorkflowTools({
		pi,
		prompts,
		getCatalog: () => runtime.catalog,
		getState: () => runtime.state,
		getPolicy,
		setState: (state) => {
			runtime.state = state;
		},
	});
	pi.on("context", (event) => {
		const policy = getPolicy();
		if (!canProjectWorkflowContext(pi, runtime, policy)) {
			return undefined;
		}
		const catalog = runtime.catalog.filter(({ id }) =>
			isWorkflowAllowed(policy.policy, id),
		);
		const state =
			runtime.state !== undefined &&
			isWorkflowAllowed(policy.policy, runtime.state.workflow.id)
				? runtime.state
				: undefined;
		return {
			messages: projectWorkflowContext(event.messages, prompts, catalog, state),
		};
	});
}

/** Persists row-local UI evidence so live and replayed sessions render identically. */
function registerWorkflowPresentationRuntime(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
): void {
	const pending = new Map<string, WorkflowToolPresentationDetails>();
	pi.on("tool_execution_start", (event) => {
		if (!WORKFLOW_TOOL_NAMES.has(event.toolName)) {
			return;
		}
		const presentation = createWorkflowPresentationDetails(
			event.toolName,
			event.args,
			runtime.catalog,
			runtime.state,
		);
		if (presentation !== undefined) {
			pending.set(event.toolCallId, presentation);
		}
	});
	pi.on("tool_result", (event) => {
		if (!WORKFLOW_TOOL_NAMES.has(event.toolName)) {
			return undefined;
		}
		const presentation = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		return presentation === undefined ? undefined : { details: presentation };
	});
	const clearPending = (): void => pending.clear();
	pi.on("session_start", clearPending);
	pi.on("session_tree", clearPending);
	pi.on("session_shutdown", clearPending);
}

/** Checks tool eligibility and whether policy leaves any current or saved source. */
function canProjectWorkflowContext(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	policy: WorkflowPolicyResolution,
): policy is Extract<WorkflowPolicyResolution, { readonly kind: "resolved" }> {
	return (
		runtime.usable &&
		policy.kind === "resolved" &&
		hasAnyWorkflowTool(pi.getActiveTools()) &&
		hasAllowedWorkflowSource(
			policy.policy,
			runtime.catalog.map(({ id }) => id),
			runtime.state?.workflow.id,
		)
	);
}

/** Replays one branch and reconciles only suppression owned by this extension. */
function synchronizeWorkflowRuntime(
	options: SynchronizeWorkflowRuntimeOptions,
): void {
	const { pi, branch, runtime, catalogResult, promptError, getPolicy } =
		options;
	try {
		runtime.state = replayWorkflowState(branch);
	} catch (error) {
		runtime.state = undefined;
		runtime.catalog = [];
		runtime.usable = false;
		reconcileTools(pi, false, runtime.selfSuppressedNames, "lifecycle");
		throw error;
	}
	const policy = getPolicy();
	if (policy.kind === "error") {
		runtime.catalog = [];
		runtime.usable = false;
		reconcileTools(pi, false, runtime.selfSuppressedNames, "lifecycle");
		throw new Error(policy.issue);
	}
	runtime.catalog =
		catalogResult.error === undefined ? catalogResult.workflows : [];
	const hasWorkflowSource =
		runtime.state !== undefined || runtime.catalog.length > 0;
	runtime.usable = promptError === undefined && hasWorkflowSource;
	reconcileTools(pi, runtime.usable, runtime.selfSuppressedNames, "lifecycle");
	if (promptError !== undefined && hasWorkflowSource) {
		throw promptError;
	}
	if (catalogResult.error !== undefined && runtime.state === undefined) {
		throw catalogResult.error;
	}
}

/** Resolves prompt metadata atomically without falling back from configured errors. */
async function loadPromptsForInitialization(
	extensionDirectory: string,
): Promise<
	| { readonly prompts: WorkflowPrompts; readonly error?: undefined }
	| { readonly prompts?: undefined; readonly error: Error }
> {
	try {
		return {
			prompts: await loadWorkflowPrompts(
				join(extensionDirectory, "config.json"),
				join(dirname(fileURLToPath(import.meta.url)), "prompts"),
			),
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

/** Registers both sequential definitions through the package presentation registry. */
function registerWorkflowTools(options: RegisterWorkflowToolsOptions): void {
	registerWorkflowActivateTool(options);
	registerWorkflowTransitionTool(options);
}

/** Registers activation behavior and its semantic presentation. */
function registerWorkflowActivateTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, getState, getPolicy, setState } = options;
	registerPackageTool(pi, {
		name: ACTIVATE_TOOL,
		label: "Activate workflow",
		description: prompts.activateDescription,
		parameters: Type.Object(
			{ workflowId: Type.String() },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					ACTIVATE_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowActivateCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(_toolCallId, params) {
			const workflowId = readExactStringArgument(params, "workflowId");
			requireWorkflowAllowed(getPolicy(), workflowId);
			// The active workflow is excluded from activation options, so accepting it would reset progress.
			if (getState()?.workflow.id === workflowId) {
				throw new Error(
					`workflow ${workflowId} is not available for activation`,
				);
			}
			const workflow = getCatalog().find(({ id }) => id === workflowId);
			if (workflow === undefined) {
				throw new Error(
					`workflow ${workflowId} is not available for activation`,
				);
			}
			const candidate = activateWorkflow(workflow);
			pi.appendEntry(WORKFLOW_STATE_ENTRY, {
				kind: "activated",
				workflow: candidate.workflow,
				route: candidate.route,
			});
			setState(candidate);
			return SUCCESS_RESULT;
		},
	});
}

/** Registers transition behavior and its source-to-target presentation. */
function registerWorkflowTransitionTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, getState, getPolicy, setState } = options;
	registerPackageTool(pi, {
		name: TRANSITION_TOOL,
		label: "Transition workflow",
		description: prompts.transitionDescription,
		parameters: Type.Object(
			{ stageId: Type.String() },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					TRANSITION_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowTransitionCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(_toolCallId, params) {
			const stageId = readExactStringArgument(params, "stageId");
			const current = getState();
			if (current === undefined) {
				throw new Error("no workflow is active");
			}
			requireWorkflowAllowed(getPolicy(), current.workflow.id);
			const candidate = transitionWorkflow(current, stageId);
			pi.appendEntry(WORKFLOW_STATE_ENTRY, {
				kind: "transitioned",
				route: candidate.route,
			});
			setState(candidate);
			return SUCCESS_RESULT;
		},
	});
}

/** Rejects invalid or disallowed policy before any workflow state side effect. */
function requireWorkflowAllowed(
	resolution: WorkflowPolicyResolution,
	workflowId: string,
): void {
	if (resolution.kind === "error") {
		throw new Error(resolution.issue);
	}
	if (!isWorkflowAllowed(resolution.policy, workflowId)) {
		throw new Error(`workflow ${workflowId} is not allowed by agent policy`);
	}
}

/** Validates one closed tool argument object and returns its narrowed value. */
function readExactStringArgument(value: unknown, key: string): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("tool arguments must be an object");
	}
	const keys = Object.keys(value);
	const candidate = Reflect.get(value, key);
	if (
		keys.length !== 1 ||
		keys[0] !== key ||
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		candidate.trim() !== candidate
	) {
		throw new Error(
			`${key} must be the only argument and a non-empty trimmed string`,
		);
	}
	return candidate;
}

/** Reconciles workflow-owned suppression without overriding agent policy. */
function reconcileTools(
	pi: ExtensionAPI,
	usable: boolean,
	selfSuppressedNames: Set<string>,
	trigger: ReconciliationTrigger,
): void {
	const activeNames = pi.getActiveTools();
	if (usable) {
		if (trigger === "policy-reset") {
			selfSuppressedNames.clear();
			return;
		}
		const restoredNames = [...selfSuppressedNames].filter(
			(name) => !activeNames.includes(name),
		);
		selfSuppressedNames.clear();
		if (restoredNames.length > 0) {
			pi.setActiveTools([...activeNames, ...restoredNames]);
		}
		return;
	}

	const removedNames = activeNames.filter((name) =>
		WORKFLOW_TOOL_NAMES.has(name),
	);
	if (trigger === "policy-reset") {
		selfSuppressedNames.clear();
	}
	for (const name of removedNames) {
		selfSuppressedNames.add(name);
	}
	if (removedNames.length > 0) {
		pi.setActiveTools(
			activeNames.filter((name) => !WORKFLOW_TOOL_NAMES.has(name)),
		);
	}
}

/** Enables projection when the current agent can call at least one workflow tool. */
function hasAnyWorkflowTool(activeNames: readonly string[]): boolean {
	return (
		activeNames.includes(ACTIVATE_TOOL) || activeNames.includes(TRANSITION_TOOL)
	);
}
