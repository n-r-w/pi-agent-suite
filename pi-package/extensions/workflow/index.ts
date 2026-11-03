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
	SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT,
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
	WORKFLOW_EXIT_TOOL,
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
import { hasVisibleWorkflowGraph, WorkflowJournal } from "./context";
import { readWorkflowPolicyEnvironment } from "./environment";
import { requireKnownWorkflowKind, type WorkflowKind } from "./kinds";
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
	renderWorkflowExitCall,
	renderWorkflowResult,
	renderWorkflowStageCall,
	renderWorkflowTransitionCall,
	type WorkflowToolPresentationDetails,
} from "./tool-rendering.ts";
import {
	activateWorkflow,
	addWorkflow,
	createWorkflow,
	editWorkflowStage,
	exitWorkflow,
	getAvailableTransitions,
	getTopWorkflow,
	replayWorkflowChain,
	transitionWorkflow,
	validateCreatedWorkflowDefinition,
	validateWorkflowBindings,
	WORKFLOW_STATE_JOURNAL_VERSION,
	type WorkflowChain,
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
	WORKFLOW_EXIT_TOOL,
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
		id: Type.String({
			description: "Unique stage ID referenced by transitions",
			minLength: 1,
			maxLength: 32,
		}),
		description: Type.String({
			description: "Short single-line summary of stage outcome",
			minLength: 1,
			maxLength: 128,
		}),
		goal: Type.String({
			description:
				"The stage goal is the state that must hold when the stage is complete. The stage task consists of the actions that reach this state. Example goal: The reviewer has approved the delivery.",
			minLength: 1,
			maxLength: 8192,
		}),
		prompt: Type.String({
			description: `Instructions for this stage. Format:
\`\`\`
Rules:
1. [Instruction]
2. ...

Actions:
1. [Action]
2. ...

Subagents:
1. [Optional subagents rules]
2. ...

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
				description: "Whether this is the initial stage",
			}),
		),
		final: Type.Optional(
			Type.Boolean({
				description: "Whether this stage is final",
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
		goal: Type.Optional(
			Type.String({
				description:
					"Replacement stage goal, required for formats 2 and 3 and unavailable for format 1",
				minLength: 1,
				maxLength: 8192,
			}),
		),
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
		workflow: Type.Optional(
			Type.String({
				description: "Catalog nested workflow that checks this transition",
				minLength: 1,
			}),
		),
		from: Type.String({
			description: "Source stage ID",
			minLength: 1,
			maxLength: 32,
		}),
		to: Type.String({
			description: "Target stage ID",
			minLength: 1,
			maxLength: 32,
		}),
		type: StringEnum(["advance", "rework"] as const, {
			description:
				"Transition direction: advance for forward progress, rework for a return",
		}),
		grounds: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({
							description: "Ground ID unique within this transition",
							minLength: 1,
						}),
						when: Type.String({
							description: "Condition under which this transition is taken",
							minLength: 1,
						}),
					},
					{ additionalProperties: false },
				),
				{
					description:
						"Required on rework transitions and on every advance transition when its source has multiple advance transitions. A sole advance transition can omit grounds and is then unconditional.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

/** Requires a factual statement for each route transition or workflow exit. */
const WORKFLOW_BASIS_SCHEMA = Type.String({
	description: "Facts that justify the transition or exit",
	minLength: 1,
	pattern: "\\S",
});

/** Closed workflow_transition input with an optional declared ground ID. */
const WORKFLOW_TRANSITION_ARGUMENTS_SCHEMA = Type.Object(
	{
		basis: WORKFLOW_BASIS_SCHEMA,
		stageId: technicalIdentifierSchema({
			description: "Target stage ID listed in <available_transitions>",
			minLength: 1,
		}),
		ground: Type.Optional(
			technicalIdentifierSchema({
				description:
					"Ground ID declared by the selected transition, when it has grounds",
				minLength: 1,
			}),
		),
	},
	{ additionalProperties: false },
);

/** Complete workflow_create boundary shape; graph invariants remain domain validation. */
const WORKFLOW_CREATE_SCHEMA = Type.Object(
	{
		kind: Type.Optional(
			Type.String({
				description: "ID from the workflow kinds catalog",
				minLength: 1,
			}),
		),
		nested: Type.Optional(
			Type.Boolean({
				description: "Whether the workflow is nested",
			}),
		),
		id: Type.String({
			description: "Unique workflow ID",
			minLength: 6,
			maxLength: 32,
		}),
		description: Type.String({
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
			description: "Complete list of workflow stages",
			minItems: 2,
			maxItems: 64,
		}),
		transitions: Type.Array(WORKFLOW_TRANSITION_SCHEMA, {
			description: "Directed stage transitions",
			minItems: 1,
			maxItems: 256,
		}),
	},
	{ additionalProperties: false },
);

/** Provides the contribution event used after main-agent policy replaces active tools. */
interface WorkflowEventBus {
	on(
		eventName: typeof SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT,
		listener: () => void,
	): () => void;
}

/** Supplies the mutable workflow state boundaries used by registered tools. */
interface RegisterWorkflowToolsOptions {
	readonly pi: ExtensionAPI;
	readonly prompts: WorkflowPrompts;
	readonly runtime: WorkflowRuntime;
	readonly getCatalog: () => readonly WorkflowDefinition[];
	readonly getCatalogError: () => Error | undefined;
	readonly getPolicy: () => WorkflowPolicyResolution;
	readonly resolveAvailability: () => WorkflowAvailability;
	readonly setChain: (chain: WorkflowChain) => void;
}

interface WorkflowRuntime {
	readonly kinds: readonly WorkflowKind[];
	catalog: readonly WorkflowDefinition[];
	catalogError: Error | undefined;
	configurationError: Error | undefined;
	chain: WorkflowChain;
	/** Retains the last root snapshot independently of overrides on an empty branch. */
	emptyRestoration: WorkflowRestorationSettings | undefined;
	replayWarnings: readonly string[];
	currentModel: ExtensionContext["model"];
	modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	readonly offeredToolNames: Set<WorkflowToolName>;
	readonly journal: WorkflowJournal;
	readonly reminderScheduler: WorkflowReminderScheduler;
	journalReady: boolean;
}

/** Distinguishes lifecycle publication from policy-only reconciliation. */
type ReconciliationTrigger = "lifecycle" | "policy-reset";

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
async function setEnteredWorkflowChain(
	pi: ExtensionAPI,
	setChain: (chain: WorkflowChain) => void,
	chain: WorkflowChain,
	invocation: TriggerInvocation,
): Promise<void> {
	setChain(chain);
	const state = getTopWorkflow(chain);
	if (state !== undefined) {
		await runEnteredStageTriggers(pi, state, invocation);
	}
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
		kinds: catalogResult.kinds ?? [],
		catalog: catalogResult.error === undefined ? catalogResult.workflows : [],
		catalogError: catalogResult.error,
		configurationError,
		chain: [],
		emptyRestoration: undefined,
		replayWarnings: [],
		currentModel: undefined,
		modelRegistry: undefined,
		offeredToolNames: new Set<WorkflowToolName>(),
		journal: new WorkflowJournal((record, delivery, triggerTurn) => {
			pi.sendMessage(record, {
				deliverAs: delivery,
				...(triggerTurn === undefined ? {} : { triggerTurn }),
			});
			if (recordCarriesCurrentWorkflowState(record.details)) {
				reminderScheduler.workflowStatePublished();
			}
		}, catalogResult.kinds ?? []),
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
	indicator?.publish(getTopWorkflow(runtime.chain));
}

/** Publishes the current model-visible catalog subset after active-tool reconciliation. */
function publishWorkflowActivationOptions(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	availability: WorkflowAvailability,
	triggerTurn?: boolean,
): void {
	const options = pi.getActiveTools().includes(WORKFLOW_ACTIVATE_TOOL)
		? availability.activationOptions
		: [];
	runtime.journal.activationOptions(options, triggerTurn ?? false);
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
			runtime.offeredToolNames,
		);
		publishWorkflowStatus(statusHolder.indicator, runtime);
		if (runtime.journalReady && trigger !== "policy-reset") {
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

/** Registers session and model lifecycle synchronization without reapplying manual model changes. */
function registerWorkflowLifecycle(options: WorkflowLifecycleOptions): void {
	const { pi, runtime, getPolicy, refreshTools, statusHolder, warnings } =
		options;
	let reportedReplayWarningKey: string | undefined;
	const synchronize = createWorkflowSynchronizer(options);
	registerWorkflowRunLifecycle(pi, runtime);
	registerWorkflowCompaction(pi, runtime, getPolicy);
	pi.on("before_agent_start", (_event, ctx) => {
		const availability = resolveRuntimeAvailability(runtime, getPolicy());
		const workflows = pi.getActiveTools().includes(WORKFLOW_ACTIVATE_TOOL)
			? availability.activationOptions
			: [];
		const message = runtime.journal.activationOptionsForRun(
			workflows,
			ctx.sessionManager.getBranch(),
		);
		return message === undefined ? undefined : { message };
	});
	const unsubscribeFromAgentChanges = (
		pi.events as unknown as WorkflowEventBus
	).on(SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT, () => {
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
	readonly sessionManager: Pick<
		ExtensionContext["sessionManager"],
		"getBranch" | "buildSessionProjection"
	>;
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
			const previousRestoration =
				runtime.chain[0]?.restoration ?? runtime.emptyRestoration;
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
			await synchronizeWorkflowModelRuntime(
				pi,
				runtime,
				branch,
				previousRestoration,
			);
			runtime.journal.restore(branch);
			const state = getTopWorkflow(runtime.chain);
			if (state !== undefined) {
				const { entries } = ctx.sessionManager.buildSessionProjection();
				if (
					!runtime.journal.isCurrent(runtime.chain) ||
					runtime.chain.some((item) => !hasVisibleWorkflowGraph(item, entries))
				) {
					runtime.journal.checkpoint(runtime.chain, entries);
				}
			} else if (runtime.emptyRestoration !== undefined) {
				runtime.journal.exit();
			}
			runtime.journalReady = true;
		} finally {
			publishWorkflowStatus(statusHolder.indicator, runtime);
		}
	};
}

/** Tracks model selections without treating settlement as a workflow operation. */
function registerWorkflowRunLifecycle(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
): void {
	pi.on("model_select", (event) => {
		runtime.currentModel = event.model;
	});
}

/** Registers the post-compaction workflow checkpoint. */
function registerWorkflowCompaction(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	getPolicy: () => WorkflowPolicyResolution,
): void {
	pi.on("session_compact", (_event, ctx) => {
		runtime.journal.startContextSegment();
		const state = getTopWorkflow(runtime.chain);
		if (state !== undefined) {
			runtime.journal.checkpoint(
				runtime.chain,
				ctx.sessionManager.buildSessionProjection().entries,
				false,
			);
		} else if (runtime.emptyRestoration !== undefined) {
			runtime.journal.exit();
		}
		// Automatic compaction must establish availability for the continuing run.
		// Manual compaction while idle leaves publication to before_agent_start.
		if (!ctx.isIdle()) {
			publishWorkflowActivationOptions(
				pi,
				runtime,
				resolveRuntimeAvailability(runtime, getPolicy()),
				false,
			);
		}
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
				getAgentRuntimeComposition(pi).getSelectedAgentContribution()?.agent
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
		getPolicy,
		resolveAvailability,
		setChain: (chain) => {
			runtime.chain = chain;
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
		const state = getTopWorkflow(runtime.chain);
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
				state !== undefined,
				allToolResultsTerminate,
			) &&
			state !== undefined
		) {
			runtime.journal.reminder(
				runtime.chain,
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
			getTopWorkflow(runtime.chain),
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
		chain: runtime.chain,
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
		const replay = replayWorkflowChain(branch);
		runtime.chain = replay.chain;
		runtime.emptyRestoration = replay.restoration;
		runtime.replayWarnings = replay.warnings;
	} catch (error) {
		runtime.chain = [];
		runtime.emptyRestoration = undefined;
		runtime.replayWarnings = [];
		runtime.catalog = [];
		runtime.catalogError =
			error instanceof Error ? error : new Error(String(error));
		reconcileTools(pi, new Set(), runtime.offeredToolNames);
		throw error;
	}
	runtime.catalog =
		catalogResult.error === undefined ? catalogResult.workflows : [];
	runtime.catalogError = catalogResult.error;
	runtime.configurationError = configurationError;
	const policy = getPolicy();
	const availability = resolveRuntimeAvailability(runtime, policy);
	reconcileTools(pi, availability.availableToolNames, runtime.offeredToolNames);
	if (policy.kind === "error") {
		throw new Error(policy.issue);
	}
	if (
		configurationError !== undefined &&
		(catalogResult.error === undefined ||
			getTopWorkflow(runtime.chain) !== undefined)
	) {
		throw configurationError;
	}
	if (
		catalogResult.error !== undefined &&
		getTopWorkflow(runtime.chain) === undefined
	) {
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

/** Reconciles the target branch without allowing workflow or sibling-branch settings to leak. */
async function synchronizeWorkflowModelRuntime(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	branch: readonly unknown[],
	previousRestoration: WorkflowRestorationSettings | undefined,
): Promise<void> {
	const state = getTopWorkflow(runtime.chain);
	if (state === undefined) {
		const reverseBoundary =
			runtime.emptyRestoration === undefined
				? -1
				: [...branch]
						.reverse()
						.findIndex(
							(entry) =>
								typeof entry === "object" &&
								entry !== null &&
								Reflect.get(entry, "customType") === WORKFLOW_STATE_ENTRY,
						);
		const boundary =
			reverseBoundary < 0 ? -1 : branch.length - reverseBoundary - 1;
		const restoration = resolveBranchRestoration(
			branch.slice(boundary + 1),
			runtime.emptyRestoration ?? previousRestoration,
		);
		if (restoration !== undefined) {
			const application = await applyWorkflowModelRestoration(
				pi,
				runtime.modelRegistry,
				runtime.currentModel,
				restoration,
			);
			runtime.currentModel = application.currentModel;
			if (runtime.emptyRestoration === undefined) {
				runtime.emptyRestoration = previousRestoration;
			}
		}
		return;
	}
	await applyActiveWorkflowModel(pi, runtime, state);
}

/** Applies runtime settings and persists one activation or transition atomically. */
async function commitWorkflowStateChange(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	candidate: WorkflowState,
	data: Record<string, unknown>,
): Promise<WorkflowState> {
	const starts = data["kind"] === "activated" || data["kind"] === "created";
	if (starts) {
		addWorkflow(runtime.chain, candidate);
	}
	return transactWorkflowModels(pi, runtime, async () => {
		const rootSnapshot = runtime.chain[0]?.restoration;
		if (
			starts &&
			candidate.workflow.nested !== true &&
			rootSnapshot !== undefined
		) {
			const restored = await applyWorkflowModelRestoration(
				pi,
				runtime.modelRegistry,
				runtime.currentModel,
				rootSnapshot,
			);
			runtime.currentModel = restored.currentModel;
		}
		const persisted = starts
			? withWorkflowRestoration(
					candidate,
					captureWorkflowModelRestoration(
						runtime.currentModel,
						pi.getThinkingLevel() as ReasoningLevel,
					),
				)
			: candidate;
		await applyActiveWorkflowModel(pi, runtime, persisted);
		pi.appendEntry(WORKFLOW_STATE_ENTRY, {
			...data,
			journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
			...(starts
				? {
						mode: persisted.workflow.nested === true ? "push" : "replace",
						restoration: persisted.restoration,
					}
				: {}),
		});
		runtime.emptyRestoration = undefined;
		return persisted;
	});
}

/** Applies the active stage through the shared workflow and agent precedence rules. */
async function applyActiveWorkflowModel(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	state: WorkflowState,
): Promise<void> {
	const stageId = state.route.at(-1);
	if (stageId === undefined) {
		throw new Error("workflow candidate has no active stage");
	}
	const application = await applyWorkflowModelSettings(
		pi,
		runtime.modelRegistry,
		runtime.currentModel,
		resolveWorkflowModelSettings({
			workflow: state.workflow,
			stageId,
			agentSettings:
				getAgentRuntimeComposition(pi).getSelectedAgentContribution()?.model,
			currentThinking: pi.getThinkingLevel(),
			restoration: state.restoration,
		}),
	);
	runtime.currentModel = application.currentModel;
}

/** Rolls back all model changes when any part of a persisted operation fails. */
async function transactWorkflowModels<T>(
	pi: ExtensionAPI,
	runtime: WorkflowRuntime,
	operation: () => Promise<T>,
): Promise<T> {
	const previousModel = runtime.currentModel;
	const previousThinking = pi.getThinkingLevel() as ReasoningLevel;
	try {
		return await operation();
	} catch (error) {
		try {
			await rollbackWorkflowModelSettings(pi, {
				previousModel,
				previousThinking,
				currentModel: runtime.currentModel,
				modelChanged: runtime.currentModel !== previousModel,
			});
			runtime.currentModel = previousModel;
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
	registerWorkflowExitTool(options);
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
		getPolicy,
		resolveAvailability,
		setChain,
	} = options;
	const workflow = validateCreatedWorkflowDefinition(
		params,
		WORKFLOW_CREATE_TOOL,
	);
	requireKnownWorkflowKind(workflow.kind, runtime.kinds);
	validateWorkflowBindings(workflow, getCatalog());
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
	const candidate = createWorkflow(workflow);
	const persisted = await commitWorkflowStateChange(pi, runtime, candidate, {
		kind: "created",
		workflow: candidate.workflow,
		route: candidate.route,
	});
	const chain = addWorkflow(runtime.chain, persisted);
	runtime.journal.activate(chain);
	await setEnteredWorkflowChain(pi, setChain, chain, { ctx, signal });
	return SUCCESS_RESULT;
}

/** Registers dynamic creation with its semantic presentation. */
function registerWorkflowCreateTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, runtime } = options;
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
					getTopWorkflow(runtime.chain),
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
		getPolicy,
		resolveAvailability,
		setChain,
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
					getTopWorkflow(runtime.chain),
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
			const chain = addWorkflow(runtime.chain, persisted);
			runtime.journal.activate(chain);
			await setEnteredWorkflowChain(pi, setChain, chain, { ctx, signal });
			return SUCCESS_RESULT;
		},
	});
}

/** Registers stage inspection for the current active dynamic workflow. */
function registerWorkflowGetStageTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, getCatalog, runtime } = options;
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
					getTopWorkflow(runtime.chain),
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
							...(stage.goal === undefined ? {} : { goal: stage.goal }),
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
	const { pi, prompts, runtime, getCatalog, setChain } = options;
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
					getTopWorkflow(runtime.chain),
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
				journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				kind: "stage_edited",
				stageId,
				description: stage.description,
				...(stage.goal === undefined ? {} : { goal: stage.goal }),
				prompt: stage.prompt,
				model: { thinking },
			};
			if (current.route.at(-1) === stageId) {
				await commitWorkflowStateChange(pi, runtime, candidate, data);
			} else {
				pi.appendEntry(WORKFLOW_STATE_ENTRY, data);
			}
			const chain = [...runtime.chain.slice(0, -1), candidate];
			runtime.journal.updateStage(chain, stageId);
			setChain(chain);
			return SUCCESS_RESULT;
		},
	});
}

/** Returns the current active dynamic workflow after standard capability checks. */
function requireEditableWorkflow(
	options: RegisterWorkflowToolsOptions,
	toolName: typeof WORKFLOW_GET_STAGE_TOOL | typeof WORKFLOW_EDIT_STAGE_TOOL,
): WorkflowState {
	const current = getTopWorkflow(options.runtime.chain);
	if (current === undefined) {
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

/** Validates the free-text statement before workflow or model state can change. */
function requireWorkflowBasis(params: unknown): void {
	const basis = readStringArgumentField(params, "basis");
	if (basis.trim().length === 0) {
		throw new Error("basis must contain non-whitespace text");
	}
}

/** Registers transition behavior and its source-to-target presentation. */
function registerWorkflowTransitionTool(
	options: RegisterWorkflowToolsOptions,
): void {
	const { pi, prompts, runtime, getCatalog } = options;
	registerPackageTool(pi, {
		name: WORKFLOW_TRANSITION_TOOL,
		label: "Transition workflow",
		description: prompts.transitionDescription,
		promptGuidelines: [prompts.extensionDescription],
		parameters: WORKFLOW_TRANSITION_ARGUMENTS_SCHEMA,
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_TRANSITION_TOOL,
					args,
					getCatalog(),
					getTopWorkflow(runtime.chain),
				),
			);
			return renderWorkflowTransitionCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			return executeWorkflowTransition(options, params, { ctx, signal });
		},
	});
}

/** Validates a requested move before committing its route or starting its bound check. */
async function executeWorkflowTransition(
	options: RegisterWorkflowToolsOptions,
	params: unknown,
	invocation: TriggerInvocation,
): Promise<typeof SUCCESS_RESULT> {
	const { pi, runtime, getPolicy, resolveAvailability, setChain } = options;
	const stageId = readExactStringArgument(params, "stageId", [
		"ground",
		"basis",
	]);
	requireWorkflowBasis(params);
	const ground =
		Reflect.get(params as object, "ground") === undefined
			? undefined
			: readStringArgumentField(params, "ground");
	const current = getTopWorkflow(runtime.chain);
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
	const candidate = transitionWorkflow(current, stageId, ground);
	const binding = getAvailableTransitions(current).find(
		({ to }) => to === stageId,
	)?.workflow;
	if (binding !== undefined) {
		await startBoundWorkflow(
			options,
			binding,
			{ stageId, ...(ground === undefined ? {} : { ground }) },
			invocation,
		);
		return SUCCESS_RESULT;
	}
	const persisted = await commitWorkflowStateChange(pi, runtime, candidate, {
		kind: "transitioned",
		route: candidate.route,
	});
	const chain = [...runtime.chain.slice(0, -1), persisted];
	runtime.journal.enterStage(chain);
	await setEnteredWorkflowChain(pi, setChain, chain, invocation);
	return SUCCESS_RESULT;
}

/** Starts a catalog check only after authorization and chain validation. */
async function startBoundWorkflow(
	options: RegisterWorkflowToolsOptions,
	binding: string,
	pendingTransition: NonNullable<WorkflowState["pendingTransition"]>,
	invocation: TriggerInvocation,
): Promise<void> {
	const { pi, runtime, getCatalog, setChain } = options;
	const workflow = getCatalog().find(
		({ id }) => toWorkflowMatchKey(id) === toWorkflowMatchKey(binding),
	);
	if (workflow === undefined) {
		throw new Error(`bound workflow ${binding} does not exist in the catalog`);
	}
	requireWorkflowAllowed(options.getPolicy(), workflow.id);
	const bound = { ...activateWorkflow(workflow), pendingTransition };
	const persisted = await commitWorkflowStateChange(pi, runtime, bound, {
		kind: "activated",
		workflow: bound.workflow,
		route: bound.route,
		pendingTransition,
	});
	const chain = addWorkflow(runtime.chain, persisted);
	runtime.journal.activate(chain);
	await setEnteredWorkflowChain(pi, setChain, chain, invocation);
}

/** Registers explicit workflow exit with validation before runtime side effects. */
function registerWorkflowExitTool(options: RegisterWorkflowToolsOptions): void {
	const { pi, prompts, runtime } = options;
	registerPackageTool(pi, {
		name: WORKFLOW_EXIT_TOOL,
		label: "Exit workflow",
		description: prompts.exitDescription,
		promptGuidelines: [prompts.extensionDescription],
		parameters: Type.Object(
			{
				basis: WORKFLOW_BASIS_SCHEMA,
				allow: Type.Optional(
					Type.Boolean({
						description:
							"Required when `<workflow_chain>` shows `<pending_transition>` for the active workflow: true lets the waiting workflow move to the requested stage, false keeps it at its stage",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		renderCall(args, theme, context) {
			primeWorkflowRenderState(
				context,
				createWorkflowPresentationDetails(
					WORKFLOW_EXIT_TOOL,
					args,
					runtime.catalog,
					getTopWorkflow(runtime.chain),
				),
			);
			return renderWorkflowExitCall(args, theme, context);
		},
		renderResult: renderWorkflowResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			return executeWorkflowExit(options, params, { ctx, signal });
		},
	});
}

/** Persists explicit exit after restoring the remaining chain or root snapshot. */
async function executeWorkflowExit(
	options: RegisterWorkflowToolsOptions,
	params: unknown,
	invocation: TriggerInvocation,
): Promise<typeof SUCCESS_RESULT> {
	const { pi, runtime, resolveAvailability, setChain } = options;
	if (
		params === null ||
		typeof params !== "object" ||
		Array.isArray(params) ||
		Object.keys(params).some((key) => key !== "basis" && key !== "allow")
	) {
		throw new Error("exit requires basis and optional boolean allow");
	}
	requireWorkflowBasis(params);
	const allow = Reflect.get(params, "allow");
	if ("allow" in params && typeof allow !== "boolean") {
		throw new Error("allow must be a boolean");
	}
	const current = getTopWorkflow(runtime.chain);
	if (current === undefined) {
		throw new Error("no workflow is active");
	}
	if (resolveAvailability().projectedState !== current) {
		throw new Error(`workflow ${current.workflow.id} is not available`);
	}
	const remaining = exitWorkflow(runtime.chain, allow);
	const parent = getTopWorkflow(remaining);
	const snapshot = runtime.chain[0]?.restoration;
	await transactWorkflowModels(pi, runtime, async () => {
		if (parent !== undefined) {
			await applyActiveWorkflowModel(pi, runtime, parent);
		} else if (snapshot !== undefined) {
			const application = await applyWorkflowModelRestoration(
				pi,
				runtime.modelRegistry,
				runtime.currentModel,
				snapshot,
			);
			runtime.currentModel = application.currentModel;
		}
		pi.appendEntry(WORKFLOW_STATE_ENTRY, {
			kind: "exited",
			journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
			...(current.pendingTransition === undefined ? {} : { allow }),
		});
	});
	runtime.emptyRestoration = parent === undefined ? snapshot : undefined;
	setChain(remaining);
	if (parent === undefined) {
		runtime.journal.exit();
	} else {
		runtime.journal.enterStage(
			remaining,
			allow === false ? current.pendingTransition : undefined,
		);
		if (current.pendingTransition !== undefined && allow === true) {
			await runEnteredStageTriggers(pi, parent, invocation);
		}
	}
	return SUCCESS_RESULT;
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
function readExactStringArgument(
	value: unknown,
	key: string,
	optionalKeys: readonly string[] = [],
): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("tool arguments must be an object");
	}
	const keys = Object.keys(value);
	const candidate = Reflect.get(value, key);
	if (
		!keys.includes(key) ||
		keys.some(
			(candidateKey) =>
				candidateKey !== key && !optionalKeys.includes(candidateKey),
		) ||
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		candidate.trim() !== candidate
	) {
		throw new Error(
			`${key} must be a non-empty trimmed string; allowed arguments: ${[key, ...optionalKeys].join(", ")}`,
		);
	}
	return candidate;
}

/** Adds newly applicable workflow tools without overriding agent policy. */
function reconcileTools(
	pi: ExtensionAPI,
	availableToolNames: ReadonlySet<WorkflowToolName>,
	offeredToolNames: Set<WorkflowToolName>,
): void {
	for (const name of availableToolNames) {
		offeredToolNames.add(name);
	}
	getAgentRuntimeComposition(pi).setRestrictiveToolFilter(
		"workflow-availability",
		(candidates) =>
			candidates.filter(
				(name) => !isWorkflowToolName(name) || offeredToolNames.has(name),
			),
	);
}

/** Narrows arbitrary Pi tool names to the workflow-owned finite set. */
function isWorkflowToolName(name: string): name is WorkflowToolName {
	return WORKFLOW_TOOL_NAMES.has(name);
}
