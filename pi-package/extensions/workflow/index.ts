import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import {
	singleLineTextSchema,
	technicalIdentifierSchema,
} from "../../shared/text-contracts";
import { registerPackageTool } from "../../shared/tool-presentation/registry";
import {
	isWorkflowAllowed,
	parseChildWorkflowPolicy,
	publishWorkflowCatalogPolicy,
	toWorkflowMatchKey,
	type WorkflowPolicyResolution,
} from "../../shared/workflow-policy";
import {
	getWorkflowTriggerRunner,
	isWorkflowTriggerType,
	type WorkflowTrigger,
	type WorkflowTriggerRunner,
} from "../../shared/workflow-trigger-runtime";
import {
	resolveWorkflowAvailability,
	WORKFLOW_ACTIVATE_TOOL,
	WORKFLOW_CREATE_TOOL,
	WORKFLOW_TRANSITION_TOOL,
	type WorkflowAvailability,
	type WorkflowToolName,
} from "./availability.ts";
import {
	loadWorkflowCatalog,
	loadWorkflowPrompts,
	type WorkflowPrompts,
} from "./config";
import { projectWorkflowContext } from "./context";
import {
	isWorkflowChildProcess,
	readWorkflowPolicyEnvironment,
} from "./environment";
import {
	applyWorkflowModelSettings,
	resolveWorkflowModelSettings,
	rollbackWorkflowModelSettings,
} from "./model-runtime";
import {
	installWorkflowStatusIndicator,
	type WorkflowStatusIndicator,
} from "./status-indicator";
import {
	createWorkflowPresentationDetails,
	primeWorkflowRenderState,
	renderWorkflowActivateCall,
	renderWorkflowCreateCall,
	renderWorkflowResult,
	renderWorkflowTransitionCall,
	type WorkflowToolPresentationDetails,
} from "./tool-rendering.ts";
import {
	activateWorkflow,
	createWorkflow,
	replayWorkflowState,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	type WorkflowDefinition,
	type WorkflowState,
} from "./workflow";

const EXTENSION_DIRECTORY = "workflow";
const WORKFLOW_STATE_ENTRY = "workflow-state";
const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
	WORKFLOW_CREATE_TOOL,
	WORKFLOW_ACTIVATE_TOOL,
	WORKFLOW_TRANSITION_TOOL,
]);
const SUCCESS_RESULT = {
	content: [{ type: "text" as const, text: '{"success":true}' }],
	details: {},
};

/** Closed trigger shape exposed to Pi tool validation. */
const WORKFLOW_TRIGGER_SCHEMA = Type.Object(
	{
		type: StringEnum(
			[
				"local_knowledge_accumulation",
				"global_knowledge_accumulation",
			] as const,
			{ description: "Workflow trigger type invoked on stage entry" },
		),
	},
	{ additionalProperties: false },
);

/** Closed workflow_create stage shape exposed to Pi tool validation. */
const WORKFLOW_STAGE_SCHEMA = Type.Object(
	{
		id: technicalIdentifierSchema({
			description: "Unique stage ID referenced by transitions",
			minLength: 1,
			maxLength: 32,
		}),
		description: singleLineTextSchema({
			description: "Short single-line summary of stage outcome",
			minLength: 1,
			maxLength: 128,
		}),
		prompt: Type.String({
			description: `Instructions for this stage. Format:
\`\`\`
Goal: [Stage-specific goal]

Rules:
1. [Stage-specific instructions]
2. ...

Completion criteria:
1. [Stage-specific criteria]
2. ...
\`\`\`
`,
			minLength: 10,
			maxLength: 8192,
		}),
		triggers: Type.Optional(
			Type.Array(WORKFLOW_TRIGGER_SCHEMA, {
				description: "Ordered triggers invoked after this stage is persisted",
			}),
		),
		initial: Type.Optional(
			Type.Boolean({
				description:
					"Whether this is workflow's only initial stage. Exactly one stage must be true",
			}),
		),
		final: Type.Optional(
			Type.Boolean({
				description:
					"Whether this stage may complete workflow. At least one stage must be true",
			}),
		),
	},
	{ additionalProperties: false },
);

/** Closed workflow_create transition shape exposed to Pi tool validation. */
const WORKFLOW_TRANSITION_SCHEMA = Type.Object(
	{
		from: technicalIdentifierSchema({
			description: "Source stage ID",
			minLength: 1,
			maxLength: 32,
		}),
		to: technicalIdentifierSchema({
			description: "Target stage ID",
			minLength: 1,
			maxLength: 32,
		}),
		type: StringEnum(["advance", "rework"] as const, {
			description:
				"Transition direction: advance for forward progress; rework for return to a strict advance ancestor.",
		}),
	},
	{ additionalProperties: false },
);

