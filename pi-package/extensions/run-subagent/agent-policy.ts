import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { escapeUTF8 } from "entities";
import { agentIdMatches } from "../../shared/agent-id";
import {
	type AgentDefinition,
	loadAgentDefinitions,
} from "../../shared/agent-registry";
import {
	getAgentRuntimeComposition,
	type MainAgentRuntimeInfo,
} from "../../shared/agent-runtime-composition";
import { writeRuntimeDiagnostic } from "../../shared/agent-runtime-diagnostics";
import { resolveToolPolicy } from "../../shared/tool-policy";
import { resolveWorkflowPolicy } from "../../shared/workflow-policy";
import {
	AVAILABLE_SUBAGENTS_PROMPT_CLOSING_TAG,
	AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG,
	SUBAGENT_TOOL_NAMES,
} from "./contracts";
import type { OwnerIdentity } from "./domain";
import { readCurrentDepth } from "./entry-config";
import { readSubagentAgentId, readSubagentToolPatterns } from "./environment";
import {
	type InvocationLaunchConfiguration,
	InvocationStartError,
	type NewInvocationRequest,
} from "./invocation-contracts";
import type { InvocationSupervisor } from "./invocation-supervisor";
import type { SessionCatalogQuery } from "./session-catalog";

const SUBAGENT_TOOL_NAME_SET = new Set<string>(SUBAGENT_TOOL_NAMES);
/** Delimits shared Subagents rules inside composed system prompts. */
const SUBAGENT_TOOLS_GUIDELINES_MARKER = "<subagent_tools_guidelines>";

interface ResolveLaunchOptions {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly agents: readonly AgentDefinition[];
	readonly supervisor: InvocationSupervisor | undefined;
	readonly request: NewInvocationRequest;
}

/** Resolves one agent's model, thinking, depth, and tool policy before spawn. */
export async function resolveLaunchConfiguration(
	options: ResolveLaunchOptions,
): Promise<InvocationLaunchConfiguration> {
	const { pi, ctx, agents, supervisor, request } = options;
	const agent = agents.find((candidate) =>
		agentIdMatches(candidate.id, request.agentId),
	);
	if (agent === undefined) {
		throw new InvocationStartError(
			"start_failed",
			`Subagent ${request.agentId} is unavailable`,
		);
	}
	const workflows = resolveWorkflowPolicy(pi, agent.workflows);
	if (workflows.kind === "error") {
		throw new InvocationStartError("start_failed", workflows.issue);
	}
	const model = resolveAgentModel(agent, ctx);
	// Model registration and credential resolution are separate facts during OAuth file contention.
	const providerConfigured = ctx.modelRegistry.hasConfiguredAuth(model);
	const parentDepth =
		request.ownerRuntimeLeaseId === undefined
			? readCurrentDepth()
			: (supervisor?.findRuntimeDepth(request.ownerRuntimeLeaseId) ??
				readCurrentDepth());
	return {
		cwd: ctx.cwd,
		modelId: `${model.provider}/${model.id}`,
		provider: model.provider,
		thinking: agent.model?.thinking ?? pi.getThinkingLevel(),
		...(agent.tools === undefined ? {} : { toolPatterns: agent.tools }),
		...(workflows.policy === undefined
			? {}
			: { workflowIds: workflows.policy }),
		depth: parentDepth + 1,
		providerConfigured,
		checkParentAuth: async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			return auth.ok ? { ok: true } : { ok: false, error: auth.error };
		},
		runtimeFacts: {
			modelProvider: model.provider,
			modelId: model.id,
			contextWindow: model.contextWindow,
		},
	};
}

/** Resolves a configured agent model or the current owner model through public registry APIs. */
function resolveAgentModel(
	agent: AgentDefinition,
	ctx: ExtensionContext,
): Model<Api> {
	const configured = agent.model?.id;
	if (configured === undefined) {
		if (ctx.model === undefined) {
			throw new InvocationStartError(
				"start_failed",
				"no model is available for the child invocation",
			);
		}
		return ctx.model;
	}
	const separator = configured.indexOf("/");
	if (separator <= 0 || separator === configured.length - 1) {
		throw new InvocationStartError(
			"start_failed",
			`agent model ${configured} is invalid`,
		);
	}
	const provider = configured.slice(0, separator);
	const id = configured.slice(separator + 1);
	const model = ctx.modelRegistry.find(provider, id);
	if (model === undefined) {
		throw new InvocationStartError(
			"start_failed",
			`agent model ${configured} is unavailable`,
		);
	}
	return model;
}

