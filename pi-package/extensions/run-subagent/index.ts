import { join } from "node:path";
import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import type { AuxiliaryLlmCompletion } from "../../shared/auxiliary-llm";
import {
	type PackagePresentationEventBus,
	registerPackageTool,
} from "../../shared/tool-presentation/registry";
import type { AgentOperationResponse } from "./agent-operation-wire";
import {
	applyChildToolPolicy,
	isAgentAvailableForCaller,
	loadCallableAgents,
	publishPromptContribution,
	resolveLaunchConfiguration,
} from "./agent-policy";
import { readCancellationError } from "./cancellation-reason";
import {
	parseSubagentQueryRequest,
	parseSubagentStartRequest,
	parseSubagentSteerRequest,
	parseSubagentWaitRequest,
	type SubagentFailureDetails,
	type SubagentNormalResult,
	SubagentQueryParameters,
	SubagentStartParameters,
	SubagentSteerParameters,
	SubagentToolError,
	SubagentWaitParameters,
	type SubagentWaitRequest,
} from "./contracts";
import { SubagentCoordinator } from "./coordinator";
import type {
	JournalRecord,
	LogicalSession,
	OwnerIdentity,
	SubagentFeedback,
} from "./domain";
import {
	readConfig,
	readPrompt,
	SUBAGENTS_V2_EXTENSION_DIR,
	type SubagentsV2Config,
} from "./entry-config";
import { readSubagentAgentId } from "./environment";
import { errorMessage } from "./error-message";
import { InvocationSupervisor } from "./invocation-supervisor";
import { parseFeedback, parseJournalRecord } from "./journal-codec";
import { ManagementProjectionRuntime } from "./management-screen/runtime";
import {
	createManagementRetainedState,
	createManagementScreenFactory,
	findProjectionNode,
	openManagementOverlay,
} from "./management-screen/screen";
import { installSubagentStatusIndicator } from "./management-screen/status-indicator";
import {
	type ActiveOwnerSessionWriter,
	createHistoryMessage,
	SUBAGENT_HISTORY_CUSTOM_TYPE,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
	V2SessionStore,
} from "./persistence";
import { QueryBranchAccess } from "./query-branch-access";
import type { QueryBranchResponse } from "./query-branch-wire";
import {
	renderSubagentQueryCall,
	renderSubagentQueryResult,
} from "./query-rendering";
import {
	installWorkerRuntimeBridge,
	RootRuntimeBridge,
	type RuntimeChannelFailure,
	type WorkerRuntimeBridge,
} from "./runtime-bridge";
import {
	recoverOwnerShutdown,
	recoverRootShutdown,
	recoverRuntimeFailure,
} from "./runtime-failure";
import { RuntimeFailureRecoveryTracker } from "./runtime-recovery-tracker";
import type { RuntimeRequest } from "./runtime-wire";
import {
	renderSubagentFeedback,
	renderSubagentStartCall,
	renderSubagentStartResult,
	renderSubagentSteerCall,
	renderSubagentSteerResult,
	renderSubagentWaitCall,
	renderSubagentWaitResult,
} from "./semantic-rendering.ts";
import { SessionCatalog } from "./session-catalog";
import { SessionSnapshotLoader } from "./session-snapshot-loader";
import { executeSubagentQuery } from "./subagent-query";
import { createToolPresentationRegistry } from "./tool-rendering.ts";
import { WaitCoordinator } from "./wait-coordinator";

const EXTENSION_DESCRIPTION = readPrompt("extension-description.md");
const START_DESCRIPTION = readPrompt("start-description.md");
const STEER_DESCRIPTION = readPrompt("steer-description.md");
const WAIT_DESCRIPTION = readPrompt("wait-description.md");
const QUERY_DESCRIPTION = readPrompt("query-description.md");
const QUERY_SYSTEM_PROMPT = readPrompt("query-system.md");
const V2_TOOL_NAMES = new Set([
	"subagent_start",
	"subagent_steer",
	"subagent_wait",
	"subagent_query",
]);

interface RootManagementRuntime {
	readonly projection: ManagementProjectionRuntime;
	readonly factory: Parameters<ExtensionContext["ui"]["custom"]>[0];
	dispose(): void;
}

interface RootRuntime {
	readonly owner: OwnerIdentity;
	readonly writer: ActiveOwnerSessionWriter;
	readonly store: V2SessionStore;
	readonly coordinator: SubagentCoordinator;
	readonly supervisor: InvocationSupervisor;
	readonly recoveries: RuntimeFailureRecoveryTracker;
	readonly queryBranches: QueryBranchAccess;
	readonly management?: RootManagementRuntime;
}

