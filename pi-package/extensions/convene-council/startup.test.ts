import { describe, expect, test } from "bun:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { createModel } from "../../../test/extensions/convene-council/support/models";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import {
	buildChildParticipantStartup,
	resolveChildStartupPlan,
	resolveCouncilToolArgsForNames,
} from "./startup";
import type { ConveneCouncilConfig, ParticipantRuntime } from "./types";

const baseConfig: ConveneCouncilConfig = {
	llm1: {},
	llm2: {},
	participantIterationLimit: 3,
	finalAnswerParticipant: "llm2",
	responseDefectRetries: 1,
	tools: undefined,
};

/** Creates the participant runtime used by startup resolver tests. */
function createRuntime(): ParticipantRuntime {
	return { model: createModel("openai", "model-a"), thinking: "medium" };
}

/** Creates the minimal tool registry used by tool-policy tests. */
function createPi(toolNames: readonly string[]) {
	return {
		getAllTools: (): ToolInfo[] =>
			toolNames.map((name) => ({
				name,
				description: name,
				parameters: {},
				exposure: "direct",
				sourceInfo: {
					path: `<test:${name}>`,
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
			})),
	};
}

describe("convene-council child startup", () => {
	test.each([
		{
			tools: undefined,
			allowed: "read",
			excluded:
				"mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
		},
		{
			tools: [],
			allowed: "read",
			excluded:
				"mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
		},
		{
			tools: ["codemode"],
			allowed: "read,codemode",
			excluded:
				"mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
		},
		{
			tools: ["codemode", "mcp__fixture__echo"],
			allowed: "read,codemode,mcp__fixture__echo",
			excluded:
				"list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
		},
		{
			tools: ["codemode", "list_mcp_resources"],
			allowed: "read,codemode,list_mcp_resources",
			excluded: "mcp__*,list_mcp_resource_templates,read_mcp_resource",
		},
	])("restricts native MCP tools for $allowed", ({
		tools,
		allowed,
		excluded,
	}) => {
		expect(
			resolveCouncilToolArgsForNames({ ...baseConfig, tools }, [
				"read",
				"codemode",
				"mcp__fixture__echo",
				"mcp__fixture__other",
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
			]),
		).toEqual({ args: ["--tools", allowed, "--exclude-tools", excluded] });
	});
	test("preserves reproducible extension flags and documented Pi environment", () => {
		// Purpose: child startup must use direct CLI/env inputs instead of inferred source metadata.
		// Input and expected output: extension flags and Pi env keys are preserved in startup plan.
		// Edge case: no-extensions is preserved together with explicit extension paths.
		// Dependencies: pure argument and environment parsing.
		const plan = resolveChildStartupPlan({
			argv: ["--no-extensions", "-e", "./pi-package"],
			env: {
				PI_PACKAGE_DIR: "/tmp/pi-package-dir",
				PI_CODING_AGENT_DIR: "/tmp/pi-agent-dir",
				OTHER_ENV: "ignored",
			},
		});

		expect(plan).toEqual({
			extensionArgs: ["--no-extensions", "-e", "./pi-package"],
			env: {
				PI_PACKAGE_DIR: "/tmp/pi-package-dir",
				PI_CODING_AGENT_DIR: "/tmp/pi-agent-dir",
			},
		});
	});

	test("fails before session creation when extension flags are not reproducible", () => {
		// Purpose: malformed parent extension flags must stop before temporary roots are created.
		// Input and expected output: missing -e value returns a startup issue.
		// Edge case: a following flag is not accepted as an extension path.
		// Dependencies: pure argument parsing.
		expect(resolveChildStartupPlan({ argv: ["-e", "--no-tools"] })).toEqual({
			issue: "child startup cannot reproduce parent extension loading",
		});
	});

	test("builds participant args with session, model, tools, disabled resources, and system prompt", () => {
		// Purpose: child participants must start with stable parent-built prompt and no child-side resources.
		// Input and expected output: configured tool patterns become identical --tools flags.
		// Edge case: child uses --session and --session-dir together for explicit session ownership.
		// Dependencies: shared tool-policy resolver and pure argument builder.
		const startup = buildChildParticipantStartup({
			plan: {
				extensionArgs: ["-e", "./pi-package"],
				env: { PI_CODING_AGENT_DIR: "/tmp/pi-agent" },
			},
			config: { ...baseConfig, tools: ["rea*"] },
			pi: createPi(["read", "write"]),
			runtime: createRuntime(),
			sessionFile: "/tmp/session/llm1.jsonl",
			sessionDir: "/tmp/session",
			systemPrompt: "participant prompt",
		});

		expect(startup).toEqual({
			env: {
				[CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE,
				PI_CODING_AGENT_DIR: "/tmp/pi-agent",
			},
			args: [
				"--mode",
				"rpc",
				"--session",
				"/tmp/session/llm1.jsonl",
				"--session-dir",
				"/tmp/session",
				"--model",
				"openai/model-a",
				"--thinking",
				"medium",
				"--system-prompt",
				"participant prompt",
				"--no-context-files",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"-e",
				"./pi-package",
				"--tools",
				"read",
				"--exclude-tools",
				"mcp__*,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource",
			],
		});
	});

	test("always enables read for missing and empty tools", () => {
		// Purpose: participants must be able to read the temporary context file even without configured tools.
		// Input and expected output: both missing and empty tools produce --tools read.
		// Edge case: empty list disables additional tools only, not the mandatory read tool.
		// Dependencies: pure child argument builder.
		for (const tools of [undefined, []] as const) {
			const startup = buildChildParticipantStartup({
				plan: { extensionArgs: [], env: {} },
				config: { ...baseConfig, tools },
				pi: createPi(["read"]),
				runtime: createRuntime(),
				sessionFile: "/tmp/session/llm1.jsonl",
				sessionDir: "/tmp/session",
				systemPrompt: "participant prompt",
			});

			expect("args" in startup ? startup.args.slice(-4, -2) : startup).toEqual([
				"--tools",
				"read",
			]);
		}
	});

	test("rejects missing read, unrestricted patterns, and unmatched tool patterns", () => {
		// Purpose: council tool policy must require read and reuse shared wildcard validation without unrelated tool-name exceptions.
		// Input and expected output: missing read, invalid wildcard, and missing matches return resolver issues.
		// Edge case: read is mandatory even when the configured pattern is otherwise valid.
		// Dependencies: shared tool-policy resolver.
		expect(
			buildChildParticipantStartup({
				plan: { extensionArgs: [], env: {} },
				config: baseConfig,
				pi: createPi(["grep"]),
				runtime: createRuntime(),
				sessionFile: "/tmp/session/llm1.jsonl",
				sessionDir: "/tmp/session",
				systemPrompt: "participant prompt",
			}),
		).toEqual({ issue: "required tool read is unavailable" });

		const cases: ReadonlyArray<{
			readonly tools: readonly string[];
			readonly issue: string;
		}> = [
			{ tools: ["*"], issue: "full wildcard * is not allowed" },
			{
				tools: ["missing*"],
				issue: "tool pattern missing* did not match any available tool",
			},
		];

		for (const testCase of cases) {
			expect(
				buildChildParticipantStartup({
					plan: { extensionArgs: [], env: {} },
					config: { ...baseConfig, tools: testCase.tools },
					pi: createPi(["read"]),
					runtime: createRuntime(),
					sessionFile: "/tmp/session/llm1.jsonl",
					sessionDir: "/tmp/session",
					systemPrompt: "participant prompt",
				}),
			).toEqual({ issue: testCase.issue });
		}
	});
});