/** Complete workflow_create boundary shape; graph invariants remain domain validation. */
const WORKFLOW_CREATE_SCHEMA = Type.Object(
	{
		id: singleLineTextSchema({
			description:
				"Unique workflow ID. Must not match any other workflow ID after NFC normalization",
			minLength: 6,
			maxLength: 32,
		}),
		description: singleLineTextSchema({
			description: "Single-line summary of workflow's purpose",
			minLength: 1,
			maxLength: 256,
		}),
		prompt: Type.Optional(
			Type.String({
				description:
					"Optional workflow-level instructions applied throughout all stages",
				minLength: 1,
				maxLength: 8192,
			}),
		),
		stages: Type.Array(WORKFLOW_STAGE_SCHEMA, {
			description:
				"Complete list of workflow stages. Exactly one stage must be initial and at least one must be final",
			minItems: 2,
			maxItems: 64,
		}),
		transitions: Type.Array(WORKFLOW_TRANSITION_SCHEMA, {
			description:
				"Directed stage transitions. Use advance for forward progress and rework only toward an advance ancestor",
			minItems: 1,
			maxItems: 256,
		}),
	},
	{ additionalProperties: false },
);

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
	readonly runtime: WorkflowRuntime;
	readonly getCatalog: () => readonly WorkflowDefinition[];
	readonly getCatalogError: () => Error | undefined;
	readonly getState: () => WorkflowState | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly resolveAvailability: () => WorkflowAvailability;
	readonly setState: (state: WorkflowState) => void;
}

interface WorkflowRuntime {
	catalog: readonly WorkflowDefinition[];
	catalogError: Error | undefined;
	promptError: Error | undefined;
	state: WorkflowState | undefined;
	currentModel: ExtensionContext["model"];
	modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	readonly selfSuppressedNames: Set<string>;
}

/** Groups runtime registration dependencies without widening the tool boundary. */
interface RegisterWorkflowRuntimeOptions {
	readonly pi: ExtensionAPI;
	readonly prompts: WorkflowPrompts;
	readonly runtime: WorkflowRuntime;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly refreshTools: (trigger: ReconciliationTrigger) => void;
}

interface TriggerInvocation {
	readonly ctx: ExtensionContext;
	readonly signal: AbortSignal | undefined;
}

interface SynchronizeWorkflowRuntimeOptions {
	readonly pi: ExtensionAPI;
	readonly branch: readonly unknown[];
	readonly runtime: WorkflowRuntime;
	readonly catalogResult: Awaited<ReturnType<typeof loadWorkflowCatalog>>;
	readonly promptError: Error | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly model: ExtensionContext["model"];
	readonly modelRegistry: ExtensionContext["modelRegistry"];
}

/** Owns the TUI status indicator while lifecycle handlers are registered. */
interface WorkflowStatusHolder {
	indicator: WorkflowStatusIndicator | undefined;
}

/** Groups lifecycle synchronization dependencies without widening the Pi event handlers. */
interface WorkflowLifecycleOptions {
	readonly pi: ExtensionAPI;
	readonly runtime: WorkflowRuntime;
	readonly catalogResult: Awaited<ReturnType<typeof loadWorkflowCatalog>>;
	readonly promptError: Error | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly refreshTools: (trigger: ReconciliationTrigger) => void;
	readonly statusHolder: WorkflowStatusHolder;
	readonly warnings: readonly Error[] | undefined;
}

/** Runs the entered stage's triggers sequentially without changing workflow success. */
async function runEnteredStageTriggers(
	pi: ExtensionAPI,
	state: WorkflowState,
	invocation: TriggerInvocation,
): Promise<void> {
	const activeStageId = state.route.at(-1);
	const stage = state.workflow.stages.find(({ id }) => id === activeStageId);
	if (stage === undefined || stage.triggers.length === 0) {
		return;
	}
	const runner = getWorkflowTriggerRunner(pi);
	if (runner !== undefined) {
		await runTriggerAt(runner, stage.triggers, 0, invocation);
	}
}