interface RuntimeState {
	readonly resolveConfig: () => Promise<SubagentsV2Config>;
	readonly failures: Map<string, SubagentFailureDetails>;
	config: SubagentsV2Config | undefined;
	initialization: Promise<void> | undefined;
	workerBridge: WorkerRuntimeBridge | undefined;
	rootRuntime: RootRuntime | undefined;
	workerWriter: ActiveOwnerSessionWriter | undefined;
	workerStore: V2SessionStore | undefined;
	promptPublished: boolean;
	managementRegistered: boolean;
}

type RuntimeStateResolver = () => Promise<RuntimeState>;
type RegisteredToolExecute = Parameters<
	ExtensionAPI["registerTool"]
>[0]["execute"];
type RegisteredToolExecuteArgs = Parameters<RegisteredToolExecute>;

/** Marks internal root cancellation so the bridge returns no public V2 failure. */
class RuntimeOperationCancellationError extends Error {}

/** Keeps one registered definition mutable until Pi completes extension loading. */
interface RegisteredDescription {
	description: string;
}

/** Provides isolated external effects used by subagent query execution. */
interface SubagentsV2Dependencies {
	readonly completeSimple?: AuxiliaryLlmCompletion;
}

/** Registers stable V2 tools before session runtime performs asynchronous work. */
export default function subagentsV2(
	pi: ExtensionAPI,
	dependencies: SubagentsV2Dependencies = {
		completeSimple: defaultCompleteSimple,
	},
): Promise<void> {
	let configReady: Promise<SubagentsV2Config> | undefined;
	const state: RuntimeState = {
		resolveConfig: () =>
			configReady ??
			Promise.reject(new Error("subagent configuration is initializing")),
		failures: new Map(),
		config: undefined,
		initialization: undefined,
		workerBridge: undefined,
		rootRuntime: undefined,
		workerWriter: undefined,
		workerStore: undefined,
		promptPublished: false,
		managementRegistered: false,
	};
	const resolveState = (): Promise<RuntimeState> => resolveRuntimeState(state);
	pi.registerMessageRenderer(
		SUBAGENT_HISTORY_CUSTOM_TYPE,
		renderSubagentFeedback,
	);
	// Agent-core receives all definitions before configuration or session I/O begins.
	const registrations = {
		start: registerStartTool(pi, resolveState),
		steer: registerSteerTool(pi, resolveState),
		wait: registerWaitTool(pi, resolveState),
		query: registerQueryTool(
			pi,
			resolveState,
			dependencies.completeSimple ?? defaultCompleteSimple,
		),
	};
	registerLifecycleHandlers(pi, state);
	configReady = readConfig();
	// Pi awaits the factory promise before copying definitions into its first agent snapshot.
	return configReady.then((config) => {
		registrations.start.description =
			config.startDescription ?? START_DESCRIPTION;
		registrations.steer.description =
			config.steerDescription ?? STEER_DESCRIPTION;
		registrations.wait.description = config.waitDescription ?? WAIT_DESCRIPTION;
	});
}

/** Resolves the runtime initialized by the current session_start event. */
async function resolveRuntimeState(state: RuntimeState): Promise<RuntimeState> {
	if (state.initialization === undefined) {
		throw new SubagentToolError(
			"start_failed",
			"Subagent tools are unavailable",
		);
	}
	try {
		await state.initialization;
	} catch {
		throw new SubagentToolError(
			"start_failed",
			"Subagent tools are unavailable",
		);
	}
	return state;
}

/** Registers session, reconciliation, shutdown, and failed-result handlers. */
function registerLifecycleHandlers(
	pi: ExtensionAPI,
	state: RuntimeState,
): void {
	pi.on("session_start", (_event, ctx) => {
		state.initialization = handleSessionStart(pi, state, ctx);
		return state.initialization;
	});
	pi.on("message_end", (_event, ctx) => reconcileRuntime(state, ctx));
	pi.on("session_shutdown", (_event, ctx) => handleSessionShutdown(state, ctx));
	pi.on("tool_result", (event) => {
		if (!V2_TOOL_NAMES.has(event.toolName) || !event.isError) {
			return undefined;
		}
		const failure = state.failures.get(event.toolCallId);
		if (failure === undefined) {
			return undefined;
		}
		state.failures.delete(event.toolCallId);
		return { details: failure, isError: true };
	});
}

