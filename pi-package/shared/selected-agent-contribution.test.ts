import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "./agent-registry";
import { buildSelectedAgentContribution } from "./selected-agent-contribution";

/** Creates a definition with only the fields that a test sets. */
function createAgent(fields: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		id: "Worker",
		description: "Worker",
		type: "both",
		prompt: "Worker prompt",
		...fields,
	};
}

describe("selected-agent contribution", () => {
	test("omits each policy that the definition leaves unrestricted", () => {
		// Purpose: an omitted policy means no restriction, so no field may appear for it.
		// Input and expected output: a definition without tools, workflows, agents, and model gives only the prompt and the ID.
		// Edge case: the resolved workflow policy is undefined.
		// Dependencies: none.
		expect(
			buildSelectedAgentContribution(createAgent(), {
				workflows: undefined,
			}),
		).toEqual({ prompt: "Worker prompt", agent: { id: "Worker" } });
	});

	test("keeps empty policies as empty lists", () => {
		// Purpose: an empty list restricts to nothing, which differs from an omitted policy.
		// Input and expected output: empty tools, workflows, and agents stay present as empty lists.
		// Edge case: all three lists are empty at once.
		// Dependencies: none.
		expect(
			buildSelectedAgentContribution(createAgent({ agents: [] }), {
				tools: [],
				workflows: [],
			}),
		).toEqual({
			prompt: "Worker prompt",
			agent: { id: "Worker", tools: [], workflows: [], agents: [] },
			tools: [],
		});
	});

	test("carries resolved policies, callable agents, and model", () => {
		// Purpose: the contribution holds what the definition and its resolved policies give to the runtime.
		// Input and expected output: resolved tools and workflows replace the configured patterns; agents and model pass through.
		// Edge case: configured tool patterns differ from the resolved tool names.
		// Dependencies: none.
		expect(
			buildSelectedAgentContribution(
				createAgent({
					tools: ["subagent_*"],
					agents: ["Helper"],
					model: { id: "provider/model", thinking: "high" },
				}),
				{ tools: ["subagent_start"], workflows: ["Review"] },
			),
		).toEqual({
			prompt: "Worker prompt",
			agent: {
				id: "Worker",
				tools: ["subagent_start"],
				workflows: ["Review"],
				agents: ["Helper"],
			},
			model: { id: "provider/model", thinking: "high" },
			tools: ["subagent_start"],
		});
	});
});