/** Publishes depth-aware subagent tools and callable-agent guidance after policy filtering. */
export function publishPromptContribution(
	pi: ExtensionAPI,
	maxDepth: number,
	extensionDescription: string,
): void {
	const composition = getAgentRuntimeComposition(pi);
	composition.setSubagentsContribution({
		buildPrompt: async (activeToolNames, cwd) =>
			buildSubagentsPrompt({
				activeToolNames,
				agents: await loadCallableAgents(cwd),
				mainAgent: composition.getMainAgentContribution()?.agent,
				selectedAgentId: readSubagentAgentId(),
				depth: readCurrentDepth(),
				maxDepth,
				extensionDescription,
			}),
	});
	composition.setSubagentsActiveToolFilter((toolNames) =>
		filterSubagentTools(
			toolNames,
			composition.getMainAgentContribution()?.agent,
			readCurrentDepth(),
			maxDepth,
		),
	);
}

/** Carries the selected definition and the callable global subset it permits. */
interface EffectiveCallableAgentPolicy {
	readonly selectedAgent: AgentDefinition | undefined;
	readonly callableAgents: readonly AgentDefinition[];
}

/** Carries one runtime authorization decision through the shared policy resolver. */
interface AgentAvailabilityOptions {
	readonly agents: readonly AgentDefinition[];
	readonly mainAgent: MainAgentRuntimeInfo | undefined;
	readonly rootOwner: OwnerIdentity;
	readonly caller: OwnerIdentity;
	readonly catalog: SessionCatalogQuery;
	readonly rootSelectedAgentId: string | undefined;
	readonly requestedAgentId: string;
}

/** Resolves the selected caller policy and its globally defined callable subset. */
export function resolveEffectiveCallableAgentPolicy(
	agents: readonly AgentDefinition[],
	mainAgent: MainAgentRuntimeInfo | undefined,
	selectedAgentId: string | undefined,
): EffectiveCallableAgentPolicy {
	const selectedAgent =
		selectedAgentId === undefined
			? undefined
			: agents.find((agent) => agentIdMatches(agent.id, selectedAgentId));
	const allowedAgentIds = (selectedAgent ?? mainAgent)?.agents;
	const callableAgents =
		allowedAgentIds === undefined
			? agents
			: agents.filter((agent) =>
					allowedAgentIds.some((id) => agentIdMatches(id, agent.id)),
				);
	return { selectedAgent, callableAgents };
}

/** Checks one requested agent against the direct caller's effective policy. */
export function isAgentAvailableForCaller(
	options: AgentAvailabilityOptions,
): boolean {
	const selectedAgentId = resolveCallerSelectedAgentId(
		options.rootOwner,
		options.caller,
		options.catalog,
		options.rootSelectedAgentId,
	);
	if (
		options.caller.ownerPiSessionId !== options.rootOwner.ownerPiSessionId &&
		selectedAgentId === undefined
	) {
		return false;
	}
	return resolveEffectiveCallableAgentPolicy(
		options.agents,
		options.mainAgent,
		selectedAgentId,
	).callableAgents.some((agent) =>
		agentIdMatches(agent.id, options.requestedAgentId),
	);
}

/** Resolves the selected agent that defines one direct caller's nested policy. */
export function resolveCallerSelectedAgentId(
	rootOwner: OwnerIdentity,
	caller: OwnerIdentity,
	catalog: SessionCatalogQuery,
	rootSelectedAgentId: string | undefined,
): string | undefined {
	if (caller.ownerPiSessionId === rootOwner.ownerPiSessionId) {
		return rootSelectedAgentId;
	}
	const pendingOwners: OwnerIdentity[] = [rootOwner];
	const visitedOwnerIds = new Set<string>();
	while (pendingOwners.length > 0) {
		const directOwner = pendingOwners.shift();
		if (
			directOwner === undefined ||
			visitedOwnerIds.has(directOwner.ownerPiSessionId)
		) {
			continue;
		}
		visitedOwnerIds.add(directOwner.ownerPiSessionId);
		for (const session of catalog.list(directOwner)) {
			if (session.childPiSessionId === caller.ownerPiSessionId) {
				return session.agentId;
			}
			pendingOwners.push({
				ownerPiSessionId: session.childPiSessionId,
				ownerSessionFile: session.childSessionFile,
			});
		}
	}
	return undefined;
}

