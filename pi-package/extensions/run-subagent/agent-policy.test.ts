import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../shared/agent-registry";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
} from "../../shared/subagent-environment";
import { publishWorkflowCatalogPolicy } from "../../shared/workflow-policy";
import {
	applyChildToolPolicy,
	isAgentAvailableForCaller,
	publishPromptContribution,
	resolveCallerSelectedAgentId,
	resolveEffectiveCallableAgentPolicy,
	resolveLaunchConfiguration,
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
		invocationMetadata: { startedAtMs: 0, elapsedMs: 0 },
		state: "active",
	};
}

describe("effective callable-agent policy", () => {
	test("rejects unknown child workflow policy before auth", async () => {
		// Purpose: child workflow policy must fail before model auth or launch admission side effects.
		// Input and expected output: Missing against Review rejects start and leaves auth call count at zero.
		// Edge case: model and tool policy are otherwise valid, isolating workflow resolution order.
		// Dependencies: shared workflow catalog publication and launch configuration resolution.
		let authCalls = 0;
		const pi = {
			events: {},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;
		publishWorkflowCatalogPolicy(pi, { ids: ["Review"] });
		const agents: readonly AgentDefinition[] = [
			{
				id: "Worker",
				description: "Worker",
				type: "subagent",
				prompt: "Worker prompt",
				workflows: ["Missing"],
			},
		];
		const ctx = {
			cwd: "/tmp/project",
			model: {
				provider: "test",
				id: "model",
				contextWindow: 1000,
			},
			modelRegistry: {
				async getApiKeyAndHeaders() {
					authCalls += 1;
					return { ok: true };
				},
			},
		};

		await expect(
			resolveLaunchConfiguration({
				pi,
				ctx: ctx as never,
				agents,
				supervisor: undefined,
				request: {
					owner: ROOT_OWNER,
					sessionKey: {
						ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
						ownerLocalSessionId: 1,
					},
					agentId: "Worker",
					taskName: "Worker task",
					prompt: "work",
				},
			}),
		).rejects.toThrow("Missing");
		expect(authCalls).toBe(0);
	});

	test("resolves subagent model aliases before launch validation", async () => {
		// Purpose: subagent startup must accept alias model IDs from agent definitions.
		// Input and expected output: model alias `summarizer` resolves to provider/model and contributes alias default thinking.
		// Edge case: caller thinking differs and must be overridden by alias thinking when agent thinking is omitted.
		// Dependencies: suite-owned model-aliases config and launch configuration resolution.
		const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		const suiteDir = mkdtempSync(join(tmpdir(), "run-subagent-model-alias-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
		mkdirSync(join(suiteDir, "model-aliases"), { recursive: true });
		writeFileSync(
			join(suiteDir, "model-aliases", "config.json"),
			JSON.stringify({
				summarizer: {
					id: "provider/model",
					thinking: "low",
				},
			}),
		);
		const pi = {
			getThinkingLevel: () => "high",
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/tmp/project",
			model: {
				provider: "current",
				id: "model",
				contextWindow: 1000,
			},
			modelRegistry: {
				find(provider: string, id: string) {
					if (provider === "provider" && id === "model") {
						return {
							provider,
							id,
							contextWindow: 32000,
						};
					}
					return undefined;
				},
				hasConfiguredAuth: () => true,
				async getApiKeyAndHeaders() {
					return { ok: true };
				},
			},
		};
		const agents: readonly AgentDefinition[] = [
			{
				id: "Worker",
				description: "Worker",
				type: "subagent",
				prompt: "Worker prompt",
				model: { id: "summarizer" },
			},
		];
		try {
			expect(
				await resolveLaunchConfiguration({
					pi,
					ctx: ctx as never,
					agents,
					supervisor: undefined,
					request: {
						owner: ROOT_OWNER,
						sessionKey: {
							ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
							ownerLocalSessionId: 1,
						},
						agentId: "Worker",
						taskName: "Worker task",
						prompt: "work",
					},
				}),
			).toMatchObject({
				modelId: "provider/model",
				provider: "provider",
				thinking: "low",
				runtimeFacts: {
					modelProvider: "provider",
					modelId: "model",
					contextWindow: 32000,
				},
			});
		} finally {
			if (previousSuiteDir === undefined) {
				delete process.env[AGENT_SUITE_DIR_ENV];
			} else {
				process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
			}
			rmSync(suiteDir, { recursive: true, force: true });
		}
	});

	test("reports only the unmatched child tool pattern", () => {
		// Purpose: child startup errors must state the actionable pattern mismatch without an internal subsystem prefix.
		// Input and expected output: obsolete run_subagent against one subagent tool throws the shared policy issue verbatim.
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

	test("removes subagent tools and guidance at maxDepth", async () => {
		// Purpose: an agent that cannot create descendants must not receive unusable subagent tools or guidance.
		// Input and expected output: a boundary-depth owner loses all subagent tools and contributes no subagent prompt sections.
		// Edge case: prompt composition runs after depth filtering removes the complete subagent tool family.
		// Dependencies: production runtime composition and subagent active-tool policy.
		const previousDepth = process.env[SUBAGENT_DEPTH_ENV];
		const previousAgentId = process.env[SUBAGENT_AGENT_ID_ENV];
		process.env[SUBAGENT_DEPTH_ENV] = "1";
		delete process.env[SUBAGENT_AGENT_ID_ENV];
		let activeTools = [
			"subagent_start",
			"subagent_steer",
			"subagent_wait",
			"subagent_query",
		];
		let beforeAgentStart:
			| ((event: unknown, ctx: unknown) => Promise<unknown>)
			| undefined;
		const pi = {
			events: { emit: () => undefined },
			on: (eventName: string, handler: typeof beforeAgentStart) => {
				if (eventName === "before_agent_start") {
					beforeAgentStart = handler;
				}
			},
			getActiveTools: () => [...activeTools],
			setActiveTools: (toolNames: string[]) => {
				activeTools = [...toolNames];
			},
		} as unknown as ExtensionAPI;
		try {
			publishPromptContribution(pi, 1, "Shared extension guidance");
			if (beforeAgentStart === undefined) {
				throw new Error("runtime composition handler was not registered");
			}
			const result = (await beforeAgentStart(
				{ systemPrompt: "Base" },
				{ cwd: "/tmp" },
			)) as { readonly systemPrompt?: string } | undefined;
			expect({ activeTools, result }).toEqual({
				activeTools: [],
				result: undefined,
			});
		} finally {
			if (previousDepth === undefined) {
				delete process.env[SUBAGENT_DEPTH_ENV];
			} else {
				process.env[SUBAGENT_DEPTH_ENV] = previousDepth;
			}
			if (previousAgentId === undefined) {
				delete process.env[SUBAGENT_AGENT_ID_ENV];
			} else {
				process.env[SUBAGENT_AGENT_ID_ENV] = previousAgentId;
			}
		}
	});

	test("omits extension guidance when no Subagents tool is active", async () => {
		// Purpose: shared guidance must not consume model context for agents that cannot use Subagents.
		// Input and expected output: an owner with only read receives no Subagents prompt contribution.
		// Edge case: callable agent definitions remain available in the registry but no subagent tool is active.
		// Dependencies: production runtime composition and Subagents active-tool policy.
		const previousAgentId = process.env[SUBAGENT_AGENT_ID_ENV];
		delete process.env[SUBAGENT_AGENT_ID_ENV];
		let beforeAgentStart:
			| ((event: unknown, ctx: unknown) => Promise<unknown>)
			| undefined;
		const pi = {
			events: { emit: () => undefined },
			on: (eventName: string, handler: typeof beforeAgentStart) => {
				if (eventName === "before_agent_start") {
					beforeAgentStart = handler;
				}
			},
			getActiveTools: () => ["read"],
			setActiveTools: () => undefined,
		} as unknown as ExtensionAPI;
		try {
			publishPromptContribution(pi, 1, "Shared extension guidance");
			if (beforeAgentStart === undefined) {
				throw new Error("runtime composition handler was not registered");
			}
			expect(
				await beforeAgentStart({ systemPrompt: "Base" }, { cwd: "/tmp" }),
			).toBeUndefined();
		} finally {
			if (previousAgentId === undefined) {
				delete process.env[SUBAGENT_AGENT_ID_ENV];
			} else {
				process.env[SUBAGENT_AGENT_ID_ENV] = previousAgentId;
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
