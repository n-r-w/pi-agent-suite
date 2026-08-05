import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentSuiteDir } from "../../shared/agent-suite-storage";
import type { AuxiliaryLlmCompletion } from "../../shared/auxiliary-llm";
import { isChildAgentProcess } from "../../shared/child-agent-environment";
import {
	collectLoadedSkillRoots,
	replayContextProjection,
} from "../../shared/context-projection";
import {
	appendKnowledgeBlock,
	getKnowledgeHierarchyClient,
	type KnowledgeHierarchyClient,
	type KnowledgeRootRuntime,
	type KnowledgeScope,
	type KnowledgeSnapshots,
	registerKnowledgeContextRuntime,
	registerKnowledgeRootRuntime,
} from "../../shared/knowledge-runtime";
import { isReasoningLevel } from "../../shared/reasoning-levels";
import {
	registerWorkflowTriggerRunner,
	type WorkflowTrigger,
	type WorkflowTriggerRunner,
} from "../../shared/workflow-trigger-runtime";
import {
	type KnowledgeAccumulationOperation,
	runGlobalKnowledgeAccumulation,
	runLocalKnowledgeAccumulation,
} from "./algorithms";
import {
	isGitBranchName,
	isGitRemoteName,
	type KnowledgeConfig,
	type KnowledgeConfigResult,
	readKnowledgeConfig,
} from "./config";
import { renderKnowledgeBlock } from "./context";
import { KnowledgeMutationCoordinator } from "./coordinator";
import { isKnowledgeChildProcess } from "./environment";
import {
	type GitProjectResolution,
	type ResolveGitProjectOptions,
	resolveGitProject,
} from "./git-context";
import { KnowledgeOwner } from "./owner";
import {
	type BranchPaths,
	createBranchPaths,
	createProjectPaths,
	type ProjectPaths,
} from "./paths";

/** Injects deterministic configuration, Git, and model boundaries into lifecycle tests. */
interface KnowledgeExtensionDependencies {
	readonly readConfig?: () => KnowledgeConfigResult;
	readonly resolveProject?: (
		options: ResolveGitProjectOptions,
	) => GitProjectResolution;
	readonly completeSimple?: AuxiliaryLlmCompletion;
	readonly replay?: typeof replayContextProjection;
	readonly runtimeEnv?: NodeJS.ProcessEnv;
}

/** Carries one resolved storage scope plus write-only branch data. */
interface ResolvedKnowledgeScope {
	readonly resolution: Extract<
		GitProjectResolution,
		{ readonly project: unknown }
	>;
	readonly scope: KnowledgeScope;
	readonly projectPaths: ProjectPaths;
	readonly branchPaths: BranchPaths | null;
}

/** Supplies stable dependencies shared by context reads and workflow mutations. */
interface EnabledKnowledgeRuntime {
	readonly pi: ExtensionAPI;
	readonly config: KnowledgeConfig;
	readonly owner: KnowledgeOwner;
	readonly resolveProject: (
		options: ResolveGitProjectOptions,
	) => GitProjectResolution;
	readonly completeSimple: AuxiliaryLlmCompletion;
	readonly replay: typeof replayContextProjection;
	readonly getLoadedSkillRoots: () => readonly string[];
	readonly rootClient: KnowledgeHierarchyClient | undefined;
}

/** Registers the knowledge runtime for one root or child Pi process. */
export default function knowledgeExtension(
	pi: ExtensionAPI,
	dependencies: KnowledgeExtensionDependencies = {},
): void {
	const configResult =
		dependencies.readConfig?.() ??
		readKnowledgeConfig({
			agentSuiteDir: getAgentSuiteDir(),
			isGitBranchName,
			isGitRemoteName,
		});
	if (configResult.kind === "invalid") {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify("[knowledge] invalid configuration", "error");
			}
		});
		return;
	}
	if (!configResult.config.enabled) {
		return;
	}

	const config = configResult.config;
	const owner = new KnowledgeOwner({
		globalTokenLimit: config.globalTokenLimit,
		localTokenLimit: config.localTokenLimit,
	});
	const resolveProject = dependencies.resolveProject ?? resolveGitProject;
	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	const replay = dependencies.replay ?? replayContextProjection;
	let loadedSkillRoots: readonly string[] = [];
	const childProcess =
		dependencies.runtimeEnv === undefined
			? isKnowledgeChildProcess()
			: isChildAgentProcess(dependencies.runtimeEnv);
	const coordinator = childProcess
		? undefined
		: new KnowledgeMutationCoordinator((scope) =>
				readStoredSnapshots(owner, config, scope),
			);
	const rootHierarchies =
		coordinator === undefined ? undefined : createRootHierarchies(coordinator);
	const rootClient = rootHierarchies?.client;
	const disposers: Array<() => void> = [];
	if (rootHierarchies !== undefined) {
		disposers.push(registerKnowledgeRootRuntime(pi, rootHierarchies.root));
	}

	const runtime: EnabledKnowledgeRuntime = {
		pi,
		config,
		owner,
		resolveProject,
		completeSimple,
		replay,
		getLoadedSkillRoots: () => loadedSkillRoots,
		rootClient,
	};
	const readBlock = createKnowledgeBlockReader(runtime);
	disposers.push(registerKnowledgeContextRuntime(pi, { readBlock }));
	disposers.push(
		registerWorkflowTriggerRunner(pi, createKnowledgeTriggerRunner(runtime)),
	);

	pi.on("before_agent_start", async (event, ctx) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
		const block = await readBlock(ctx);
		return block === null
			? undefined
			: { systemPrompt: appendKnowledgeBlock(event.systemPrompt, block) };
	});
	pi.on("session_shutdown", () => {
		coordinator?.shutdown();
		for (const dispose of disposers.splice(0)) {
			dispose();
		}
	});
}

