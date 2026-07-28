import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../shared/agent-registry";
import { SUBAGENT_TOOL_PATTERNS_ENV } from "../../shared/subagent-environment";
import {
	applyChildToolPolicy,
	isAgentAvailableForCaller,
	resolveCallerSelectedAgentId,
	resolveEffectiveCallableAgentPolicy,
} from "./agent-policy";
import type { LogicalSession, OwnerIdentity } from "./domain";
import { SessionCatalog } from "./session-catalog";

const ROOT_OWNER: OwnerIdentity = {
	ownerPiSessionId: "root-owner",
	ownerSessionFile: "/tmp/root-owner.jsonl",
};
const NESTED_OWNER: OwnerIdentity = {
	ownerPiSessionId: "nested-owner",
	ownerSessionFile: "/tmp/nested-owner.jsonl",
};
const AGENTS: readonly AgentDefinition[] = [
	{
		id: "Allowed",
		description: "Allowed",
		type: "subagent",
		prompt: "Allowed prompt",
	},
	{
		id: "Blocked",
		description: "Blocked",
		type: "subagent",
		prompt: "Blocked prompt",
	},
	{
		id: "Parent",
		description: "Parent",
		type: "subagent",
		prompt: "Parent prompt",
		agents: ["Allowed"],
	},
];

/** Creates the accepted session whose selected agent defines the nested owner's policy. */
function parentSession(): LogicalSession {
	return {
		key: {
			ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
		},
		childPiSessionId: NESTED_OWNER.ownerPiSessionId,
		childSessionDir: "/tmp/nested-owner",
		childSessionFile: NESTED_OWNER.ownerSessionFile,
		agentId: "Parent",
		taskName: "Parent task",
		creationOrder: 1,
		invocationId: "parent-invocation",
		runtimeLeaseId: "parent-lease",
		state: "active",
	};
}

describe("effective callable-agent policy", () => {
	test("reports only the unmatched child tool pattern", () => {
		// Purpose: child startup errors must state the actionable pattern mismatch without an internal subsystem prefix.
		// Input and expected output: obsolete run_subagent against one V2 tool throws the shared policy issue verbatim.
		// Edge case: active tools are cleared before the invalid policy escapes.
		// Dependencies: child tool-pattern environment parsing and public ExtensionAPI tool selection.
		const previous = process.env[SUBAGENT_TOOL_PATTERNS_ENV];
		const activeTools: string[][] = [];
		process.env[SUBAGENT_TOOL_PATTERNS_ENV] = JSON.stringify(["run_subagent"]);
		try {
			let message = "";
			try {
				applyChildToolPolicy({
					getAllTools: () => [{ name: "subagent_start" }],
					setActiveTools: (names: string[]) => activeTools.push(names),
				} as unknown as ExtensionAPI);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect({ message, activeTools }).toEqual({
				message: "tool pattern run_subagent did not match any available tool",
				activeTools: [[]],
			});
		} finally {
			if (previous === undefined) {
				delete process.env[SUBAGENT_TOOL_PATTERNS_ENV];
			} else {
				process.env[SUBAGENT_TOOL_PATTERNS_ENV] = previous;
			}
		}
	});

	test("uses one resolver for top-level and nested owner allowlists", () => {
		// Purpose: prompt and runtime consumers must receive the same callable subset for each direct owner.
		// Input and expected output: top-level Main and nested Parent both allow only Allowed, despite a conflicting main policy for nested work.
		// Edge case: the nested selected agent is derived from the accepted parent session rather than root process environment.
		// Dependencies: production policy resolvers and live session catalog hierarchy.
		// Arrange.
		const catalog = new SessionCatalog();
		catalog.add(parentSession());

		// Act.
		const topSelectedAgentId = resolveCallerSelectedAgentId(
			ROOT_OWNER,
			ROOT_OWNER,
			catalog,
			undefined,
		);
		const nestedSelectedAgentId = resolveCallerSelectedAgentId(
			ROOT_OWNER,
			NESTED_OWNER,
			catalog,
			undefined,
		);
		const topPolicy = resolveEffectiveCallableAgentPolicy(
			AGENTS,
			{ id: "Main", agents: ["Allowed"] },
			topSelectedAgentId,
		);
		const nestedPolicy = resolveEffectiveCallableAgentPolicy(
			AGENTS,
			{ id: "Main", agents: ["Blocked"] },
			nestedSelectedAgentId,
		);
		const availability = {
			topAllowed: isAgentAvailableForCaller({
				agents: AGENTS,
				mainAgent: { id: "Main", agents: ["Allowed"] },
				rootOwner: ROOT_OWNER,
				caller: ROOT_OWNER,
				catalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Allowed",
			}),
			topBlocked: isAgentAvailableForCaller({
				agents: AGENTS,
				mainAgent: { id: "Main", agents: ["Allowed"] },
				rootOwner: ROOT_OWNER,
				caller: ROOT_OWNER,
				catalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Blocked",
			}),
			nestedAllowed: isAgentAvailableForCaller({
				agents: AGENTS,
				mainAgent: { id: "Main", agents: ["Blocked"] },
				rootOwner: ROOT_OWNER,
				caller: NESTED_OWNER,
				catalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Allowed",
			}),
			nestedBlocked: isAgentAvailableForCaller({
				agents: AGENTS,
				mainAgent: { id: "Main", agents: ["Blocked"] },
				rootOwner: ROOT_OWNER,
				caller: NESTED_OWNER,
				catalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Blocked",
			}),
		};

		// Assert.
		expect({
			topSelectedAgentId,
			topCallable: topPolicy.callableAgents.map((agent) => agent.id),
			nestedSelectedAgentId,
			nestedCallable: nestedPolicy.callableAgents.map((agent) => agent.id),
			availability,
		}).toEqual({
			topSelectedAgentId: undefined,
			topCallable: ["Allowed"],
			nestedSelectedAgentId: "Parent",
			nestedCallable: ["Allowed"],
			availability: {
				topAllowed: true,
				topBlocked: false,
				nestedAllowed: true,
				nestedBlocked: false,
			},
		});
	});
});
