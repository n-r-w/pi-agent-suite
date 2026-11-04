import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractWorkflowStatus } from "../../pi-package/extensions/run-subagent/workflow-status";
import { replayWorkflowChain } from "../../pi-package/extensions/workflow/workflow";
import { createTempDir } from "../support/temp-dir";

/** Produces a format3 graph whose transitions can start another nested check. */
function createCatalogYaml(nested: boolean, binding?: string): string {
	return `version: 3
${nested ? "nested: true\n" : ""}description: Fixture
stages:
  - id: start
    description: Start
    goal: Ready
    prompt: Work
    initial: true
  - id: done
    description: Done
    goal: Delivered
    prompt: Report
    final: true
transitions:
  - from: start
    to: done
    type: advance
${binding ? `    workflow: ${binding}\n` : ""}  - from: done
    to: start
    type: rework
${binding ? `    workflow: ${binding}\n` : ""}    grounds:
      - id: retry
        when: Revision
`;
}

for (const child of [false, true]) {
	test(`native ${child ? "child" : "main"} resolves bound chains through permission-bearing exits`, () => {
		const temporary = createTempDir("pi-bound-native-");
		try {
			const root = temporary.path;
			const cwd = join(root, "project");
			const agent = join(root, "agent");
			const suite = join(root, "suite");
			const workflows = join(suite, "workflow/workflows");
			for (const directory of [cwd, agent, workflows]) {
				mkdirSync(directory, { recursive: true });
			}
			writeFileSync(
				join(agent, "settings.json"),
				JSON.stringify({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
			);
			writeFileSync(
				join(workflows, "delivery.yaml"),
				createCatalogYaml(false, "check"),
			);
			writeFileSync(
				join(workflows, "check.yaml"),
				createCatalogYaml(true, "inner"),
			);
			writeFileSync(join(workflows, "inner.yaml"), createCatalogYaml(true));
			const debug = join(root, "debug.ts");
			const dump = join(root, "dump.json");
			writeFileSync(
				debug,
				`import { registerWorkflowTransitionProvider } from ${JSON.stringify(resolve("test/support/workflow-transition-provider.ts"))};\nexport default (pi) => registerWorkflowTransitionProvider(pi, ${JSON.stringify(dump)}, ${child});\n`,
			);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_CODING_AGENT_DIR: agent,
				PI_AGENT_SUITE_DIR: suite,
			};
			for (const key of Object.keys(env)) {
				if (
					key.startsWith("PI_SUBAGENT_") ||
					key === "PI_AGENT_SUITE_CHILD_AGENT_PROCESS"
				) {
					delete env[key];
				}
			}
			if (child) {
				env["PI_AGENT_SUITE_CHILD_AGENT_PROCESS"] = "1";
				env["PI_SUBAGENT_WORKFLOW_IDS"] = '["delivery","check","inner"]';
			}
			const result = spawnSync(
				"pi",
				[
					"--no-session",
					"--no-extensions",
					"--model",
					"openai/gpt-6.1-sol",
					"--thinking",
					"low",
					"-p",
					"-e",
					resolve("pi-package/extensions/workflow/index.ts"),
					"-e",
					debug,
					"Run fixture.",
				],
				{ cwd, env, encoding: "utf8", timeout: 30000 },
			);
			if (result.status !== 0) {
				throw new Error(`${result.stdout}\n${result.stderr}`);
			}
			const observed = JSON.parse(readFileSync(dump, "utf8")) as {
				branch: SessionEntry[];
				activeTools: string[];
			};
			const results = observed.branch.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [entry.message]
					: [],
			);
			expect(results.map(({ isError }) => isError === true)).toEqual([
				false,
				false,
				true,
				false,
				false,
				false,
				false,
				false,
				false,
				false,
				false,
			]);
			const states = observed.branch.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "workflow-state"
					? [entry.data as Record<string, unknown>]
					: [],
			);
			expect(states.map((data) => data["kind"])).toEqual([
				"activated",
				"activated",
				"activated",
				"exited",
				"exited",
				"activated",
				"exited",
				"activated",
				"exited",
				"exited",
			]);
			expect(
				states
					.filter((data) => data["kind"] === "exited")
					.map((data) => data["allow"]),
			).toEqual([true, false, true, true, undefined]);
			for (let end = 1; end <= observed.branch.length; end++) {
				const history = observed.branch.slice(0, end);
				const chain = replayWorkflowChain(history).chain;
				const top = chain.at(-1);
				const stage = top?.workflow.stages.find(
					({ id }) => id === top.route.at(-1),
				);
				expect(extractWorkflowStatus(history)).toEqual(
					top && stage
						? {
								workflowId: chain.map(({ workflow }) => workflow.id).join("➡"),
								stageDescription: stage.description,
							}
						: undefined,
				);
			}
			expect(replayWorkflowChain(observed.branch).chain).toEqual([]);
			expect(observed.activeTools).toContain("workflow_exit");
		} finally {
			temporary.remove();
		}
	}, 40000);
}
