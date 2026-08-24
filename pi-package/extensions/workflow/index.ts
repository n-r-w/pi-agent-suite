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
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";
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
	type WorkflowTrigger,
	type WorkflowTriggerRunner,
} from "../../shared/workflow-trigger-runtime";
import {
	resolveWorkflowAvailability,
	WORKFLOW_ACTIVATE_TOOL,
	WORKFLOW_CREATE_TOOL,
	WORKFLOW_EDIT_STAGE_TOOL,
	WORKFLOW_GET_STAGE_TOOL,
	WORKFLOW_TRANSITION_TOOL,
	type WorkflowAvailability,
	type WorkflowToolName,
} from "./availability.ts";
import {
	loadWorkflowCatalog,
	loadWorkflowConfiguration,
	type WorkflowConfiguration,
	type WorkflowPrompts,
} from "./config";
import { WorkflowJournal } from "./context";
import { readWorkflowPolicyEnvironment } from "./environment";
import {
	applyWorkflowModelRestoration,
	applyWorkflowModelSettings,
	captureWorkflowModelRestoration,
	resolveWorkflowModelSettings,
	rollbackWorkflowModelSettings,
} from "./model-runtime";
import { WorkflowReminderScheduler } from "./reminder-scheduler";
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
	renderWorkflowStageCall,
	renderWorkflowTransitionCall,
	type WorkflowToolPresentationDetails,
} from "./tool-rendering.ts";
import {
	activateWorkflow,
	completeWorkflow,
	createWorkflow,
	editWorkflowStage,
	replayWorkflowStateWithWarnings,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	WORKFLOW_STATE_JOURNAL_VERSION,
	type WorkflowDefinition,
	type WorkflowRestorationSettings,
	type WorkflowState,
	withWorkflowRestoration,
} from "./workflow";

const EXTENSION_DIRECTORY = "workflow";
const WORKFLOW_STATE_ENTRY = "workflow-state";
const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
	WORKFLOW_CREATE_TOOL,
	WORKFLOW_ACTIVATE_TOOL,
	WORKFLOW_GET_STAGE_TOOL,
	WORKFLOW_EDIT_STAGE_TOOL,
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

