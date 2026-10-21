import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../support/temp-dir";

/** Detects real Pi extension loading and execution errors. */
const EXTENSION_ERROR =
	/Failed to load extension|Extension error|Extension failed/i;

/** Builds a child environment with isolated state and inherited subagent keys omitted. */
function childEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("PI_SUBAGENT_"),
			),
		),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_AGENT_SUITE_DIR: join(root, "suite"),
	};
}

test("restoration lists an oversized skill as absent within the estimated request limit with the package runtime prompt", () => {
	const temp = createTempDir("skill-package-prompt-budget-");
	try {
		const child = spawnSync(
			"bun",
			[
				"run",
				"test/support/skill-restoration-session.ts",
				temp.path,
				"prompt-budget",
			],
			{ env: childEnvironment(temp.path), encoding: "utf8", timeout: 30000 },
		);
		if (child.status !== 0) {
			throw new Error(`${child.stdout}\n${child.stderr}`);
		}
		const output = JSON.parse(child.stdout) as {
			requests: {
				requestTokens: number;
				withoutRestorationTokens: number;
				records: { restoredPaths?: string[]; absentPaths?: string[] }[];
			}[];
			skill: string;
		};
		const first = output.requests[0];
		expect(first).toBeDefined();
		expect(first?.withoutRestorationTokens ?? Infinity).toBeLessThan(49800);
		expect(first?.requestTokens ?? Infinity).toBeLessThanOrEqual(49800);
		expect(first?.records[0]?.restoredPaths).toEqual([]);
		expect(first?.records[0]?.absentPaths).toEqual([output.skill]);
	} finally {
		temp.remove();
	}
});

for (const mode of ["native", "custom"]) {
	test(`real Pi ${mode} compaction restores skills on subsequent requests in session and CLI main/child checks`, () => {
		const temp = createTempDir("skill-real-pi-");
		try {
			const seed = spawnSync(
				"bun",
				["run", "test/support/skill-restoration-session.ts", temp.path, mode],
				{ env: childEnvironment(temp.path), encoding: "utf8", timeout: 30000 },
			);
			if (seed.status !== 0) {
				throw new Error(`${seed.stdout}\n${seed.stderr}`);
			}
			const output = JSON.parse(seed.stdout) as {
				summaries: number;
				records: number;
				requests: {
					roles: string[];
					records: { compactionId: string; restoredPaths: string[] }[];
				}[];
				skill: string;
				sessionFile: string;
			};
			if (mode === "native") {
				expect(output.summaries).toBeGreaterThan(0);
			} else {
				expect(output.summaries).toBe(0);
			}
			expect(output.records).toBe(1);
			expect(output.requests).toHaveLength(2);
			for (const request of output.requests) {
				expect(request.roles.slice(0, 2)).toEqual([
					"compactionSummary",
					"custom",
				]);
				expect(request.records).toHaveLength(1);
				expect(request.records[0]?.restoredPaths).toEqual([output.skill]);
			}
			expect(output.requests[0]?.records).toEqual(output.requests[1]?.records);
			const suite = join(temp.path, "suite");
			mkdirSync(join(suite, "agent-selection", "agents"), { recursive: true });
			mkdirSync(join(suite, "agent-selection", "state"), { recursive: true });
			writeFileSync(
				join(suite, "agent-selection", "agents", "TestAgent.md"),
				'---\ndescription: Fixture\ntype: both\ntools: ["read"]\n---\nFixture',
			);
			writeFileSync(
				join(
					suite,
					"agent-selection",
					"state",
					`${createHash("sha256").update(temp.path).digest("hex")}.json`,
				),
				JSON.stringify({ cwd: temp.path, activeAgentId: "TestAgent" }),
			);
			const debug = join(temp.path, "debug.ts");
			const dump = join(temp.path, "dump.json");
			writeFileSync(
				debug,
				`import { writeFileSync } from "node:fs";
export default function debug(pi) {
 let systemPrompt;
 pi.registerProvider("skill-runtime", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
 pi.on("before_agent_start", (event) => { systemPrompt = event.systemPrompt; });
 pi.on("context", (event) => {
  writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ systemPrompt, activeTools: pi.getActiveTools(), roles: event.messages.map(message => message.role), records: event.messages.filter(message => message.role === "custom" && message.customType === "skill-restoration").map(message => message.details) }));
  process.exit(23);
 });
}
`,
			);
			for (const target of ["single", "main", "child"]) {
				const targetPath =
					target === "single"
						? join(
								process.cwd(),
								"pi-package/extensions/skill-restoration/index.ts",
							)
						: join(process.cwd(), "pi-package");
				const env = childEnvironment(temp.path);
				if (target === "child") {
					Object.assign(env, {
						PI_AGENT_SUITE_CHILD_AGENT_PROCESS: "1",
						PI_SUBAGENT_AGENT_ID: "TestAgent",
						PI_SUBAGENT_DEPTH: "1",
						PI_SUBAGENT_TOOL_PATTERNS: JSON.stringify(["read"]),
						PI_SUBAGENT_WORKFLOW_IDS: "[]",
					});
				}
				const cli = spawnSync(
					"pi",
					[
						"--session",
						output.sessionFile,
						"--no-extensions",
						"--model",
						"skill-runtime/fake",
						"-p",
						"-e",
						targetPath,
						"-e",
						debug,
						"runtime fixture",
					],
					{ cwd: temp.path, env, encoding: "utf8", timeout: 30000 },
				);
				if (cli.status !== 23) {
					throw new Error(`${target}: ${cli.stdout}\n${cli.stderr}`);
				}
				expect(cli.stderr).not.toMatch(EXTENSION_ERROR);
				const runtime = JSON.parse(readFileSync(dump, "utf8")) as {
					activeTools: string[];
					roles: string[];
					records: unknown[];
				};
				expect(runtime.activeTools).toContain("read");
				expect(runtime.roles.slice(0, 2)).toEqual([
					"compactionSummary",
					"custom",
				]);
				expect(runtime.records).toEqual(output.requests[0]?.records ?? []);
			}
		} finally {
			temp.remove();
		}
	}, 120000);
}
