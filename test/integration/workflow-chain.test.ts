import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractWorkflowStatus } from "../../pi-package/extensions/run-subagent/workflow-status";
import { replayWorkflowChain } from "../../pi-package/extensions/workflow/workflow";
import { createTempDir } from "../support/temp-dir";
import type { CacheRequestSnapshot } from "../support/toolset-cache-provider";

/** Describes observations emitted by the temporary real-CLI debug extension. */
interface ChainDump {
	requests: CacheRequestSnapshot[];
	activeTools: string[];
	branch: SessionEntry[];
	model: string;
	thinking: string;
	systemPrompt: string;
}

/** Creates format-specific graphs with distinct parent transitions and shared initial IDs. */
function catalog(nested: boolean, legacy = false): string {
	const next = nested ? "done" : "parent-only";
	return `${legacy ? "" : `version: ${nested ? 3 : 2}\n${nested ? "nested: true\n" : ""}`}description: Fixture
stages:
  - id: start
    description: Start
${legacy ? "" : "    goal: Ready\n"}    prompt: Work
    initial: true
  - id: ${next}
    description: Done
${legacy ? "" : "    goal: Delivered\n"}    prompt: Report
    final: true
transitions:
  - from: start
    to: ${next}
    type: advance
  - from: ${next}
    to: start
    type: rework
${legacy ? "" : "    grounds:\n      - id: retry\n        when: Revision\n"}`;
}

for (const provider of ["openai", "openai-codex"] as const) {
	for (const child of [false, true]) {
		test(`native ${provider} ${child ? "child" : "main"} executes chains with stable serialized request prefixes`, () => {
			const temporary = createTempDir("pi-workflow-chain-");
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
				writeFileSync(join(workflows, "delivery.yaml"), catalog(false));
				writeFileSync(
					join(workflows, "check.yaml"),
					`${catalog(true)}kind: review\n`,
				);
				writeFileSync(
					join(suite, "workflow/kinds.yaml"),
					"- id: task\n  description: Whole task processes\n- id: review\n  description: Review processes\n",
				);
				writeFileSync(
					join(workflows, "task.yaml"),
					`${catalog(true)}kind: task\n`,
				);
				writeFileSync(join(workflows, "denied.yaml"), catalog(true));
				writeFileSync(
					join(workflows, "replacement.yaml"),
					catalog(false, true),
				);
				const debug = join(root, "debug.ts");
				const dump = join(root, "dump.json");
				writeFileSync(
					debug,
					`import { workflowChainProvider } from ${JSON.stringify(resolve("test/support/workflow-chain-provider.ts"))};\nexport default (pi) => workflowChainProvider(pi, ${JSON.stringify(dump)}, ${JSON.stringify(provider)}, ${child});\n`,
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
					env["PI_SUBAGENT_WORKFLOW_IDS"] = JSON.stringify([
						"delivery",
						"check",
						"replacement",
						"task",
					]);
				}
				const result = spawnSync(
					"pi",
					[
						"--no-session",
						"--no-extensions",
						"--model",
						`${provider}/gpt-6.1-sol`,
						"--thinking",
						"low",
						"-p",
						"-e",
						resolve("pi-package/extensions/workflow/index.ts"),
						"-e",
						debug,
						"Run the fixture.",
					],
					{ cwd, env, encoding: "utf8", timeout: 30000 },
				);
				if (result.status !== 0) {
					throw new Error(`${result.stdout}\n${result.stderr}`);
				}
				const observed = JSON.parse(readFileSync(dump, "utf8")) as ChainDump;
				expect(observed.requests).toHaveLength(14);
				expect(observed.thinking).toBe("low");
				expect(replayWorkflowChain(observed.branch).chain).toEqual([]);
				expect(extractWorkflowStatus(observed.branch)).toBeUndefined();
				for (let end = 1; end <= observed.branch.length; end++) {
					const history = observed.branch.slice(0, end);
					const chain = replayWorkflowChain(history).chain;
					const top = chain.at(-1);
					if (top?.source === "dynamic") {
						expect(top.workflow.kind).toBe("review");
					}
					const stage = top?.workflow.stages.find(
						({ id }) => id === top.route.at(-1),
					);
					expect(extractWorkflowStatus(history)).toEqual(
						top && stage
							? {
									workflowId: chain
										.map(({ workflow }) => workflow.id)
										.join("➡"),
									stageDescription: stage.description,
								}
							: undefined,
					);
				}
				const messages = observed.branch
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message)
					.filter((message) => message.role === "toolResult");
				expect(
					messages.map((message) => [message.toolName, message.isError]),
				).toEqual([
					["workflow_activate", false],
					["workflow_activate", true],
					["workflow_activate", false],
					["workflow_transition", true],
					["workflow_create", false],
					["workflow_edit_stage", false],
					["workflow_get_stage", false],
					["workflow_exit", false],
					["workflow_transition", false],
					["workflow_exit", false],
					["workflow_activate", false],
					["workflow_activate", false],
					["workflow_exit", false],
				]);
				const chainEvents = observed.branch.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === "workflow"
						? [entry.details as Record<string, unknown>]
						: [],
				);
				expect(
					chainEvents
						.filter((details) => details["kind"] === "activation")
						.map((details) => details["workflowId"]),
				).toEqual([
					"delivery",
					"check",
					"dynamic-child",
					"check",
					"replacement",
				]);
				expect(
					chainEvents
						.filter((details) => details["kind"] === "stage_activation")
						.map((details) => [
							details["workflowId"],
							details["currentStageId"],
						]),
				).toEqual([
					["check", "start"],
					["check", "done"],
					["delivery", "start"],
				]);
				for (let index = 1; index < observed.requests.length; index++) {
					const previousRequest = observed.requests[index - 1];
					const currentRequest = observed.requests[index];
					if (!previousRequest || !currentRequest) {
						throw new Error("missing serialized request");
					}
					const previous = previousRequest.payload;
					const current = currentRequest.payload;
					expect(current.input.slice(0, previous.input.length)).toEqual(
						previous.input,
					);
					expect(current.input.length).toBeGreaterThan(previous.input.length);
					const { input: _previousInput, ...previousLeading } = previous;
					const { input: _currentInput, ...currentLeading } = current;
					expect(currentLeading).toEqual(previousLeading);
					for (const tool of previousRequest.toolNames) {
						expect(currentRequest.toolNames).toContain(tool);
					}
				}
				expect(observed.requests[0]?.toolNames).not.toContain(
					"workflow_get_stage",
				);
				expect(observed.requests.at(-1)?.toolNames).toContain(
					"workflow_get_stage",
				);
				expect(observed.activeTools).toContain("workflow_exit");
			} finally {
				temporary.remove();
			}
		}, 40000);
	}
}