/** Creates the shared context reader with fail-closed scope and storage behavior. */
function createKnowledgeBlockReader(
	runtime: EnabledKnowledgeRuntime,
): (ctx: ExtensionContext) => Promise<string | null> {
	return async (ctx) => {
		try {
			const resolved = resolveKnowledgeScope(
				runtime.config,
				runtime.resolveProject,
				ctx.cwd,
			);
			if (resolved === null) {
				return null;
			}
			const snapshots = await requireHierarchy(
				runtime.pi,
				runtime.rootClient,
			).read(resolved.scope);
			return renderKnowledgeBlock(snapshots);
		} catch {
			reportSafeFailure(ctx, "context unavailable");
			return null;
		}
	};
}

/** Creates the workflow boundary that reports failure without changing workflow success. */
function createKnowledgeTriggerRunner(
	runtime: EnabledKnowledgeRuntime,
): WorkflowTriggerRunner {
	return {
		async run(trigger, ctx, signal) {
			const reportProgress =
				!ctx.hasUI || ctx.ui === undefined
					? (operation: KnowledgeAccumulationOperation) => {
							process.stderr.write(
								`${formatKnowledgeProgressMessage(operation)}\n`,
							);
						}
					: (operation: KnowledgeAccumulationOperation) => {
							ctx.ui.notify(formatKnowledgeProgressMessage(operation), "info");
						};
			try {
				await runKnowledgeTrigger({
					runtime,
					trigger,
					ctx,
					signal,
					reportProgress,
				});
				return { ok: true };
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[knowledge] accumulation failed (${formatKnowledgeFailureReason(error)})`,
						"warning",
					);
				} else {
					process.stderr.write(
						`[knowledge] accumulation failed (${formatKnowledgeFailureReason(error)})\n`,
					);
				}
				return { ok: false };
			}
		},
	};
}

/** Maps one accumulation operation to a stable user-facing progress message. */
function formatKnowledgeProgressMessage(
	operation: KnowledgeAccumulationOperation,
): string {
	switch (operation) {
		case "prepare_local_summary":
			return "[knowledge] preparing local knowledge summary...";
		case "merge_local_knowledge":
			return "[knowledge] merging local knowledge...";
		case "merge_global_knowledge":
			return "[knowledge] merging global knowledge...";
	}
}

/** Formats one accumulation failure into user-visible warning details. */
function formatKnowledgeFailureReason(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}
	return String(error);
}

/** Carries one trigger execution request for root-coordinated accumulation. */
interface KnowledgeTriggerRunRequest {
	readonly runtime: EnabledKnowledgeRuntime;
	readonly trigger: WorkflowTrigger;
	readonly ctx: ExtensionContext;
	readonly signal: AbortSignal | undefined;
	readonly reportProgress:
		| ((operation: KnowledgeAccumulationOperation) => void)
		| undefined;
}

/** Runs one accumulation under a root FIFO lease resolved before admission. */
async function runKnowledgeTrigger(
	request: KnowledgeTriggerRunRequest,
): Promise<void> {
	const { runtime, trigger, ctx, signal, reportProgress } = request;
	const resolved = resolveKnowledgeScope(
		runtime.config,
		runtime.resolveProject,
		ctx.cwd,
	);
	if (resolved === null) {
		throw new Error("knowledge project scope unavailable");
	}
	if (resolved.resolution.kind === "resolved-read-only") {
		return;
	}
	if (resolved.branchPaths === null) {
		throw new Error("knowledge branch scope unavailable");
	}
	const hierarchy = requireHierarchy(runtime.pi, runtime.rootClient);
	const currentThinking = runtime.pi.getThinkingLevel();
	const lease = await hierarchy.acquire(resolved.scope, signal);
	try {
		const options = {
			config: runtime.config,
			ctx,
			owner: runtime.owner,
			projectPaths: resolved.projectPaths,
			branchPaths: resolved.branchPaths,
			identityMetadata: resolved.resolution.identityMetadata,
			snapshots: lease.snapshots,
			branchEntries: ctx.sessionManager.getBranch(),
			loadedSkillRoots: runtime.getLoadedSkillRoots(),
			replay: runtime.replay,
			currentThinking: isReasoningLevel(currentThinking)
				? currentThinking
				: undefined,
			completeSimple: runtime.completeSimple,
			signal,
			...(reportProgress === undefined ? {} : { reportProgress }),
		};
		if (trigger.type === "local_knowledge_accumulation") {
			await runLocalKnowledgeAccumulation(options);
		} else {
			await runGlobalKnowledgeAccumulation(options);
		}
	} finally {
		await hierarchy.release(lease.leaseId);
	}
}

/** Builds separate root-transport and root-local views over the only process FIFO. */
function createRootHierarchies(coordinator: KnowledgeMutationCoordinator): {
	readonly root: KnowledgeRootRuntime;
	readonly client: KnowledgeHierarchyClient;
} {
	const rootOwnerId = "root";
	return {
		root: {
			read: (scope) => coordinator.read(scope),
			acquire: (ownerId, scope, signal) =>
				coordinator.acquire(ownerId, scope, signal),
			release: (ownerId, leaseId) => coordinator.release(ownerId, leaseId),
			cancel: (ownerId) => coordinator.cancelOwner(ownerId),
		},
		client: {
			read: (scope) => coordinator.read(scope),
			acquire: (scope, signal) =>
				coordinator.acquire(rootOwnerId, scope, signal),
			release: (leaseId) => coordinator.release(rootOwnerId, leaseId),
		},
	};
}

/** Selects root-local coordination or the child client supplied by run-subagent. */
function requireHierarchy(
	pi: ExtensionAPI,
	root: KnowledgeHierarchyClient | undefined,
): KnowledgeHierarchyClient {
	const hierarchy = root ?? getKnowledgeHierarchyClient(pi);
	if (hierarchy === undefined) {
		throw new Error("knowledge hierarchy unavailable");
	}
	return hierarchy;
}

/** Resolves exact project and applicable branch scope before any queue acquisition. */
function resolveKnowledgeScope(
	config: KnowledgeConfig,
	resolveProject: (options: ResolveGitProjectOptions) => GitProjectResolution,
	cwd: string,
): ResolvedKnowledgeScope | null {
	const resolution = resolveProject({
		cwd,
		primaryBranches: config.primaryBranches,
		preferredRemotes: config.preferredRemotes,
	});
	if (
		resolution.kind !== "resolved-read-only" &&
		resolution.kind !== "resolved-read-write"
	) {
		return null;
	}
	const projectPaths = createProjectPaths(
		config.dataDir,
		resolution.project.directoryName,
	);
	const branchPaths =
		resolution.kind === "resolved-read-write" && resolution.branch !== null
			? createBranchPaths(projectPaths, resolution.branch.name)
			: null;
	return {
		resolution,
		scope: {
			projectDirectoryName: resolution.project.directoryName,
			branchName: branchPaths?.branchName ?? null,
		},
		projectPaths,
		branchPaths,
	};
}

/** Reads current storage for idle scopes and pre-grant snapshots for active mutation. */
async function readStoredSnapshots(
	owner: KnowledgeOwner,
	config: KnowledgeConfig,
	scope: KnowledgeScope,
): Promise<KnowledgeSnapshots> {
	const projectPaths = createProjectPaths(
		config.dataDir,
		scope.projectDirectoryName,
	);
	const branchPaths =
		scope.branchName === null
			? null
			: createBranchPaths(projectPaths, scope.branchName);
	const [global, local] = await Promise.all([
		owner.read({ scope: "global", path: projectPaths.globalKnowledgeFile }),
		branchPaths === null
			? Promise.resolve(null)
			: owner.read({ scope: "local", path: branchPaths.knowledgeFile }),
	]);
	return { global, local };
}

/** Reports one fixed user-safe failure without exposing runtime inputs. */
function reportSafeFailure(ctx: ExtensionContext, issue: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`[knowledge] ${issue}`, "warning");
	}
}