/** Closed thinking-only model shape exposed to workflow_create validation. */
const WORKFLOW_CREATE_MODEL_SCHEMA = Type.Object(
	{
		thinking: StringEnum(["low", "medium", "high"] as const, {
			description: "Thinking level applied while this workflow scope is active",
		}),
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
Goal: [Describes resulting state to achieve. NOT rules, actions or completion criteria]

Rules:
1. [Instruction]
2. ...

Actions:
1. [Action]
2. ...

Subagents:
1. [Optional subagents rules]
2. ...

Rework rules:
1. [Optional rework rules]

Completion criteria:
1. [Criterion]
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
		model: WORKFLOW_CREATE_MODEL_SCHEMA,
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

/** Closed thinking-only model shape exposed to workflow_edit_stage validation. */
const WORKFLOW_EDIT_STAGE_MODEL_SCHEMA = Type.Object(
	{
		thinking: StringEnum(REASONING_LEVELS, {
			description: "Thinking level applied when this stage is active",
		}),
	},
	{ additionalProperties: false },
);

/** Closed workflow_edit_stage boundary without immutable stage fields. */
const WORKFLOW_EDIT_STAGE_SCHEMA = Type.Object(
	{
		stageId: technicalIdentifierSchema({
			description: "Existing stage ID in current active workflow",
			minLength: 1,
			maxLength: 32,
		}),
		description: singleLineTextSchema({
			description: "Replacement short single-line summary of stage outcome",
			minLength: 1,
			maxLength: 128,
		}),
		prompt: Type.String({
			description: "Replacement instructions for this stage",
			minLength: 10,
			maxLength: 8192,
		}),
		model: WORKFLOW_EDIT_STAGE_MODEL_SCHEMA,
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
	configurationError: Error | undefined;
	state: WorkflowState | undefined;
	replayWarnings: readonly string[];
	currentModel: ExtensionContext["model"];
	modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	lastTurnFailed: boolean;
	readonly selfSuppressedNames: Set<string>;
	readonly journal: WorkflowJournal;
	readonly reminderScheduler: WorkflowReminderScheduler;
	journalReady: boolean;
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
	readonly configurationError: Error | undefined;
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
	readonly configurationError: Error | undefined;
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

/** Creates the initial mutable workflow state from catalog-wide and configuration loading results. */
function createWorkflowRuntimeState(
	pi: ExtensionAPI,
	catalogResult: Awaited<ReturnType<typeof loadWorkflowCatalog>>,
	configurationError: Error | undefined,
	reminderToolCallInterval: number,
): WorkflowRuntime {
	const reminderScheduler = new WorkflowReminderScheduler(
		reminderToolCallInterval,
	);
	return {
		catalog: catalogResult.error === undefined ? catalogResult.workflows : [],
		catalogError: catalogResult.error,
		configurationError,
		state: undefined,
		replayWarnings: [],
		currentModel: undefined,
		modelRegistry: undefined,
		lastTurnFailed: false,
		selfSuppressedNames: new Set<string>(),
		journal: new WorkflowJournal((record, delivery) => {
			pi.sendMessage(record, { deliverAs: delivery });
			if (recordCarriesCurrentWorkflowState(record.details)) {
				reminderScheduler.workflowStatePublished();
			}
		}),
		reminderScheduler,
		journalReady: false,
	};
}

/** Identifies records that start a fresh reminder interval. */
function recordCarriesCurrentWorkflowState(
	details: Readonly<Record<string, unknown>>,
): boolean {
	const kind = details["kind"];
	return (
		kind === "activation" ||
		kind === "stage_activation" ||
		kind === "checkpoint" ||
		kind === "reminder" ||
		(kind === "stage_update" && details["active"] === true)
	);
}

/** Publishes saved session state independently from the selected agent's workflow policy. */
function publishWorkflowStatus(
	indicator: WorkflowStatusIndicator | undefined,
	runtime: WorkflowRuntime,
): void {
	indicator?.publish(runtime.state);
}

/** Publishes the current model-visible catalog subset after active-tool reconciliation. */
function publishWorkflowActivationOptions(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	availability: WorkflowAvailability,
): void {
	const options = pi.getActiveTools().includes(WORKFLOW_ACTIVATE_TOOL)
		? availability.activationOptions
		: [];
	runtime.journal.activationOptions(options);
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

/** Reports ignored legacy workflow state through the available session output. */
function reportWorkflowStateWarnings(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	warnings: readonly string[],
): void {
	if (warnings.length === 0) {
		return;
	}
	const message = warnings.join("\n");
	if (ctx.hasUI) {
		ctx.ui.notify(message, "warning");
		return;
	}
	process.stderr.write(`${message}\n`);
}

/** Reports each replay warning once until the synchronized branch changes. */
function reportReplayWarningsOnce(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	warnings: readonly string[],
	reportedWarningKey: string | undefined,
): string | undefined {
	const warningKey = warnings.join("\n");
	if (warningKey.length === 0) {
		return undefined;
	}
	if (warningKey === reportedWarningKey) {
		return reportedWarningKey;
	}
	reportWorkflowStateWarnings(ctx, warnings);
	return warningKey;
}

/** Registers definitions before lifecycle policies and then follows their active-name decisions. */
export default async function workflowExtension(
	pi: ExtensionAPI,
): Promise<void> {
	const extensionDirectory = getSuiteExtensionDir(EXTENSION_DIRECTORY);
	const [loadedCatalog, configurationResult] = await Promise.all([
		loadWorkflowCatalog(join(extensionDirectory, "workflows")),
		loadConfigurationForInitialization(extensionDirectory),
	]);
	const catalogPublication = publishWorkflowCatalogPolicy({
		ids: loadedCatalog.workflows.map(({ id }) => id),
		...(loadedCatalog.error === undefined
			? {}
			: { error: loadedCatalog.error }),
	});
	const catalogResult =
		catalogPublication.error === undefined
			? loadedCatalog
			: { workflows: [], error: catalogPublication.error };
	const runtime = createWorkflowRuntimeState(
		pi,
		catalogResult,
		configurationResult.error,
		configurationResult.configuration?.reminderToolCallInterval ?? 0,
	);
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
		if (runtime.journalReady) {
			publishWorkflowActivationOptions(pi, runtime, availability);
		}
	};

	if (configurationResult.error === undefined) {
		registerWorkflowRuntime({
			pi,
			prompts: configurationResult.configuration,
			runtime,
			getPolicy,
			refreshTools,
		});
	}
	registerWorkflowLifecycle({
		pi,
		runtime,
		catalogResult,
		configurationError: configurationResult.error,
		getPolicy,
		refreshTools,
		statusHolder,
		warnings: loadedCatalog.warnings,
	});
}

/** Completes a final-stage workflow after Pi reports the agent run as settled. */
async function completeSettledWorkflow(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	refreshTools: (trigger: ReconciliationTrigger) => void,
): Promise<void> {
	const state = runtime.state;
	const activeStageId = state?.route.at(-1);
	if (
		state === undefined ||
		state.status === "completed" ||
		activeStageId === undefined
	) {
		return;
	}
	const activeStage = state.workflow.stages.find(
		({ id }) => id === activeStageId,
	);
	if (activeStage === undefined || !activeStage.final) {
		return;
	}
	let restorationApplication:
		| Awaited<ReturnType<typeof applyWorkflowModelRestoration>>
		| undefined;
	if (state.restoration !== undefined) {
		restorationApplication = await applyWorkflowModelRestoration(
			pi,
			runtime.modelRegistry,
			runtime.currentModel,
			state.restoration,
		);
		runtime.currentModel = restorationApplication.currentModel;
	}
	try {
		pi.appendEntry(WORKFLOW_STATE_ENTRY, {
			kind: "completed",
			route: state.route,
		});
	} catch (error) {
		if (restorationApplication !== undefined) {
			try {
				await rollbackWorkflowModelSettings(pi, restorationApplication);
				runtime.currentModel = restorationApplication.previousModel;
			} catch (rollbackError) {
				throw new Error(
					`${formatError(error)}; final-stage model could not be restored: ${formatError(rollbackError)}`,
				);
			}
		}
		throw error;
	}
	const completed = completeWorkflow(state);
	runtime.journal.complete(completed);
	runtime.state = completed;
	refreshTools("lifecycle");
}

/** Registers session and model lifecycle synchronization without reapplying manual model changes. */
function registerWorkflowLifecycle(options: WorkflowLifecycleOptions): void {
	const { pi, runtime, getPolicy, refreshTools, statusHolder, warnings } =
		options;
	let reportedReplayWarningKey: string | undefined;
	const synchronize = createWorkflowSynchronizer(options);
	registerWorkflowRunLifecycle(pi, runtime, refreshTools);
	registerWorkflowCompaction(pi, runtime, getPolicy);
	const unsubscribeFromAgentChanges = (
		pi.events as unknown as WorkflowEventBus
	).on(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT, () => {
		refreshTools("policy-reset");
	});
	pi.on("session_start", async (_event, ctx) => {
		runtime.reminderScheduler.reset();
		await synchronize(ctx);
		reportWorkflowCatalogWarnings(ctx, warnings);
		reportedReplayWarningKey = reportReplayWarningsOnce(
			ctx,
			runtime.replayWarnings,
			reportedReplayWarningKey,
		);
	});
	pi.on("session_tree", async (_event, ctx) => {
		runtime.reminderScheduler.reset();
		await synchronize(ctx);
		reportedReplayWarningKey = reportReplayWarningsOnce(
			ctx,
			runtime.replayWarnings,
			reportedReplayWarningKey,
		);
	});
	pi.on("session_shutdown", () => {
		unsubscribeFromAgentChanges();
		statusHolder.indicator?.dispose();
		statusHolder.indicator = undefined;
	});
}

interface WorkflowSynchronizationContext {
	readonly mode: ExtensionContext["mode"];
	readonly ui: ExtensionContext["ui"];
	readonly model: ExtensionContext["model"];
	readonly modelRegistry: ExtensionContext["modelRegistry"];
	readonly sessionManager: { getBranch(): readonly unknown[] };
}

/** Creates the shared session-start and branch-navigation synchronization operation. */
function createWorkflowSynchronizer(
	options: WorkflowLifecycleOptions,
): (ctx: WorkflowSynchronizationContext) => Promise<void> {
	const {
		pi,
		runtime,
		catalogResult,
		configurationError,
		getPolicy,
		statusHolder,
	} = options;
	return async (ctx) => {
		if (ctx.mode === "tui") {
			statusHolder.indicator ??= installWorkflowStatusIndicator(pi, ctx.ui);
		}
		try {
			const branch = ctx.sessionManager.getBranch();
			const previousState = runtime.state;
			runtime.journalReady = false;
			synchronizeWorkflowRuntime({
				pi,
				branch,
				runtime,
				catalogResult,
				configurationError,
				getPolicy,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
			});
			await synchronizeWorkflowModelRuntime(pi, runtime, branch, previousState);
			runtime.journal.restore(branch);
			if (
				runtime.state !== undefined &&
				!runtime.journal.isCurrent(runtime.state)
			) {
				runtime.journal.checkpoint(runtime.state);
			}
			runtime.journalReady = true;
			publishWorkflowActivationOptions(
				pi,
				runtime,
				resolveRuntimeAvailability(runtime, getPolicy()),
			);
		} finally {
			publishWorkflowStatus(statusHolder.indicator, runtime);
		}
	};
}

/** Registers model selection and final-stage settlement handlers. */
function registerWorkflowRunLifecycle(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	refreshTools: (trigger: ReconciliationTrigger) => void,
): void {
	pi.on("model_select", (event) => {
		runtime.currentModel = event.model;
	});
	pi.on("agent_settled", async () => {
		const settledRunFailed = runtime.lastTurnFailed;
		runtime.lastTurnFailed = false;
		if (!settledRunFailed) {
			await completeSettledWorkflow(pi, runtime, refreshTools);
		}
	});
}

/** Registers the post-compaction workflow checkpoint. */
function registerWorkflowCompaction(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	getPolicy: () => WorkflowPolicyResolution,
): void {
	pi.on("session_compact", () => {
		runtime.journal.startContextSegment();
		if (runtime.state !== undefined) {
			runtime.journal.checkpoint(runtime.state);
		}
		publishWorkflowActivationOptions(
			pi,
			runtime,
			resolveRuntimeAvailability(runtime, getPolicy()),
		);
	});
}

/** Reads immutable child transport or the current canonical main-agent metadata. */
function createWorkflowPolicyReader(
	pi: ExtensionAPI,
): () => WorkflowPolicyResolution {
	const environment = readWorkflowPolicyEnvironment();
	const childPolicy =
		environment.kind === "child"
			? parseChildWorkflowPolicy(environment.rawPolicy)
			: undefined;
	return () =>
		childPolicy ?? {
			kind: "resolved",
			policy:
				getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent
					?.workflows,
		};
}

/** Registers workflow tools over shared runtime state. */
function registerWorkflowRuntime(
	options: RegisterWorkflowRuntimeOptions,
): void {
	const { pi, prompts, runtime, getPolicy, refreshTools } = options;
	registerWorkflowPresentationRuntime(pi, runtime);
	registerWorkflowReminderRuntime(pi, runtime);
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
	getAgentRuntimeComposition(pi).publishBaselineToolNames([
		...WORKFLOW_TOOL_NAMES,
	]);
}

/** Schedules at most one reminder after each complete tool batch. */
function registerWorkflowReminderRuntime(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
): void {
	let finalizedToolResultCount = 0;
	let terminatingToolResultCount = 0;
	pi.on("turn_start", () => {
		finalizedToolResultCount = 0;
		terminatingToolResultCount = 0;
		runtime.reminderScheduler.startTurn();
	});
	pi.on("tool_execution_end", (event) => {
		finalizedToolResultCount++;
		if (event.result?.terminate === true) {
			terminatingToolResultCount++;
		}
	});
	pi.on("turn_end", (event) => {
		runtime.lastTurnFailed =
			event.message.role === "assistant" &&
			(event.message.stopReason === "aborted" ||
				event.message.stopReason === "error");
		const state = runtime.state;
		const toolResultCount = event.toolResults.length;
		const hasReasoning =
			event.message.role === "assistant" &&
			event.message.content.some(
				(block) =>
					block.type === "thinking" &&
					(block.thinking.trim() !== "" ||
						(block.thinkingSignature !== undefined &&
							block.thinkingSignature.trim() !== "") ||
						block.redacted === true),
			);
		const allToolResultsTerminate =
			toolResultCount > 0 &&
			finalizedToolResultCount === toolResultCount &&
			terminatingToolResultCount === toolResultCount;
		if (
			runtime.reminderScheduler.completeTurn(
				toolResultCount,
				hasReasoning,
				state?.status === "active",
				allToolResultsTerminate,
			) &&
			state !== undefined
		) {
			runtime.journal.reminder(
				state,
				toolResultCount === 0 ? "nextTurn" : "steer",
			);
		}
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
	// Configuration loading is atomic, so one error disables every registered capability.
	if (runtime.configurationError !== undefined) {
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
		configurationError,
		getPolicy,
		model,
		modelRegistry,
	} = options;
	runtime.currentModel = model;
	runtime.modelRegistry = modelRegistry;
	try {
		const replay = replayWorkflowStateWithWarnings(branch);
		runtime.state = replay.state;
		runtime.replayWarnings = replay.warnings;
	} catch (error) {
		runtime.state = undefined;
		runtime.replayWarnings = [];
		runtime.catalog = [];
		runtime.catalogError =
			error instanceof Error ? error : new Error(String(error));
		reconcileTools(pi, new Set(), runtime.selfSuppressedNames, "lifecycle");
		throw error;
	}
	runtime.catalog =
		catalogResult.error === undefined ? catalogResult.workflows : [];
	runtime.catalogError = catalogResult.error;
	runtime.configurationError = configurationError;
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
		configurationError !== undefined &&
		(catalogResult.error === undefined || runtime.state !== undefined)
	) {
		throw configurationError;
	}
	if (catalogResult.error !== undefined && runtime.state === undefined) {
		throw catalogResult.error;
	}
}

/** Reads the model selected by one session entry. */
function readBranchModelId(candidate: unknown): string | undefined {
	if (candidate === null || typeof candidate !== "object") {
		return undefined;
	}
	const entry = candidate as Record<string, unknown>;
	if (
		entry["type"] === "model_change" &&
		typeof entry["provider"] === "string" &&
		typeof entry["modelId"] === "string"
	) {
		return `${entry["provider"]}/${entry["modelId"]}`;
	}
	const message = entry["message"];
	if (
		entry["type"] !== "message" ||
		message === null ||
		typeof message !== "object"
	) {
		return undefined;
	}
	const assistant = message as Record<string, unknown>;
	return assistant["role"] === "assistant" &&
		typeof assistant["provider"] === "string" &&
		typeof assistant["model"] === "string"
		? `${assistant["provider"]}/${assistant["model"]}`
		: undefined;
}

/** Reads the thinking level selected by one session entry. */
function readBranchThinking(candidate: unknown): ReasoningLevel | undefined {
	if (candidate === null || typeof candidate !== "object") {
		return undefined;
	}
	const entry = candidate as Record<string, unknown>;
	return entry["type"] === "thinking_level_change" &&
		isReasoningLevel(entry["thinkingLevel"])
		? entry["thinkingLevel"]
		: undefined;
}

/** Reconstructs target-branch runtime settings over the activation snapshot. */
function resolveBranchRestoration(
	branch: readonly unknown[],
	fallback: WorkflowRestorationSettings | undefined,
): WorkflowRestorationSettings | undefined {
	let modelId = fallback?.modelId;
	let thinking = fallback?.thinking;
	for (const entry of branch) {
		modelId = readBranchModelId(entry) ?? modelId;
		thinking = readBranchThinking(entry) ?? thinking;
	}
	return modelId !== undefined && thinking !== undefined
		? { modelId, thinking }
		: undefined;
}

async function synchronizeWorkflowModelRuntime(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	branch: readonly unknown[],
	previousState: WorkflowState | undefined,
): Promise<void> {
	const state = runtime.state;
	if (state === undefined || state.status === "completed") {
		const restoration =
			state?.restoration ??
			resolveBranchRestoration(branch, previousState?.restoration);
		if (restoration !== undefined) {
			const application = await applyWorkflowModelRestoration(
				pi,
				runtime.modelRegistry,
				runtime.currentModel,
				restoration,
			);
			runtime.currentModel = application.currentModel;
		}
		return;
	}
	const stageId = state.route.at(-1);
	if (stageId === undefined) {
		return;
	}
	const resolution = resolveWorkflowModelSettings({
		workflow: state.workflow,
		stageId,
		agentSettings:
			getAgentRuntimeComposition(pi).getMainAgentContribution()?.model,
		currentThinking: pi.getThinkingLevel(),
		restoration: state.restoration,
	});
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
): Promise<WorkflowState> {
	const kind = data["kind"];
	const persistedCandidate =
		(kind === "activated" || kind === "created") &&
		candidate.restoration === undefined
			? withWorkflowRestoration(
					candidate,
					captureWorkflowModelRestoration(
						runtime.currentModel,
						pi.getThinkingLevel() as ReasoningLevel,
					),
				)
			: candidate;
	const stageId = persistedCandidate.route.at(-1);
	if (stageId === undefined) {
		throw new Error("workflow candidate has no active stage");
	}
	const resolution = resolveWorkflowModelSettings({
		workflow: persistedCandidate.workflow,
		stageId,
		agentSettings:
			getAgentRuntimeComposition(pi).getMainAgentContribution()?.model,
		currentThinking: pi.getThinkingLevel(),
		restoration: persistedCandidate.restoration,
	});
	const application = await applyWorkflowModelSettings(
		pi,
		runtime.modelRegistry,
		runtime.currentModel,
		resolution,
	);
	runtime.currentModel = application.currentModel;
	const persistedData =
		kind === "activated" || kind === "created"
			? {
					...data,
					...(persistedCandidate.restoration === undefined
						? {}
						: { restoration: persistedCandidate.restoration }),
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				}
			: data;
	try {
		pi.appendEntry(WORKFLOW_STATE_ENTRY, persistedData);
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
	return persistedCandidate;
}

/** Converts unknown failures into stable operation messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Resolves workflow configuration atomically without falling back from configured errors. */
async function loadConfigurationForInitialization(
	extensionDirectory: string,
): Promise<
	| {
			readonly configuration: WorkflowConfiguration;
			readonly error?: undefined;
	  }
	| { readonly configuration?: undefined; readonly error: Error }
> {
	try {
		return {
			configuration: await loadWorkflowConfiguration(
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
	registerWorkflowGetStageTool(options);
	registerWorkflowEditStageTool(options);
	registerWorkflowTransitionTool(options);
	registerWorkflowCreateTool(options);
}

/** Executes dynamic creation as one validated, persisted, and activated operation. */
async function executeWorkflowCreate(
	options: RegisterWorkflowToolsOptions,
	params: unknown,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<typeof SUCCESS_RESULT> {
	const {
		pi,
		runtime,
		getCatalog,
		getCatalogError,
		getState,
		getPolicy,
		resolveAvailability,
		setState,
	} = options;
	const workflow = validateCreatedWorkflowDefinition(
		params,
		WORKFLOW_CREATE_TOOL,
	);
	const policy = getPolicy();
	if (policy.kind === "error") {
		throw new Error(policy.issue);
	}
	if (!resolveAvailability().availableToolNames.has(WORKFLOW_CREATE_TOOL)) {
		throw getCatalogError() ?? new Error("workflow creation is unavailable");
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
	const persisted = await commitWorkflowStateChange(pi, runtime, candidate, {
		kind: "created",
		workflow: candidate.workflow,
		route: candidate.route,
	});
	runtime.journal.activate(persisted);
	await setEnteredWorkflowState(pi, setState, persisted, { ctx, signal });
	return SUCCESS_RESULT;
}

/** Registers dynamic creation with its semantic presentation. */
function registerWorkflowCreateTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, getState } = options;
	registerPackageTool(pi, {
		name: WORKFLOW_CREATE_TOOL,
		label: "Create workflow",
		description: prompts.createDescription,
		promptGuidelines: [prompts.extensionDescription],
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
			return executeWorkflowCreate(options, params, signal, ctx);
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
		promptGuidelines: [prompts.extensionDescription],
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
			const persisted = await commitWorkflowStateChange(
				pi,
				runtime,
				candidate,
				{
					kind: "activated",
					workflow: candidate.workflow,
					route: candidate.route,
				},
			);
			runtime.journal.activate(persisted);
			await setEnteredWorkflowState(pi, setState, persisted, { ctx, signal });
			return SUCCESS_RESULT;
		},
	});
}

/** Registers stage inspection for the current active dynamic workflow. */
function registerWorkflowGetStageTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, getState } = options;
	registerPackageTool(pi, {
		name: WORKFLOW_GET_STAGE_TOOL,
		label: "Get workflow stage",
		description: prompts.getStageDescription,
		promptGuidelines: [prompts.extensionDescription],
		parameters: Type.Object(
			{
				stageId: technicalIdentifierSchema({
					description: "Existing stage ID in current active workflow",
					minLength: 1,
					maxLength: 32,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_GET_STAGE_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowStageCall(
				WORKFLOW_GET_STAGE_TOOL,
				args,
				theme,
				context,
			);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params]) {
			const stageId = readExactStringArgument(params, "stageId");
			const current = requireEditableWorkflow(options, WORKFLOW_GET_STAGE_TOOL);
			const stage = current.workflow.stages.find(({ id }) => id === stageId);
			if (stage === undefined) {
				throw new Error(`stage ${stageId} does not exist in active workflow`);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							id: stage.id,
							description: stage.description,
							prompt: stage.prompt,
							model: { thinking: stage.model?.thinking },
							initial: stage.initial,
							final: stage.final,
						}),
					},
				],
				details: {},
			};
		},
	});
}

/** Registers atomic stage replacement for the current active dynamic workflow. */
function registerWorkflowEditStageTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, runtime, getCatalog, getState, setState } = options;
	registerPackageTool(pi, {
		name: WORKFLOW_EDIT_STAGE_TOOL,
		label: "Edit workflow stage",
		description: prompts.editStageDescription,
		promptGuidelines: [prompts.extensionDescription],
		parameters: WORKFLOW_EDIT_STAGE_SCHEMA,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_EDIT_STAGE_TOOL,
					args,
					getCatalog(),
					getState(),
				),
			);
			return renderWorkflowStageCall(
				WORKFLOW_EDIT_STAGE_TOOL,
				args,
				theme,
				context,
			);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params]) {
			const current = requireEditableWorkflow(
				options,
				WORKFLOW_EDIT_STAGE_TOOL,
			);
			const candidate = editWorkflowStage(
				current,
				params,
				WORKFLOW_EDIT_STAGE_TOOL,
			);
			const stageId = readStringArgumentField(params, "stageId");
			const stage = candidate.workflow.stages.find(({ id }) => id === stageId);
			const thinking = stage?.model?.thinking;
			if (stage === undefined || thinking === undefined) {
				throw new Error(`stage ${stageId} does not exist in active workflow`);
			}
			const data = {
				kind: "stage_edited",
				stageId,
				description: stage.description,
				prompt: stage.prompt,
				model: { thinking },
			};
			let persisted = candidate;
			if (current.route.at(-1) === stageId) {
				persisted = await commitWorkflowStateChange(
					pi,
					runtime,
					candidate,
					data,
				);
			} else {
				pi.appendEntry(WORKFLOW_STATE_ENTRY, data);
			}
			runtime.journal.updateStage(persisted, stageId);
			setState(persisted);
			return SUCCESS_RESULT;
		},
	});
}

