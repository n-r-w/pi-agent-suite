import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentIdMatches } from "../../shared/agent-id";
import type { AgentDefinition } from "../../shared/agent-registry";
import { getAgentRegistryWarningReporter } from "../../shared/agent-registry-warnings";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { resolveThinkingLevel } from "../../shared/model-settings";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import { buildSelectedAgentContribution } from "../../shared/selected-agent-contribution";
import { resolveToolPolicy } from "../../shared/tool-policy";
import { resolveWorkflowPolicy } from "../../shared/workflow-policy";
import { loadCallableAgents, resolveAgentModel } from "./agent-policy";
import { errorMessage } from "./error-message";

/** CLI flag that runs one subagent definition in a process without a Pi parent. */
export const LAUNCHED_SUBAGENT_FLAG = "subagent";

/** Prefix of issues that the launch of a subagent reports. */
const ISSUE_PREFIX = "[subagents]";

/**
 * Registers flag `--subagent` and shares its value through the composition.
 * Pi shows a flag value only to the extension that registered it, so
 * main-agent-selection and system-prompt read it through the composition.
 */
export function registerLaunchedSubagentFlag(pi: ExtensionAPI): void {
	pi.registerFlag(LAUNCHED_SUBAGENT_FLAG, {
		description:
			"Run a subagent definition by ID with its prompt, model, tools, workflows, and callable subagents",
		type: "string",
	});
	getAgentRuntimeComposition(pi).setLaunchedSubagentResolver(() => {
		const value = pi.getFlag(LAUNCHED_SUBAGENT_FLAG);
		return typeof value === "string" ? value : undefined;
	});
}

/** Applies the definition named by `--subagent` to the session and fills the selected-agent slot. */
export async function applyLaunchedSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const agentId = composition.getLaunchedSubagentId();
	if (agentId === undefined) {
		return;
	}

	const agents = await loadCallableAgents(
		ctx.cwd,
		getAgentRegistryWarningReporter(pi, ctx),
	);
	const agent = agents.find((candidate) =>
		agentIdMatches(candidate.id, agentId),
	);
	if (agent === undefined) {
		reportIssue(ctx, `subagent ${agentId} was not found`);
		return;
	}

	const issue = await applyDefinition(pi, ctx, agent);
	if (issue !== undefined) {
		reportIssue(ctx, issue);
	}
}

/** Applies policies, model, and thinking, and returns the first issue without a partial change. */
async function applyDefinition(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentDefinition,
): Promise<string | undefined> {
	const workflows = resolveWorkflowPolicy(agent.workflows);
	if (workflows.kind === "error") {
		return workflows.issue;
	}
	const tools =
		agent.tools === undefined
			? undefined
			: resolveToolPolicy(
					agent.tools,
					pi.getAllTools().map((tool) => tool.name),
				);
	if (tools !== undefined && "issue" in tools) {
		return tools.issue;
	}

	// Model and thinking follow the rules that run-subagent applies to a child.
	const target = resolveModelAndThinking(pi, ctx, agent);
	if ("issue" in target) {
		return target.issue;
	}
	const { model, thinking } = target;
	if (!isSameModel(ctx.model, model) && !(await pi.setModel(model))) {
		return `model ${model.provider}/${model.id} could not be applied`;
	}
	if (pi.getThinkingLevel() !== thinking) {
		pi.setThinkingLevel(thinking);
		if (pi.getThinkingLevel() !== thinking) {
			return `thinking level ${thinking} could not be applied`;
		}
	}

	getAgentRuntimeComposition(pi).setSelectedAgentContribution(
		buildSelectedAgentContribution(agent, {
			...(tools === undefined ? {} : { tools: tools.tools }),
			workflows: workflows.policy,
		}),
	);
	return undefined;
}

/** Resolves the model and the thinking level of a child before any change of the session. */
function resolveModelAndThinking(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agent: AgentDefinition,
):
	| { readonly model: Model<Api>; readonly thinking: ReasoningLevel }
	| { readonly issue: string } {
	try {
		const resolved = resolveAgentModel(agent, ctx);
		return {
			model: resolved.model,
			thinking: resolveThinkingLevel(
				resolved.model,
				resolved.thinking ?? pi.getThinkingLevel(),
			),
		};
	} catch (error) {
		return { issue: errorMessage(error) };
	}
}

/** Compares models by provider and ID, as Pi identifies them. */
function isSameModel(
	current: ExtensionContext["model"],
	model: { readonly provider: string; readonly id: string },
): boolean {
	return current?.provider === model.provider && current.id === model.id;
}

/** Reports a visible issue scoped to the launch of a subagent. */
function reportIssue(ctx: ExtensionContext, issue: string): void {
	if (ctx.hasUI === false) {
		process.stderr.write(`${ISSUE_PREFIX} ${issue}\n`);
		return;
	}
	ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}
