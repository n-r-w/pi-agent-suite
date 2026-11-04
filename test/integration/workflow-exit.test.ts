import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	getTopWorkflow,
	replayWorkflowChain,
} from "../../pi-package/extensions/workflow/workflow";
import { createTempDir } from "../support/temp-dir";

/** Represents native CLI observations without depending on prompt wording. */
interface RuntimeDump {
	readonly activeTools: string[];
	readonly requests: { tools: string[]; model: string }[];
	readonly branch: unknown[];
	readonly model: string;
	readonly thinking: string;
}

test("native Pi retains a final stage across sessions, exits explicitly, and keeps tools offered", () => {
	const { path: root, remove: cleanup } = createTempDir("pi-workflow-exit-");
	try {
		const cwd = join(root, "project");
		const agent = join(root, "agent");
		const suite = join(root, "suite");
		for (const directory of [
			cwd,
			agent,
			join(suite, "workflow", "workflows"),
		]) {
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
			join(suite, "workflow", "workflows", "delivery.yaml"),
			"description: Delivery\nstages:\n  - id: start\n    description: Start\n    prompt: Work\n    initial: true\n  - id: done\n    description: Done\n    prompt: Deliver\n    final: true\n    model:\n      id: workflow-exit-fixture/stage\n      thinking: high\ntransitions:\n  - from: start\n    to: done\n    type: advance\n  - from: done\n    to: start\n    type: rework\n",
		);
		const debug = join(root, "debug.ts");
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
		const run = (mode: "retain" | "exit"): RuntimeDump => {
			const dump = join(root, `${mode}.json`);
			writeFileSync(
				debug,
				`import { workflowExitProvider } from ${JSON.stringify(resolve("test/support/workflow-exit-provider.ts"))};\nexport default (pi) => workflowExitProvider(pi, ${JSON.stringify(dump)}, ${mode === "exit"});\n`,
			);
			const result = spawnSync(
				"pi",
				[
					"--no-extensions",
					"--session-dir",
					join(root, "sessions"),
					"--session-id",
					"workflow-exit",
					"--model",
					"workflow-exit-fixture/original",
					"--thinking",
					"low",
					"-p",
					"-e",
					resolve("pi-package/extensions/workflow/index.ts"),
					"-e",
					debug,
					"Run the fixture.",
				],
				{
					cwd,
					env,
					encoding: "utf8",
					timeout: 30000,
				},
			);
			if (result.status !== 0) {
				throw new Error(`${result.stdout}\n${result.stderr}`);
			}
			return JSON.parse(readFileSync(dump, "utf8"));
		};
		const retained = run("retain");
		expect(
			getTopWorkflow(replayWorkflowChain(retained.branch).chain)?.route,
		).toEqual(["start", "done"]);
		expect(retained.model).toBe("stage");
		expect(retained.thinking).toBe("high");
		for (const request of retained.requests) {
			expect(request.tools).toContain("workflow_activate");
			expect(request.tools).toContain("workflow_exit");
		}
		const ended = run("exit");
		expect(replayWorkflowChain(ended.branch).chain).toEqual([]);
		expect(ended.model).toBe("original");
		expect(ended.thinking).toBe("low");
		expect(ended.activeTools).toContain("workflow_transition");
		expect(ended.activeTools).toContain("workflow_exit");
		expect(
			ended.branch.some(
				(entry) =>
					typeof entry === "object" &&
					entry !== null &&
					Reflect.get(entry, "type") === "message" &&
					Reflect.get(Reflect.get(entry, "message"), "role") === "toolResult" &&
					Reflect.get(Reflect.get(entry, "message"), "isError") === true,
			),
		).toBe(true);
	} finally {
		cleanup();
	}
}, 60000);
