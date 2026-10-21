import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentIdMatches } from "../../shared/agent-id";
import {
	type AgentDefinition,
	loadAgentDefinitions,
} from "../../shared/agent-registry";
import { getAgentRegistryWarningReporter } from "../../shared/agent-registry-warnings";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { resolveThinkingLevel } from "../../shared/model-settings";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import { buildSelectedAgentContribution } from "../../shared/selected-agent-contribution";
import { resolveToolPolicy } from "../../shared/tool-policy";
import { resolveWorkflowPolicy } from "../../shared/workflow-policy";
import { resolveAgentModel } from "./agent-policy";
import { errorMessage } from "./error-message";
import type { LaunchGate } from "./launch-gate";

/** CLI flag that runs one subagent definition in a process without a Pi parent. */
export const LAUNCHED_SUBAGENT_FLAG = "subagent";

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

/**
 * Applies the definition named by `--subagent` to the session and fills the selected-agent slot.
 * When Pi cannot apply it, the gate reports the reason and ends the process.
 */
export async function applyLaunchedSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	gate: LaunchGate,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const agentId = composition.getLaunchedSubagentId();
	if (agentId === undefined) {
		return;
	}

	const agentFlag = composition.getAgentFlagId();
	if (agentFlag !== undefined) {
		gate.fail(
			ctx,
			`--agent ${agentFlag} and --subagent ${agentId} name two agents; use one flag`,
		);
		return;
	}

	let issue: string | undefined;
	try {
		issue = await applyNamedDefinition(pi, ctx, agentId);
	} catch (error) {
		issue = `--subagent ${agentId}: ${errorMessage(error)}`;
	}
	if (issue !== undefined) {
		gate.fail(ctx, issue);
	}
}

/** Fails the launch of a process whose run-subagent configuration is disabled, because it cannot apply the definition. */
export function failLaunchWhenDisabled(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	gate: LaunchGate,
	configurationIssue: string | undefined,
): void {
	const agentId = getAgentRuntimeComposition(pi).getLaunchedSubagentId();
	if (agentId === undefined) {
		return;
	}
	const cause =
		configurationIssue === undefined ? "" : `: ${configurationIssue}`;
	gate.fail(
		ctx,
		`--subagent ${agentId}: run-subagent is disabled by its configuration${cause}`,
	);
}

/** Finds and applies the definition that `--subagent` names, and returns why the launch fails, if it does. */
async function applyNamedDefinition(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<string | undefined> {
	const found = await findLaunchedDefinition(pi, ctx, agentId);
	if ("issue" in found) {
		return found.issue;
	}
	const issue = await applyDefinition(pi, ctx, found.agent);
	return issue === undefined ? undefined : `--subagent ${agentId}: ${issue}`;
}

/** Finds the definition of a launched subagent, or names why the ID cannot run. */
async function findLaunchedDefinition(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	agentId: string,
): Promise<{ readonly agent: AgentDefinition } | { readonly issue: string }> {
	const reportWarning = getAgentRegistryWarningReporter(pi, ctx);
	const warnings: string[] = [];
	const definitions = await loadAgentDefinitions(ctx.cwd, (warning) => {
		warnings.push(warning);
		reportWarning(warning);
	});
	const agent = definitions.find((candidate) =>
		agentIdMatches(candidate.id, agentId),
	);
	if (agent === undefined) {
		// The registry skips an invalid file, so its warning is the reason that no definition has the ID.
		const skipped = warnings.filter((warning) =>
			warning.includes(`${agentId}.md`),
		);
		const cause = skipped.length === 0 ? "" : `: ${skipped.join("; ")}`;
		return {
			issue: `--subagent ${agentId}: no valid agent definition has this ID${cause}`,
		};
	}
	if (agent.type === "main") {
		return {
			issue: `--subagent ${agentId}: the definition has type main; --subagent runs only type subagent or both`,
		};
	}
	return { agent };
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
	const credentialIssue = await findCredentialIssue(ctx, model);
	if (credentialIssue !== undefined) {
		return credentialIssue;
	}
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

/**
 * Returns why Pi cannot resolve usable credentials for the model, or undefined when it can.
 * Pi accepts a model without credentials until the first prompt, and a credential command that fails
 * surfaces only at the first request, so the launch resolves the provider credentials itself.
 */
async function findCredentialIssue(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<string | undefined> {
	const name = `${model.provider}/${model.id}`;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
		return auth === undefined ? `model ${name} has no credentials` : undefined;
	} catch (error) {
		return `credentials for model ${name} cannot be resolved: ${errorMessage(error)}`;
	}
}

/** Compares models by provider and ID, as Pi identifies them. */
function isSameModel(
	current: ExtensionContext["model"],
	model: { readonly provider: string; readonly id: string },
): boolean {
	return current?.provider === model.provider && current.id === model.id;
}
