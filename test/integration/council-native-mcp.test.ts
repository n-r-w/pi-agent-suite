/** Checks participant tool restrictions through the real Pi child CLI. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildChildParticipantStartupFromToolArgs,
	resolveCouncilToolArgsForNames,
} from "../../pi-package/extensions/convene-council/startup";
import { createModel } from "../extensions/convene-council/support/models";
import { createTempDir } from "../support/temp-dir";

/** Exercises server tools and resource helpers from one codemode script. */
const SCRIPT = `
const result = {};
try { await tools.mcp__fixture__echo({text: "echo-marker"}); result.echo = true; } catch { result.echo = false; }
try { await tools.mcp__fixture__second({text: "second-marker"}); result.second = true; } catch { result.second = false; }
try { await tools.list_mcp_resources({server: "fixture"}); result.list = true; } catch { result.list = false; }
try { await tools.read_mcp_resource({server: "fixture", uri: "fixture://note"}); result.resource = true; } catch { result.resource = false; }
console.log(JSON.stringify(result));
`;

test.each([
	{
		tools: ["codemode"],
		expected: { echo: false, second: false, list: false, resource: false },
	},
	{
		tools: ["codemode", "mcp__fixture__echo"],
		expected: { echo: true, second: false, list: false, resource: false },
	},
	{
		tools: ["codemode", "list_mcp_resources"],
		expected: { echo: false, second: false, list: true, resource: false },
	},
])("council child enforces native MCP policy $tools", ({ tools, expected }) => {
	const fixture = createTempDir("council-native-mcp-");
	const repository = resolve(import.meta.dir, "../..");
	try {
		const agentDir = join(fixture.path, "agent");
		const projectDir = join(fixture.path, "project");
		mkdirSync(agentDir);
		mkdirSync(projectDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [], checkForUpdates: false }),
		);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					fixture: {
						command: process.execPath,
						args: [join(repository, "test/fixtures/native-mcp-stdio.ts")],
						exposure: "codemode",
					},
				},
			}),
		);
		const provider = join(fixture.path, "provider.ts");
		copyFileSync(
			join(repository, "test/fixtures/native-mcp-provider.ts"),
			provider,
		);
		writeFileSync(join(fixture.path, "script.js"), SCRIPT);
		const toolArgs = resolveCouncilToolArgsForNames(
			{
				llm1: {},
				llm2: {},
				participantIterationLimit: 3,
				finalAnswerParticipant: "llm2",
				responseDefectRetries: 1,
				tools,
			},
			[
				"read",
				"codemode",
				"mcp__fixture__echo",
				"mcp__fixture__second",
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
			],
		);
		if ("issue" in toolArgs) {
			throw new Error(toolArgs.issue);
		}
		const startup = buildChildParticipantStartupFromToolArgs({
			plan: {
				extensionArgs: [
					"--no-extensions",
					"-e",
					"builtin:codemode",
					"-e",
					"builtin:mcp",
					"-e",
					join(repository, "pi-package"),
					"-e",
					provider,
				],
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
				},
			},
			runtime: { model: createModel("native-mcp-test", "fake") },
			sessionFile: join(fixture.path, "session.jsonl"),
			sessionDir: fixture.path,
			systemPrompt: "Run the local tool permission check.",
			toolArgs: toolArgs.args,
		});
		const child = spawnSync(
			join(repository, "node_modules/.bin/pi"),
			[...startup.args, "--mode", "text", "-p", "Run the check."],
			{
				cwd: projectDir,
				env: { PATH: process.env["PATH"], ...startup.env },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect({
			error: child.error,
			status: child.status,
			stderr: child.stderr,
		}).toEqual({ error: undefined, status: 0, stderr: "" });
		const runtime = JSON.parse(
			readFileSync(join(fixture.path, "runtime.json"), "utf8"),
		) as { activeTools: string[] };
		expect(runtime.activeTools).toContain("codemode");
		const results = JSON.parse(
			readFileSync(join(fixture.path, "results.json"), "utf8"),
		) as ToolResultMessage[];
		const result = results.find((message) => message.toolName === "codemode");
		expect(result?.isError).toBe(false);
		expect(
			result?.content.some(
				(block) =>
					block.type === "text" &&
					block.text.includes(JSON.stringify(expected)),
			),
		).toBe(true);
	} finally {
		fixture.remove();
	}
}, 40_000);