/** Initializes either the worker adapter or the root runtime for one Pi session. */
async function handleSessionStart(
	pi: ExtensionAPI,
	state: RuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	const config = await state.resolveConfig();
	state.config = config;
	if (!config.enabled) {
		if (config.issue !== undefined && ctx.hasUI) {
			ctx.ui.notify(config.issue, "error");
		}
		return;
	}
	if (!state.promptPublished) {
		publishPromptContribution(
			pi,
			config.maxDepth,
			config.extensionDescription ?? EXTENSION_DESCRIPTION,
		);
		state.promptPublished = true;
	}
	applyChildToolPolicy(pi);
	state.workerBridge ??= installWorkerRuntimeBridge();
	if (state.workerBridge === undefined) {
		state.rootRuntime?.management?.dispose();
		state.rootRuntime = await createRootRuntime(pi, ctx);
		registerManagementEntries(pi, state, ctx);
		return;
	}
	const owner = ownerFromContext(ctx);
	const store = new V2SessionStore();
	const writer = createActiveWriter(pi, ctx, owner);
	state.workerStore = store;
	state.workerWriter = writer;
	store.registerActive(writer);
	state.workerBridge.activate(owner, (operation, payload) =>
		handleWorkerCommand(operation, payload, owner, store),
	);
	await store.reconcileActive(writer);
}

/** Reconciles pending feedback after Pi persists a message event. */
async function reconcileRuntime(
	state: RuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (state.workerWriter !== undefined && state.workerStore !== undefined) {
		await state.workerStore.reconcileActive(state.workerWriter);
		return;
	}
	if (
		state.rootRuntime !== undefined &&
		state.rootRuntime.owner.ownerPiSessionId ===
			ctx.sessionManager.getSessionId()
	) {
		await state.rootRuntime.store.reconcileActive(state.rootRuntime.writer);
	}
}

/** Stops direct-owner work before releasing its sole session writer. */
async function handleSessionShutdown(
	state: RuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (state.workerBridge !== undefined) {
		try {
			await state.workerBridge.request("owner_stopping", {});
		} finally {
			state.workerStore?.unregisterActive(ctx.sessionManager.getSessionId());
		}
		return;
	}
	if (state.rootRuntime !== undefined) {
		const rootRuntime = state.rootRuntime;
		rootRuntime.management?.dispose();
		// Root disposal closes recovery admission before joining closure and admitted work.
		await rootRuntime.recoveries.closeAndDrain(() =>
			recoverRootShutdown({
				coordinator: rootRuntime.coordinator,
				store: rootRuntime.store,
				owner: rootRuntime.owner,
			}),
		);
		rootRuntime.store.unregisterActive(rootRuntime.owner.ownerPiSessionId);
		state.rootRuntime = undefined;
	}
}

/** Registers non-blocking new-session acceptance. */
function registerStartTool(
	pi: ExtensionAPI,
	resolveState: RuntimeStateResolver,
): RegisteredDescription {
	return registerTool(pi, {
		name: "subagent_start",
		label: "Start subagent",
		description: START_DESCRIPTION,
		parameters: SubagentStartParameters,
		renderCall: renderSubagentStartCall,
		renderResult: renderSubagentStartResult,
		execute: async (...args) => {
			const [toolCallId, rawParams, signal, , ctx] = args;
			const request = parseSubagentStartRequest(rawParams);
			return executeTool(toolCallId, resolveState, signal, async (state) => {
				if (state.workerBridge !== undefined) {
					return state.workerBridge.requestOperation(
						{
							toolName: "subagent_start",
							toolCallId,
							params: request,
						},
						signal,
					);
				}
				state.rootRuntime ??= await createRootRuntime(pi, ctx);
				const result = await state.rootRuntime.coordinator.start(
					state.rootRuntime.owner,
					request,
					{
						...(signal === undefined ? {} : { signal }),
						operationCorrelation: { requestId: toolCallId, toolCallId },
					},
				);
				return {
					kind: "ok",
					result,
					evidence: state.rootRuntime.coordinator.acceptedPresentationEvidence(
						state.rootRuntime.owner,
						result.sessionId,
					),
				};
			});
		},
	});
}

/** Registers active steering and terminal continuation. */
function registerSteerTool(
	pi: ExtensionAPI,
	resolveState: RuntimeStateResolver,
): RegisteredDescription {
	return registerTool(pi, {
		name: "subagent_steer",
		label: "Steer subagent",
		description: STEER_DESCRIPTION,
		parameters: SubagentSteerParameters,
		renderCall: renderSubagentSteerCall,
		renderResult: renderSubagentSteerResult,
		execute: async (...args) => {
			const [toolCallId, rawParams, signal, , ctx] = args;
			const request = parseSubagentSteerRequest(rawParams);
			return executeTool(toolCallId, resolveState, signal, async (state) => {
				if (state.workerBridge !== undefined) {
					return state.workerBridge.requestOperation(
						{
							toolName: "subagent_steer",
							toolCallId,
							params: request,
						},
						signal,
					);
				}
				state.rootRuntime ??= await createRootRuntime(pi, ctx);
				const result = await state.rootRuntime.coordinator.steer(
					state.rootRuntime.owner,
					request,
					{
						...(signal === undefined ? {} : { signal }),
						operationCorrelation: { requestId: toolCallId, toolCallId },
					},
				);
				return {
					kind: "ok",
					result,
					evidence: state.rootRuntime.coordinator.acceptedPresentationEvidence(
						state.rootRuntime.owner,
						result.sessionId,
					),
				};
			});
		},
	});
}

