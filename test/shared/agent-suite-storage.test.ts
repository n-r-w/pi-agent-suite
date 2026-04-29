import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getAgentSuiteDir,
	readExtensionConfigFile,
	readExtensionConfigFileSync,
} from "../../pi-package/shared/agent-suite-storage";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

/** Runs storage tests with isolated pi agent and suite environment variables. */
async function withIsolatedStorageEnv<T>(
	action: (paths: {
		readonly agentDir: string;
		readonly suiteDir: string;
	}) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-suite-storage-"));
	const suiteDir = join(agentDir, "custom-suite");

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action({ agentDir, suiteDir });
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes one config file after creating its parent directory. */
async function writeConfig(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

describe("agent-suite storage", () => {
	test("resolves the default suite directory under the pi agent directory", async () => {
		// Purpose: default suite storage must live under the isolated pi agent directory.
		// Input and expected output: no PI_AGENT_SUITE_DIR resolves to <agentDir>/agent-suite.
		// Edge case: the function must read the current environment during the call.
		// Dependencies: isolated environment variables only.
		await withIsolatedStorageEnv(async ({ agentDir }) => {
			expect(getAgentSuiteDir()).toBe(join(agentDir, "agent-suite"));
		});
	});

	test("uses PI_AGENT_SUITE_DIR and does not fall back when suite config exists", async () => {
		// Purpose: suite config must have priority over legacy config and env override must select the suite root.
		// Input and expected output: suite config content is returned even when legacy config also exists.
		// Edge case: suite content is invalid JSON, proving storage lookup does not parse or fall back.
		// Dependencies: isolated suite and legacy config files.
		await withIsolatedStorageEnv(async ({ agentDir, suiteDir }) => {
			process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
			await writeConfig(join(suiteDir, "codex-quota", "config.json"), "{");
			await writeConfig(
				join(agentDir, "config", "codex-quota.json"),
				JSON.stringify({ enabled: true }),
			);

			const result = await readExtensionConfigFile({
				extensionDir: "codex-quota",
				legacyConfigFileName: "codex-quota.json",
			});

			expect(getAgentSuiteDir()).toBe(suiteDir);
			expect(result).toEqual({
				kind: "found",
				file: {
					path: join(suiteDir, "codex-quota", "config.json"),
					displayPath: join("agent-suite", "codex-quota", "config.json"),
					directory: join(suiteDir, "codex-quota"),
					content: "{",
				},
			});
		});
	});

	test("falls back to legacy config only when suite config is missing", async () => {
		// Purpose: earlier config files must remain readable when suite config is absent.
		// Input and expected output: missing suite config returns the legacy config file.
		// Edge case: sync and async readers must use the same precedence.
		// Dependencies: isolated legacy config file.
		await withIsolatedStorageEnv(async ({ agentDir }) => {
			await writeConfig(
				join(agentDir, "config", "run-subagent.json"),
				JSON.stringify({ enabled: false }),
			);

			const options = {
				extensionDir: "run-subagent",
				legacyConfigFileName: "run-subagent.json",
			};
			const asyncResult = await readExtensionConfigFile(options);
			const syncResult = readExtensionConfigFileSync(options);

			expect(asyncResult).toEqual(syncResult);
			expect(asyncResult.kind).toBe("found");
			if (asyncResult.kind === "found") {
				expect(asyncResult.file.path).toBe(
					join(agentDir, "config", "run-subagent.json"),
				);
				expect(asyncResult.file.content).toBe(
					JSON.stringify({ enabled: false }),
				);
			}
		});
	});
});