/** Advances through the ordered trigger list until completion or the first failure. */
async function runTriggerAt(
	runner: WorkflowTriggerRunner,
	triggers: readonly WorkflowTrigger[],
	index: number,
	invocation: TriggerInvocation,
): Promise<void> {
	const trigger = triggers[index];
	if (trigger === undefined) {
		return;
	}
	try {
		const result = await runner.run(trigger, invocation.ctx, invocation.signal);
		if (result.ok) {
			await runTriggerAt(runner, triggers, index + 1, invocation);
		}
	} catch {
		// Runner failures are isolated from the persisted workflow operation.
	}
}

/** Updates active memory before awaiting the entered stage's triggers. */
async function setEnteredWorkflowState(
	pi: ExtensionAPI,
	setState: (state: WorkflowState) => void,
	state: WorkflowState,
	invocation: TriggerInvocation,
): Promise<void> {
	setState(state);
	await runEnteredStageTriggers(pi, state, invocation);
}

/** Creates the initial mutable workflow state from catalog-wide and prompt loading results. */
function createWorkflowRuntimeState(
	catalogResult: Awaited<ReturnType<typeof loadWorkflowCatalog>>,
	promptError: Error | undefined,
): WorkflowRuntime {
	return {
		catalog: catalogResult.error === undefined ? catalogResult.workflows : [],
		catalogError: catalogResult.error,
		promptError,
		state: undefined,
		currentModel: undefined,
		modelRegistry: undefined,
		selfSuppressedNames: new Set<string>(),
	};
}

/** Publishes saved session state independently from the selected agent's workflow policy. */
function publishWorkflowStatus(
	indicator: WorkflowStatusIndicator | undefined,
	runtime: WorkflowRuntime,
): void {
	indicator?.publish(runtime.state);
}

/** Reports all skipped catalog workflows in one startup notification. */
function reportWorkflowCatalogWarnings(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	warnings: readonly Error[] | undefined,
): void {
	if (warnings === undefined || warnings.length === 0 || ctx.hasUI === false) {
		return;
	}

	const details = warnings.map(({ message }) => `- ${message}`).join("\n");
	ctx.ui.notify(
		`[workflow] disabled invalid catalog workflows:\n${details}`,
		"warning",
	);
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
	const runtime = createWorkflowRuntimeState(catalogResult, promptResult.error);
	const statusHolder: WorkflowStatusHolder = { indicator: undefined };
	const getPolicy = createWorkflowPolicyReader(pi);
	const refreshTools = (trigger: ReconciliationTrigger): void => {
		const availability = resolveRuntimeAvailability(runtime, getPolicy());
		reconcileTools(
			pi,
			availability.availableToolNames,
			runtime.selfSuppressedNames,
			trigger,
		);
		publishWorkflowStatus(statusHolder.indicator, runtime);
	};

	if (promptResult.error === undefined) {
		registerWorkflowRuntime({
			pi,
			prompts: promptResult.prompts,
			runtime,
			getPolicy,
			refreshTools,
		});
	}
	registerWorkflowLifecycle({
		pi,
		runtime,
		catalogResult,
		promptError: promptResult.error,
		getPolicy,
		refreshTools,
		statusHolder,
		warnings: loadedCatalog.warnings,
	});

	pi.registerFlag("trigger", {
		description: "Run a workflow trigger at startup and exit",
		type: "string",
	});
}

/**
 * Checks the --trigger CLI flag and executes the requested trigger if set.
 * Returns true when the flag was handled (trigger executed or error reported),
 * signaling the caller to skip normal session initialization.
 */
async function handleCliTriggerIfRequested(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (isWorkflowChildProcess()) {
		return false;
	}
	const triggerFlag = pi.getFlag("trigger");
	if (typeof triggerFlag !== "string") {
		return false;
	}
	if (!isWorkflowTriggerType(triggerFlag)) {
		process.stderr.write(`unknown trigger type: ${triggerFlag}\n`);
		ctx.shutdown();
		return true;
	}
	const runner = getWorkflowTriggerRunner(pi);
	if (runner === undefined) {
		process.stderr.write("trigger runner not registered\n");
		ctx.shutdown();
		return true;
	}
	process.stderr.write(`[trigger] running ${triggerFlag}...\n`);
	await runner.run({ type: triggerFlag }, ctx, undefined);
	process.stderr.write(`[trigger] ${triggerFlag} completed\n`);
	ctx.shutdown();
	return true;
}

