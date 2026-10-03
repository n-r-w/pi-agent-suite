import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSubagentExtensionArgs } from "../../pi-package/extensions/run-subagent/extension-config";
import {
	buildChildArgs,
	defaultPackagePath,
	defaultRuntimeFacts,
} from "../../pi-package/extensions/run-subagent/invocation-process";
import { AGENT_SUITE_DIR_ENV } from "../../pi-package/shared/agent-suite-storage";
import { createTempDir } from "../support/temp-dir";

interface RuntimeCapture {
	readonly active: readonly string[];
	readonly registered: readonly string[];
	readonly systemPrompt: string;
}

const cases = [
	{ mode: "all", codemode: true, additional: true },
	{ mode: "none", codemode: false, additional: false },
	{ mode: "explicit", codemode: true, additional: true },
] as const;

for (const selection of cases) {
	test(`real Pi applies ${selection.mode} subagent extension loading`, () => {
		const temporary = createTempDir("subagent-extension-runtime-");
		const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		try {
			const agentDir = join(temporary.path, "agent");
			const suiteDir = join(agentDir, "agent-suite");
			const configDir = join(suiteDir, "agent-selection");
			mkdirSync(configDir, { recursive: true });
			const additionalPath = join(temporary.path, "additional.ts");
			writeFileSync(
				additionalPath,
				`export default function(pi) {
	for (const name of ["fixture_allowed", "fixture_denied"]) {
		pi.registerTool({ name, label: name, description: name,
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [], details: {} }) });
	}
}
`,
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					packages: [defaultPackagePath()],
					extensions: [additionalPath],
					defaultTools: ["+codemode"],
				}),
			);
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify({
					subagents: {
						extensions: {
							mode: selection.mode,
							...(selection.mode === "explicit"
								? { include: ["builtin:codemode", additionalPath] }
								: {}),
						},
					},
				}),
			);
			const debugPath = join(temporary.path, "capture.ts");
			const capturePath = join(temporary.path, "capture.json");
			writeFileSync(
				debugPath,
				`import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerProvider("extension-fixture", {
		baseUrl: "http://127.0.0.1:1", apiKey: "fixture", api: "openai-completions",
		models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096, maxTokens: 256 }]
	});
	pi.on("before_agent_start", (event) => {
		writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
			active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name),
			systemPrompt: event.systemPrompt
		}));
		process.exit(23);
	});
}
`,
			);
			process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
			const extensionArgs = readSubagentExtensionArgs();
			const args = buildChildArgs({
				packagePath: defaultPackagePath(),
				extensionArgs,
				childPiSessionId: "extension-fixture-session",
				childSessionDir: join(temporary.path, "sessions"),
				launch: {
					cwd: temporary.path,
					modelId: "extension-fixture/fake",
					provider: "extension-fixture",
					thinking: "off",
					depth: 1,
					providerConfigured: true,
					checkParentAuth: async () => ({ ok: true }),
					runtimeFacts: defaultRuntimeFacts(),
				},
			});
			// Print mode reaches the same extension loader without RPC catalog refresh.
			args[1] = "text";
			const toolPatterns = [
				"read",
				...(selection.codemode ? ["codemode", "fixture_allowed"] : []),
			];
			const result = spawnSync(
				"pi",
				[...args, "--no-session", "-p", "-e", debugPath, "fixture"],
				{
					cwd: temporary.path,
					encoding: "utf8",
					timeout: 30_000,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: agentDir,
						PI_AGENT_SUITE_DIR: suiteDir,
						PI_AGENT_SUITE_CHILD_AGENT_PROCESS: "1",
						PI_SUBAGENT_AGENT_ID: "FixtureAgent",
						PI_SUBAGENT_DEPTH: "1",
						PI_SUBAGENT_TOOL_PATTERNS: JSON.stringify(toolPatterns),
						PI_SKIP_VERSION_CHECK: "1",
						PI_OFFLINE: "0",
					},
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(23);
			const capture: RuntimeCapture = JSON.parse(
				readFileSync(capturePath, "utf8"),
			);
			expect(capture.registered.includes("codemode")).toBe(selection.codemode);
			expect(capture.registered.includes("fixture_allowed")).toBe(
				selection.additional,
			);
			expect(capture.active).toEqual(toolPatterns);
			expect(capture.active).not.toContain("fixture_denied");
			expect(
				capture.registered.filter((name) => name === "subagent_start"),
			).toHaveLength(1);
		} finally {
			if (previousSuiteDir === undefined) {
				delete process.env[AGENT_SUITE_DIR_ENV];
			} else {
				process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
			}
			temporary.remove();
		}
	}, 40_000);
}