/** Registers one owner-scoped wait that never changes child execution. */
function registerWaitTool(
	pi: ExtensionAPI,
	resolveState: RuntimeStateResolver,
): RegisteredDescription {
	return registerTool(pi, {
		name: "subagent_wait",
		label: "Wait for subagents",
		description: WAIT_DESCRIPTION,
		parameters: SubagentWaitParameters,
		renderCall: renderSubagentWaitCall,
		renderResult: renderSubagentWaitResult,
		execute: async (...args) => {
			const [toolCallId, rawParams, signal, , ctx] = args;
			const request = parseSubagentWaitRequest(rawParams);
			return executeTool(toolCallId, resolveState, signal, async (state) => {
				if (state.workerBridge !== undefined) {
					const response = await state.workerBridge.requestWait(
						{
							toolName: "subagent_wait",
							toolCallId,
							params: request,
						},
						signal,
					);
					return response;
				}
				state.rootRuntime ??= await createRootRuntime(pi, ctx);
				const result = await executeRootWait({
					coordinator: state.rootRuntime.coordinator,
					owner: state.rootRuntime.owner,
					request,
					execution: { toolCallId, requestId: toolCallId },
					signal,
				});
				const evidence =
					state.rootRuntime.coordinator.takeWaitEvidence(toolCallId);
				return evidence === undefined
					? { kind: "ok", result }
					: { kind: "ok", result, evidence };
			});
		},
	});
}

/** Registers one saved-session query whose model request stays in the caller process. */
function registerQueryTool(
	pi: ExtensionAPI,
	resolveState: RuntimeStateResolver,
	completeSimple: AuxiliaryLlmCompletion,
): RegisteredDescription {
	return registerTool(pi, {
		name: "subagent_query",
		label: "Query subagent session",
		description: QUERY_DESCRIPTION,
		parameters: SubagentQueryParameters,
		renderCall: renderSubagentQueryCall,
		renderResult: renderSubagentQueryResult,
		execute: (...args) =>
			executeQueryTool(pi, resolveState, completeSimple, args),
	});
}

/** Executes one validated query and preserves cancellation identity. */
async function executeQueryTool(
	pi: ExtensionAPI,
	resolveState: RuntimeStateResolver,
	completeSimple: AuxiliaryLlmCompletion,
	args: RegisteredToolExecuteArgs,
): Promise<AgentToolResult<unknown>> {
	const startedAt = performance.now();
	const [, rawParams, signal, , ctx] = args;
	const request = parseSubagentQueryRequest(rawParams);
	try {
		const state = await resolveState();
		const config = state.config;
		if (config === undefined || !config.enabled) {
			throw new SubagentToolError(
				"query_failed",
				"Subagent queries are unavailable",
			);
		}
		const branchResponse = await loadQueryBranch(
			pi,
			ctx,
			state,
			request.sessionId,
		);
		if (branchResponse.kind === "failed") {
			throw new SubagentToolError(
				branchResponse.failure.code,
				branchResponse.failure.message,
			);
		}
		const modelConfig = config.query?.model;
		const result = await executeSubagentQuery({
			completeSimple,
			ctx,
			pi,
			branchEntries: branchResponse.branch,
			question: request.question,
			systemPrompt: config.query?.systemPrompt ?? QUERY_SYSTEM_PROMPT,
			currentThinkingLevel: pi.getThinkingLevel(),
			...(modelConfig === undefined ? {} : { modelConfig }),
			...(signal === undefined ? {} : { signal }),
		});
		if (result.kind === "issue") {
			throw new SubagentToolError("query_failed", result.issue);
		}
		return {
			content: [{ type: "text", text: result.answer }],
			details: {
				answer: result.answer,
				elapsedMs: performance.now() - startedAt,
			},
		};
	} catch (error) {
		if (signal?.aborted && error === readCancellationError(signal)) {
			throw error;
		}
		if (error instanceof SubagentToolError) {
			throw error;
		}
		throw new SubagentToolError("query_failed", errorMessage(error));
	}
}

/** Loads one query branch through the caller's process-specific route. */
async function loadQueryBranch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RuntimeState,
	sessionId: number,
): Promise<QueryBranchResponse> {
	return state.workerBridge === undefined
		? loadRootQueryBranch(pi, ctx, state, sessionId)
		: state.workerBridge.request("query_branch", { sessionId });
}

/** Resolves the mode-independent root branch-access owner on first use. */
async function loadRootQueryBranch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: RuntimeState,
	sessionId: number,
) {
	state.rootRuntime ??= await createRootRuntime(pi, ctx);
	return state.rootRuntime.queryBranches.load(
		state.rootRuntime.owner,
		sessionId,
	);
}