/** Registers session and model lifecycle synchronization without reapplying manual model changes. */
function registerWorkflowLifecycle(options: WorkflowLifecycleOptions): void {
	const {
		pi,
		runtime,
		catalogResult,
		promptError,
		getPolicy,
		refreshTools,
		statusHolder,
		warnings,
	} = options;
	const synchronize = async (ctx: {
		readonly mode: ExtensionContext["mode"];
		readonly ui: ExtensionContext["ui"];
		readonly model: ExtensionContext["model"];
		readonly modelRegistry: ExtensionContext["modelRegistry"];
		readonly sessionManager: { getBranch(): readonly unknown[] };
	}): Promise<void> => {
		if (ctx.mode === "tui") {
			statusHolder.indicator ??= installWorkflowStatusIndicator(pi, ctx.ui);
		}
		try {
			synchronizeWorkflowRuntime({
				pi,
				branch: ctx.sessionManager.getBranch(),
				runtime,
				catalogResult,
				promptError,
				getPolicy,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
			});
			await synchronizeWorkflowModelRuntime(pi, runtime);
		} finally {
			publishWorkflowStatus(statusHolder.indicator, runtime);
		}
	};
	pi.on("model_select", (event) => {
		runtime.currentModel = event.model;
	});
	const unsubscribeFromAgentChanges = (
		pi.events as unknown as WorkflowEventBus
	).on(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT, () => {
		refreshTools("policy-reset");
	});
	pi.on("session_start", async (_event, ctx) => {
		if (await handleCliTriggerIfRequested(pi, ctx)) {
			return;
		}
		await synchronize(ctx);
		reportWorkflowCatalogWarnings(ctx, warnings);
	});
	pi.on("session_tree", async (_event, ctx) => synchronize(ctx));
	pi.on("session_shutdown", () => {
		unsubscribeFromAgentChanges();
		statusHolder.indicator?.dispose();
		statusHolder.indicator = undefined;
	});
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
	options: RegisterWorkflowRuntimeOptions,
): void {
	const { pi, prompts, runtime, getPolicy, refreshTools } = options;
	registerWorkflowPresentationRuntime(pi, runtime);
	const resolveAvailability = (): WorkflowAvailability =>
		resolveRuntimeAvailability(runtime, getPolicy());
	registerWorkflowTools({
		pi,
		prompts,
		runtime,
		getCatalog: () => runtime.catalog,
		getCatalogError: () => runtime.catalogError,
		getState: () => runtime.state,
		getPolicy,
		resolveAvailability,
		setState: (state) => {
			runtime.state = state;
			refreshTools("lifecycle");
		},
	});
	pi.on("context", (event) => {
		const activeNames = pi.getActiveTools();
		const availability = resolveAvailability();
		// Suppression preserves a tool permission only while an active state remains projectable.
		const hasSuppressedWorkflowPermission =
			availability.projectedState !== undefined &&
			hasAnyWorkflowTool([...runtime.selfSuppressedNames]);
		if (!hasAnyWorkflowTool(activeNames) && !hasSuppressedWorkflowPermission) {
			return undefined;
		}
		const activationOptions = activeNames.includes(WORKFLOW_ACTIVATE_TOOL)
			? availability.activationOptions
			: [];
		return {
			messages: projectWorkflowContext(
				event.messages,
				prompts,
				activationOptions,
				availability.projectedState,
			),
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

/** Resolves the current system capabilities without mutating Pi active tools. */
function resolveRuntimeAvailability(
	runtime: WorkflowRuntime,
	policy: WorkflowPolicyResolution,
): WorkflowAvailability {
	// Prompt loading is atomic, so one prompt error disables every registered capability.
	if (runtime.promptError !== undefined) {
		return {
			activationOptions: [],
			projectedState: undefined,
			availableToolNames: new Set(),
		};
	}
	return resolveWorkflowAvailability({
		catalog: runtime.catalog,
		catalogValid: runtime.catalogError === undefined,
		policy,
		state: runtime.state,
	});
}

/** Replays one branch and reconciles only suppression owned by this extension. */
function synchronizeWorkflowRuntime(
	options: SynchronizeWorkflowRuntimeOptions,
): void {
	const {
		pi,
		branch,
		runtime,
		catalogResult,
		promptError,
		getPolicy,
		model,
		modelRegistry,
	} = options;
	runtime.currentModel = model;
	runtime.modelRegistry = modelRegistry;
	try {
		runtime.state = replayWorkflowState(branch);
	} catch (error) {
		runtime.state = undefined;
		runtime.catalog = [];
		runtime.catalogError =
			error instanceof Error ? error : new Error(String(error));
		reconcileTools(pi, new Set(), runtime.selfSuppressedNames, "lifecycle");
		throw error;
	}
	runtime.catalog =
		catalogResult.error === undefined ? catalogResult.workflows : [];
	runtime.catalogError = catalogResult.error;
	runtime.promptError = promptError;
	const policy = getPolicy();
	const availability = resolveRuntimeAvailability(runtime, policy);
	reconcileTools(
		pi,
		availability.availableToolNames,
		runtime.selfSuppressedNames,
		"lifecycle",
	);
	if (policy.kind === "error") {
		throw new Error(policy.issue);
	}
	if (
		promptError !== undefined &&
		(catalogResult.error === undefined || runtime.state !== undefined)
	) {
		throw promptError;
	}
	if (catalogResult.error !== undefined && runtime.state === undefined) {
		throw catalogResult.error;
	}
}

/** Applies settings for the restored active stage without changing workflow state. */
async function synchronizeWorkflowModelRuntime(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
): Promise<void> {
	const state = runtime.state;
	const stageId = state?.route.at(-1);
	if (state === undefined || stageId === undefined) {
		return;
	}
	const resolution = resolveWorkflowModelSettings(
		state.workflow,
		stageId,
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.model,
		pi.getThinkingLevel(),
	);
	const application = await applyWorkflowModelSettings(
		pi,
		runtime.modelRegistry,
		runtime.currentModel,
		resolution,
	);
	runtime.currentModel = application.currentModel;
}

/** Applies runtime settings and persists one activation or transition atomically. */
async function commitWorkflowStateChange(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	candidate: WorkflowState,
	data: Record<string, unknown>,
): Promise<void> {
	const stageId = candidate.route.at(-1);
	if (stageId === undefined) {
		throw new Error("workflow candidate has no active stage");
	}
	const resolution = resolveWorkflowModelSettings(
		candidate.workflow,
		stageId,
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.model,
		pi.getThinkingLevel(),
	);
	const application = await applyWorkflowModelSettings(
		pi,
		runtime.modelRegistry,
		runtime.currentModel,
		resolution,
	);
	runtime.currentModel = application.currentModel;
	try {
		pi.appendEntry(WORKFLOW_STATE_ENTRY, data);
	} catch (error) {
		try {
			await rollbackWorkflowModelSettings(pi, application);
			runtime.currentModel = application.previousModel;
		} catch (rollbackError) {
			throw new Error(
				`${formatError(error)}; previous model could not be restored: ${formatError(rollbackError)}`,
			);
		}
		throw error;
	}
}

/** Converts unknown failures into stable operation messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

/** Registers all sequential definitions through the package presentation registry. */
function registerWorkflowTools(options: RegisterWorkflowToolsOptions): void {
	registerWorkflowActivateTool(options);
	registerWorkflowTransitionTool(options);
	registerWorkflowCreateTool(options);
}

/** Registers dynamic creation as one validated, persisted, and activated operation. */
function registerWorkflowCreateTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const {
		pi,
		prompts,
		getCatalog,
		getCatalogError,
		getState,
		getPolicy,
		resolveAvailability,
		setState,
	} = options;
	registerPackageTool(pi, {
		name: WORKFLOW_CREATE_TOOL,
		label: "Create workflow",
		description: prompts.createDescription,
		parameters: WORKFLOW_CREATE_SCHEMA,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_CREATE_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowCreateCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			const workflow = validateCreatedWorkflowDefinition(
				params,
				WORKFLOW_CREATE_TOOL,
			);
			const policy = getPolicy();
			if (policy.kind === "error") {
				throw new Error(policy.issue);
			}
			if (!resolveAvailability().availableToolNames.has(WORKFLOW_CREATE_TOOL)) {
				throw (
					getCatalogError() ?? new Error("workflow creation is unavailable")
				);
			}
			const workflowKey = toWorkflowMatchKey(workflow.id);
			const catalogMatch = getCatalog().find(
				({ id }) => toWorkflowMatchKey(id) === workflowKey,
			);
			if (catalogMatch !== undefined) {
				throw new Error(
					`workflow ${workflow.id} conflicts with catalog workflow ${catalogMatch.id}`,
				);
			}
			const current = getState();
			if (
				current?.source === "dynamic" &&
				toWorkflowMatchKey(current.workflow.id) === workflowKey
			) {
				throw new Error(`workflow ${workflow.id} is already active`);
			}
			const candidate = createWorkflow(workflow);
			pi.appendEntry(WORKFLOW_STATE_ENTRY, {
				kind: "created",
				workflow: candidate.workflow,
				route: candidate.route,
			});
			await setEnteredWorkflowState(pi, setState, candidate, { ctx, signal });
			return SUCCESS_RESULT;
		},
	});
}

/** Registers activation behavior and its semantic presentation. */
function registerWorkflowActivateTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const {
		pi,
		prompts,
		runtime,
		getCatalog,
		getState,
		getPolicy,
		resolveAvailability,
		setState,
	} = options;
	registerPackageTool(pi, {
		name: WORKFLOW_ACTIVATE_TOOL,
		label: "Activate workflow",
		description: prompts.activateDescription,
		parameters: Type.Object(
			{
				workflowId: singleLineTextSchema({
					description: "ID of workflow listed in <workflow_activation_options>",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_ACTIVATE_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowActivateCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			const workflowId = readExactStringArgument(params, "workflowId");
			requireWorkflowAllowed(getPolicy(), workflowId);
			// Availability excludes the active workflow and every policy-denied catalog entry.
			const workflow = resolveAvailability().activationOptions.find(
				({ id }) => id === workflowId,
			);
			if (workflow === undefined) {
				throw new Error(
					`workflow ${workflowId} is not available for activation`,
				);
			}
			const candidate = activateWorkflow(workflow);
			await commitWorkflowStateChange(pi, runtime, candidate, {
				kind: "activated",
				workflow: candidate.workflow,
				route: candidate.route,
			});
			await setEnteredWorkflowState(pi, setState, candidate, { ctx, signal });
			return SUCCESS_RESULT;
		},
	});
}

/** Registers transition behavior and its source-to-target presentation. */
function registerWorkflowTransitionTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const {
		pi,
		prompts,
		runtime,
		getCatalog,
		getState,
		getPolicy,
		resolveAvailability,
		setState,
	} = options;
	registerPackageTool(pi, {
		name: WORKFLOW_TRANSITION_TOOL,
		label: "Transition workflow",
		description: prompts.transitionDescription,
		parameters: Type.Object(
			{
				stageId: technicalIdentifierSchema({
					description: "Target stage ID listed in <available_transitions>",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_TRANSITION_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowTransitionCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			const stageId = readExactStringArgument(params, "stageId");
			const current = getState();
			if (current === undefined) {
				throw new Error("no workflow is active");
			}
			const policy = getPolicy();
			if (policy.kind === "error") {
				throw new Error(policy.issue);
			}
			if (resolveAvailability().projectedState !== current) {
				throw new Error(`workflow ${current.workflow.id} is not available`);
			}
			const candidate = transitionWorkflow(current, stageId);
			await commitWorkflowStateChange(pi, runtime, candidate, {
				kind: "transitioned",
				route: candidate.route,
			});
			await setEnteredWorkflowState(pi, setState, candidate, { ctx, signal });
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
	availableToolNames: ReadonlySet<WorkflowToolName>,
	selfSuppressedNames: Set<string>,
	trigger: ReconciliationTrigger,
): void {
	const activeNames = pi.getActiveTools();
	// A policy reset replaces the agent-owned tool set, so prior suppression ownership is stale.
	if (trigger === "policy-reset") {
		selfSuppressedNames.clear();
	}

	// The extension records only names it removes for current system availability.
	const removedNames = activeNames
		.filter(isWorkflowToolName)
		.filter((name) => !availableToolNames.has(name));
	for (const name of removedNames) {
		selfSuppressedNames.add(name);
	}

	// Ordinary lifecycle changes may restore only names previously removed by this extension.
	const restoredNames =
		trigger === "lifecycle"
			? [...selfSuppressedNames]
					.filter(isWorkflowToolName)
					.filter(
						(name) =>
							availableToolNames.has(name) && !activeNames.includes(name),
					)
			: [];
	for (const name of restoredNames) {
		selfSuppressedNames.delete(name);
	}

	const removedNameSet: ReadonlySet<string> = new Set(removedNames);
	const nextNames = [
		...activeNames.filter((name) => !removedNameSet.has(name)),
		...restoredNames,
	];
	if (removedNames.length > 0 || restoredNames.length > 0) {
		pi.setActiveTools(nextNames);
	}
}

/** Narrows arbitrary Pi tool names to the workflow-owned finite set. */
function isWorkflowToolName(name: string): name is WorkflowToolName {
	return WORKFLOW_TOOL_NAMES.has(name);
}

/** Enables projection when the current agent can call at least one workflow tool. */
function hasAnyWorkflowTool(activeNames: readonly string[]): boolean {
	return activeNames.some(isWorkflowToolName);
}