/** Returns the current active dynamic workflow after standard capability checks. */
function requireEditableWorkflow(
	options: RegisterWorkflowToolsOptions,
	toolName: typeof WORKFLOW_GET_STAGE_TOOL | typeof WORKFLOW_EDIT_STAGE_TOOL,
): WorkflowState {
	const current = options.getState();
	if (current === undefined || current.status !== "active") {
		throw new Error("no workflow is active");
	}
	if (current.source !== "dynamic") {
		throw new Error(
			"only workflows created through workflow_create can be inspected or edited",
		);
	}
	const policy = options.getPolicy();
	if (policy.kind === "error") {
		throw new Error(policy.issue);
	}
	const availability = options.resolveAvailability();
	if (
		availability.projectedState !== current ||
		!availability.availableToolNames.has(toolName)
	) {
		throw new Error(`workflow ${current.workflow.id} is not available`);
	}
	return current;
}

/** Reads one required string field after a domain validator accepted the object. */
function readStringArgumentField(value: unknown, key: string): string {
	const candidate =
		typeof value === "object" && value !== null
			? Reflect.get(value, key)
			: undefined;
	if (typeof candidate !== "string") {
		throw new Error(`${key} must be a string`);
	}
	return candidate;
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
		promptGuidelines: [prompts.extensionDescription],
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
			const persisted = await commitWorkflowStateChange(
				pi,
				runtime,
				candidate,
				{
					kind: "transitioned",
					route: candidate.route,
				},
			);
			runtime.journal.enterStage(persisted);
			await setEnteredWorkflowState(pi, setState, persisted, { ctx, signal });
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

	// Suppression ownership remains separate from final list ownership for branch restoration.
	for (const name of activeNames.filter(isWorkflowToolName)) {
		if (!availableToolNames.has(name)) {
			selfSuppressedNames.add(name);
		}
	}
	if (trigger === "lifecycle") {
		for (const name of selfSuppressedNames) {
			if (isWorkflowToolName(name) && availableToolNames.has(name)) {
				selfSuppressedNames.delete(name);
			}
		}
	}

	getAgentRuntimeComposition(pi).setRestrictiveToolFilter(
		"workflow-availability",
		(candidates) =>
			candidates.filter(
				(name) => !isWorkflowToolName(name) || availableToolNames.has(name),
			),
	);
}

/** Narrows arbitrary Pi tool names to the workflow-owned finite set. */
function isWorkflowToolName(name: string): name is WorkflowToolName {
	return WORKFLOW_TOOL_NAMES.has(name);
}