/** Races root feedback with one serialized exact wait cancellation transition. */
async function executeRootWait({
	coordinator,
	owner,
	request,
	execution,
	signal,
}: {
	readonly coordinator: SubagentCoordinator;
	readonly owner: OwnerIdentity;
	readonly request: SubagentWaitRequest;
	readonly execution: {
		readonly toolCallId: string;
		readonly requestId: string;
	};
	readonly signal: AbortSignal | undefined;
}): Promise<SubagentNormalResult> {
	if (signal?.aborted) {
		throw readCancellationError(signal);
	}
	const pending = coordinator.wait(owner, request, execution);
	if (signal === undefined) {
		return pending;
	}
	let cancel = (): void => undefined;
	const cancellation = new Promise<SubagentNormalResult>((resolve, reject) => {
		cancel = () => {
			// Coordinator admission, timer, and resolver end before rejection is observable.
			coordinator
				.cancelWait(owner, execution, readCancellationError(signal))
				.then(() => pending)
				.then(resolve, reject);
		};
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([pending, cancellation]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

/** Registers one V2 tool without attaching execution renderers. */
function registerTool(
	pi: ExtensionAPI,
	definition: Parameters<ExtensionAPI["registerTool"]>[0],
): RegisteredDescription {
	const registeredDefinition = {
		...definition,
		executionMode: "parallel" as const,
	};
	registerPackageTool(pi, registeredDefinition);
	return registeredDefinition;
}

/** Executes one operation and preserves stable failure details for tool_result. */
async function executeTool(
	toolCallId: string,
	resolveState: RuntimeStateResolver,
	signal: AbortSignal | undefined,
	operation: (
		state: RuntimeState,
		config: SubagentsV2Config,
	) => Promise<AgentOperationResponse>,
): Promise<AgentToolResult<unknown>> {
	let state: RuntimeState | undefined;
	try {
		// Execution resolves initialized state after registration has already entered Pi's tool snapshot.
		state = await resolveState();
		const config = state.config;
		if (config === undefined || !config.enabled) {
			throw new SubagentToolError(
				"start_failed",
				"Subagent tools are unavailable",
			);
		}
		const response = await operation(state, config);
		if (response.kind === "failed") {
			throw new SubagentToolError(
				response.failure.code,
				response.failure.message,
			);
		}
		return {
			content: [{ type: "text", text: JSON.stringify(response.result) }],
			details:
				response.evidence === undefined
					? response.result
					: { ...response.result, ...response.evidence },
		};
	} catch (error) {
		if (signal?.aborted && error === readCancellationError(signal)) {
			throw error;
		}
		const failure =
			error instanceof SubagentToolError
				? error.details
				: new SubagentToolError("start_failed", errorMessage(error)).details;
		state?.failures.set(toolCallId, failure);
		throw new SubagentToolError(failure.code, failure.message);
	}
}

/** Creates one root coordinator, supervisor, persistence owner, and reconstruction state. */
async function createRootRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<RootRuntime> {
	const owner = ownerFromContext(ctx);
	const writer = createActiveWriter(pi, ctx, owner);
	const agents = await loadCallableAgents(ctx.cwd);
	const bridge = new RootRuntimeBridge();
	let supervisor: InvocationSupervisor | undefined;
	const store = createRootSessionStore(bridge, () => supervisor);
	store.registerActive(writer);
	const catalog = new SessionCatalog();
	const sessionSnapshots = new SessionSnapshotLoader();
	const queryBranches = new QueryBranchAccess(catalog, sessionSnapshots);
	const recoveries = new RuntimeFailureRecoveryTracker();
	let coordinator: SubagentCoordinator | undefined;
	supervisor = createRootSupervisor({
		pi,
		ctx,
		agents,
		bridge,
		store,
		recoveries,
		queryBranches,
		getCoordinator: () => requireCoordinator(coordinator),
	});
	coordinator = createRootCoordinator({
		pi,
		owner,
		agents,
		catalog,
		supervisor,
		store,
	});
	addReconstructedSessions(catalog, await store.reconstructActive(writer));
	coordinator.registerOwner(owner);
	const management =
		ctx.mode === "tui"
			? createRootManagementRuntime({
					ctx,
					presentationEvents: pi.events,
					owner,
					catalog,
					coordinator,
					supervisor,
					sessionSnapshots,
				})
			: undefined;
	return {
		owner,
		writer,
		store,
		coordinator,
		supervisor,
		recoveries,
		queryBranches,
		...(management === undefined ? {} : { management }),
	};
}

/** Creates the root supervisor while retaining the coordinator callback cycle. */
function createRootSupervisor(options: {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly agents: Awaited<ReturnType<typeof loadCallableAgents>>;
	readonly bridge: RootRuntimeBridge;
	readonly store: V2SessionStore;
	readonly recoveries: RuntimeFailureRecoveryTracker;
	readonly queryBranches: QueryBranchAccess;
	readonly getCoordinator: () => SubagentCoordinator;
}): InvocationSupervisor {
	let supervisor: InvocationSupervisor;
	supervisor = new InvocationSupervisor({
		bridge: options.bridge,
		sessionsDir: join(
			getSuiteExtensionDir(SUBAGENTS_V2_EXTENSION_DIR),
			"sessions",
		),
		resolveLaunch: (request) =>
			resolveLaunchConfiguration({
				pi: options.pi,
				ctx: options.ctx,
				agents: options.agents,
				supervisor,
				request,
			}),
		onEvent: (event) => options.getCoordinator().observeInvocation(event),
		onRuntimeFailure: (failure) =>
			startRuntimeFailureRecovery({
				recoveries: options.recoveries,
				coordinator: options.getCoordinator(),
				store: options.store,
				failure,
			}),
		onRuntimeRequest: (remoteOwner, request) =>
			handleRootRuntimeRequest({
				coordinator: options.getCoordinator(),
				store: options.store,
				queryBranches: options.queryBranches,
				owner: remoteOwner,
				request,
			}),
	});
	return supervisor;
}

/** Creates the sole root transition owner around the production ports. */
function createRootCoordinator(options: {
	readonly pi: ExtensionAPI;
	readonly owner: OwnerIdentity;
	readonly agents: Awaited<ReturnType<typeof loadCallableAgents>>;
	readonly catalog: SessionCatalog;
	readonly supervisor: InvocationSupervisor;
	readonly store: V2SessionStore;
}): SubagentCoordinator {
	const composition = getAgentRuntimeComposition(options.pi);
	return new SubagentCoordinator({
		catalog: options.catalog,
		invocations: options.supervisor,
		waits: new WaitCoordinator(),
		store: options.store,
		clock: {
			monotonicNow: () => performance.now(),
			wallNow: () => Date.now(),
		},
		isAgentAvailable: (caller, agentId) =>
			isAgentAvailableForCaller({
				agents: options.agents,
				mainAgent: composition.getMainAgentContribution()?.agent,
				rootOwner: options.owner,
				caller,
				catalog: options.catalog,
				rootSelectedAgentId: readSubagentAgentId(),
				requestedAgentId: agentId,
			}),
	});
}

/** Creates one TUI-only projection, submission adapter, and stable screen factory. */
function createRootManagementRuntime(options: {
	readonly ctx: ExtensionContext;
	readonly presentationEvents: PackagePresentationEventBus;
	readonly owner: OwnerIdentity;
	readonly catalog: SessionCatalog;
	readonly coordinator: SubagentCoordinator;
	readonly supervisor: InvocationSupervisor;
	readonly sessionSnapshots: SessionSnapshotLoader;
}): RootManagementRuntime {
	const projection = new ManagementProjectionRuntime({
		rootOwnerPiSessionId: options.owner.ownerPiSessionId,
		catalog: options.catalog,
		activeConversations: options.supervisor,
		readInactiveBranch: (session) =>
			options.sessionSnapshots.load(session.childSessionFile),
		onError: (error) => options.ctx.ui.notify(error.message, "error"),
	});
	const disposeStatusIndicator = installSubagentStatusIndicator(
		options.ctx.ui,
		projection,
	);
	const retained = createManagementRetainedState();
	const tools = createToolPresentationRegistry(
		options.ctx.cwd,
		options.presentationEvents,
	);
	const submission = {
		async submit(stableKey: string, text: string) {
			const node = findProjectionNode(projection.getView(), stableKey);
			if (node === undefined) {
				return {
					accepted: false as const,
					error: "selected subagent session is unavailable",
				};
			}
			try {
				await options.coordinator.submitManagementMessage(node.key, text);
				return { accepted: true as const };
			} catch (error) {
				return { accepted: false as const, error: errorMessage(error) };
			}
		},
	};
	const factory = createManagementScreenFactory({
		ctx: options.ctx,
		source: projection,
		tools,
		submission,
		retained,
	});
	return {
		projection,
		factory,
		dispose: () => {
			disposeStatusIndicator();
			projection.dispose();
		},
	};
}

/** Registers both interactive entries once and routes them to the current runtime. */
function registerManagementEntries(
	pi: ExtensionAPI,
	state: RuntimeState,
	ctx: ExtensionContext,
): void {
	if (
		ctx.mode !== "tui" ||
		state.managementRegistered ||
		state.rootRuntime?.management === undefined
	) {
		return;
	}
	state.managementRegistered = true;
	const open = async (handlerContext: ExtensionContext): Promise<void> => {
		const management = state.rootRuntime?.management;
		if (handlerContext.mode !== "tui" || management === undefined) {
			return;
		}
		await openManagementOverlay(handlerContext, management.factory);
	};
	pi.registerCommand("subagents", {
		description: "Open the Subagents management screen",
		handler: async (_args, handlerContext) => open(handlerContext),
	});
	pi.registerShortcut("ctrl+shift+g", {
		description: "Open the Subagents management screen",
		handler: open,
	});
}

/** Creates remote persistence adapters that resolve the current root supervisor lease. */
function createRootSessionStore(
	bridge: RootRuntimeBridge,
	getSupervisor: () => InvocationSupervisor | undefined,
): V2SessionStore {
	return new V2SessionStore({
		append: async (remoteOwner, record) => {
			const lease = requireRemoteLease(getSupervisor(), remoteOwner);
			await bridge.request(lease, "append_journal", record);
		},
		appendHistory: async (remoteOwner, feedback) => {
			const lease = requireRemoteLease(getSupervisor(), remoteOwner);
			await bridge.request(lease, "append_history", feedback);
		},
	});
}

/** Adds every reconstructed stable session key once despite reusable owner-local IDs. */
function addReconstructedSessions(
	catalog: SessionCatalog,
	sessions: readonly LogicalSession[],
): void {
	for (const session of sessions) {
		const alreadyRegistered = catalog
			.findByLocalId(session.key.ownerLocalSessionId)
			.some(
				(current) =>
					current.key.ownerPiSessionId === session.key.ownerPiSessionId,
			);
		if (!alreadyRegistered) {
			catalog.add(session);
		}
	}
}

/** Starts one observed fail-stop without floating its recovery rejection. */
function startRuntimeFailureRecovery({
	recoveries,
	coordinator,
	store,
	failure,
}: {
	readonly recoveries: RuntimeFailureRecoveryTracker;
	readonly coordinator: SubagentCoordinator | undefined;
	readonly store: V2SessionStore;
	readonly failure: RuntimeChannelFailure;
}): void {
	// Root lifecycle owns admitted recovery work even though the failure callback cannot await it.
	recoveries.start(() =>
		recoverRuntimeFailure(requireCoordinator(coordinator), store, failure),
	);
}

/** Cancels one exact nested start or steer without publishing a V2 failure. */
function cancelRootOperation(
	coordinator: SubagentCoordinator,
	request: Extract<RuntimeRequest, { readonly operation: "cancel_operation" }>,
): { readonly acknowledged: true; readonly cancellationWon: boolean } {
	const cancellationWon = coordinator.cancelOperation(
		{
			requestId: request.payload.operationRequestId,
			toolCallId: request.payload.operationToolCallId,
			runtimeLeaseId: request.runtimeLeaseId,
		},
		new RuntimeOperationCancellationError("nested operation was aborted"),
	);
	return { acknowledged: true, cancellationWon };
}

/** Cancels one exact nested wait without publishing a V2 failure. */
async function cancelRootWait(
	coordinator: SubagentCoordinator,
	owner: OwnerIdentity,
	request: Extract<RuntimeRequest, { readonly operation: "cancel_wait" }>,
): Promise<{ readonly acknowledged: true }> {
	const cancelled = await coordinator.cancelWait(
		owner,
		{
			toolCallId: request.payload.waitToolCallId,
			requestId: request.payload.waitRequestId,
			runtimeLeaseId: request.runtimeLeaseId,
		},
		new RuntimeOperationCancellationError("nested wait was aborted"),
	);
	if (!cancelled) {
		throw new Error("nested wait cancellation lost its correlation");
	}
	return { acknowledged: true };
}

/** Routes one validated worker request into the root coordination authority. */
async function handleRootRuntimeRequest({
	coordinator,
	store,
	queryBranches,
	owner,
	request,
}: {
	readonly coordinator: SubagentCoordinator;
	readonly store: V2SessionStore;
	readonly queryBranches: QueryBranchAccess;
	readonly owner: OwnerIdentity;
	readonly request: RuntimeRequest;
}): Promise<
	AgentOperationResponse | QueryBranchResponse | { readonly acknowledged: true }
> {
	if (request.operation === "owner_stopping") {
		await recoverOwnerShutdown({
			coordinator,
			store,
			owner,
			stoppingRuntimeLeaseId: request.runtimeLeaseId,
		});
		return { acknowledged: true };
	}
	if (request.operation === "cancel_operation") {
		return cancelRootOperation(coordinator, request);
	}
	if (request.operation === "cancel_wait") {
		return cancelRootWait(coordinator, owner, request);
	}
	if (request.operation === "query_branch") {
		return queryBranches.load(owner, request.payload.sessionId);
	}
	if (request.operation !== "agent_operation") {
		throw new Error(`worker operation ${request.operation} is not permitted`);
	}
	// Wire parsing validates the operation envelope and params before owner state publication.
	const operation = request.payload;
	store.registerRemote(owner, request.runtimeLeaseId);
	coordinator.registerOwner(owner);
	try {
		if (operation.toolName === "subagent_start") {
			const result = await coordinator.start(owner, operation.params, {
				ownerRuntimeLeaseId: request.runtimeLeaseId,
				operationCorrelation: {
					requestId: request.requestId,
					toolCallId: operation.toolCallId,
					runtimeLeaseId: request.runtimeLeaseId,
				},
			});
			return {
				kind: "ok",
				result,
				evidence: coordinator.acceptedPresentationEvidence(
					owner,
					result.sessionId,
				),
			};
		}
		if (operation.toolName === "subagent_steer") {
			const result = await coordinator.steer(owner, operation.params, {
				ownerRuntimeLeaseId: request.runtimeLeaseId,
				operationCorrelation: {
					requestId: request.requestId,
					toolCallId: operation.toolCallId,
					runtimeLeaseId: request.runtimeLeaseId,
				},
			});
			return {
				kind: "ok",
				result,
				evidence: coordinator.acceptedPresentationEvidence(
					owner,
					result.sessionId,
				),
			};
		}
		const result = await coordinator.wait(owner, operation.params, {
			toolCallId: operation.toolCallId,
			requestId: request.requestId,
			runtimeLeaseId: request.runtimeLeaseId,
		});
		const evidence = coordinator.takeWaitEvidence(operation.toolCallId);
		return evidence === undefined
			? { kind: "ok", result }
			: { kind: "ok", result, evidence };
	} catch (error) {
		return failedAgentOperation(error);
	}
}

/** Maps one coordination failure while preserving cancellation rejection. */
function failedAgentOperation(error: unknown): AgentOperationResponse {
	if (error instanceof RuntimeOperationCancellationError) {
		throw error;
	}
	const failure =
		error instanceof SubagentToolError
			? error.details
			: new SubagentToolError("start_failed", errorMessage(error)).details;
	return { kind: "failed", failure };
}

/** Applies root persistence commands through the active worker's public Pi writer. */
async function handleWorkerCommand(
	operation: RuntimeRequest["operation"],
	payload: unknown,
	owner: OwnerIdentity,
	store: V2SessionStore,
): Promise<{ readonly acknowledged: true }> {
	if (operation === "append_journal") {
		const record = parseJournalRecord(payload);
		if (record === undefined) {
			throw new Error("root sent an invalid journal command");
		}
		await store.append(owner, record);
		return { acknowledged: true };
	}
	if (operation === "append_history") {
		const feedback = parseFeedback(payload);
		if (feedback === undefined) {
			throw new Error("root sent an invalid history command");
		}
		await store.appendHistory(owner, feedback);
		return { acknowledged: true };
	}
	throw new Error(`root operation ${operation} is not permitted`);
}

/** Creates the sole active owner writer from public extension APIs. */
function createActiveWriter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	owner: OwnerIdentity,
): ActiveOwnerSessionWriter {
	return {
		owner,
		sessionManager: ctx.sessionManager,
		appendJournal: (record: JournalRecord) => {
			pi.appendEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
		},
		appendHistory: (feedback: SubagentFeedback) => {
			const message = createHistoryMessage(feedback);
			pi.sendMessage(
				{
					customType: SUBAGENT_HISTORY_CUSTOM_TYPE,
					content: message.content,
					display: true,
					details: message.details,
				},
				{ triggerTurn: false, deliverAs: "steer" },
			);
		},
	};
}

/** Builds direct owner identity only from public session manager methods. */
function ownerFromContext(ctx: ExtensionContext): OwnerIdentity {
	return {
		ownerPiSessionId: ctx.sessionManager.getSessionId(),
		ownerSessionFile: ctx.sessionManager.getSessionFile() ?? "",
	};
}

/** Requires the initialized root coordinator inside supervisor callbacks. */
function requireCoordinator(
	coordinator: SubagentCoordinator | undefined,
): SubagentCoordinator {
	if (coordinator === undefined) {
		throw new Error("subagent coordinator is not initialized");
	}
	return coordinator;
}

/** Resolves the one active remote owner lease without fallback. */
function requireRemoteLease(
	supervisor: InvocationSupervisor | undefined,
	owner: OwnerIdentity,
): string {
	const lease = supervisor?.findRuntimeLeaseForOwner(owner.ownerPiSessionId);
	if (lease === undefined) {
		throw new Error(
			`owner ${owner.ownerPiSessionId} has no active runtime lease`,
		);
	}
	return lease;
}