interface BuildSubagentsPromptOptions {
	readonly activeToolNames: readonly string[];
	readonly agents: readonly AgentDefinition[];
	readonly mainAgent: MainAgentRuntimeInfo | undefined;
	readonly selectedAgentId: string | undefined;
	readonly depth: number;
	readonly maxDepth: number;
	readonly extensionDescription: string;
}

/** Builds guidance only from runtime-read subagent identifiers and policy facts. */
function buildSubagentsPrompt(
	options: BuildSubagentsPromptOptions,
): string | undefined {
	const {
		activeToolNames,
		agents,
		mainAgent,
		selectedAgentId,
		depth,
		maxDepth,
		extensionDescription,
	} = options;
	const policy = resolveEffectiveCallableAgentPolicy(
		agents,
		mainAgent,
		selectedAgentId,
	);
	const promptParts = policy.selectedAgent?.prompt
		? [policy.selectedAgent.prompt]
		: [];
	const activeSubagentTools = activeToolNames.filter((name) =>
		SUBAGENT_TOOL_NAME_SET.has(name),
	);
	if (activeSubagentTools.length === 0) {
		return promptParts.length === 0 ? undefined : promptParts.join("\n\n");
	}
	promptParts.push(
		[
			SUBAGENT_TOOLS_GUIDELINES_MARKER,
			extensionDescription,
			SUBAGENT_TOOLS_GUIDELINES_MARKER.replace("<", "</"),
		].join("\n"),
	);
	const hasCallableAgentGuidance =
		activeSubagentTools.includes("subagent_start") && depth < maxDepth;
	if (hasCallableAgentGuidance) {
		promptParts.push(
			[
				AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG,
				...policy.callableAgents.map(
					(agent) =>
						`<agent id="${escapeUTF8(agent.id)}">\n${escapeUTF8(agent.description)}\n</agent>`,
				),
				AVAILABLE_SUBAGENTS_PROMPT_CLOSING_TAG,
			].join("\n"),
		);
	}
	writeRuntimeDiagnostic("subagents.prompt.build.applied", {
		selectedAgentId: policy.selectedAgent?.id ?? null,
		depth,
		maxDepth,
		activeSubagentTools,
		callableAgentIds: hasCallableAgentGuidance
			? policy.callableAgents.map((agent) => agent.id)
			: [],
	});
	return promptParts.join("\n\n");
}

/** Filters all three subagent tools through depth and selected-agent policy. */
function filterSubagentTools(
	toolNames: readonly string[],
	mainAgent: MainAgentRuntimeInfo | undefined,
	depth: number,
	maxDepth: number,
): readonly string[] {
	const depthFiltered =
		depth >= maxDepth
			? toolNames.filter((name) => !SUBAGENT_TOOL_NAME_SET.has(name))
			: toolNames;
	if (mainAgent?.tools === undefined) {
		return depthFiltered;
	}
	return depthFiltered.filter(
		(name) =>
			!SUBAGENT_TOOL_NAME_SET.has(name) || mainAgent.tools?.includes(name),
	);
}

/** Applies the independently transported child tool policy to final active tools. */
export function applyChildToolPolicy(pi: ExtensionAPI): void {
	const policy = readSubagentToolPatterns();
	if ("issue" in policy) {
		pi.setActiveTools([]);
		throw new Error(policy.issue);
	}
	if (policy.patterns === undefined) {
		return;
	}
	const result = resolveToolPolicy(
		policy.patterns,
		pi.getAllTools().map((tool) => tool.name),
	);
	if ("issue" in result) {
		pi.setActiveTools([]);
		throw new Error(result.issue);
	}
	pi.setActiveTools([...result.tools]);
}

/** Loads only definitions that can act as callable subagents. */
export async function loadCallableAgents(
	cwd: string,
): Promise<AgentDefinition[]> {
	return (await loadAgentDefinitions(cwd)).filter(
		(agent) => agent.type === "subagent" || agent.type === "both",
	);
}
