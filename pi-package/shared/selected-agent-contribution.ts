import type { AgentDefinition } from "./agent-registry";
import type { SelectedAgentContribution } from "./agent-runtime-composition";
import type { ResolvedWorkflowPolicy } from "./workflow-policy";

/** Policies of a definition after they were resolved against the runtime catalogs. */
export interface ResolvedAgentPolicies {
	/** Tool names that the definition allows; absent when the definition sets no tool list. */
	readonly tools?: readonly string[];
	/** Workflow IDs that the definition allows to activate; absent when the definition sets no workflow list. */
	readonly workflows: ResolvedWorkflowPolicy;
}

/** Builds the selected-agent contribution of a definition; an omitted policy stays absent and an empty list stays empty. */
export function buildSelectedAgentContribution(
	agent: AgentDefinition,
	policies: ResolvedAgentPolicies,
): SelectedAgentContribution {
	return {
		prompt: agent.prompt,
		agent: {
			id: agent.id,
			...(policies.tools === undefined ? {} : { tools: policies.tools }),
			...(policies.workflows === undefined
				? {}
				: { workflows: policies.workflows }),
			...(agent.agents === undefined ? {} : { agents: agent.agents }),
		},
		...(agent.model === undefined ? {} : { model: agent.model }),
		...(policies.tools === undefined ? {} : { tools: policies.tools }),
	};
}
