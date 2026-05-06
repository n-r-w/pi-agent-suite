import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

/** Runs a test with isolated pi agent-suite storage state. */
export async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-convene-council-"));
	env[AGENT_DIR_ENV] = agentDir;
	delete env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		restoreEnv(AGENT_DIR_ENV, previousAgentDir);
		restoreEnv(AGENT_SUITE_DIR_ENV, previousAgentSuiteDir);
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes convene-council config under the suite-owned config path. */
export async function writeConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await writeSuiteConfig(agentDir, "convene-council", JSON.stringify(config));
}

/** Writes raw convene-council config bytes under the suite-owned config path. */
export async function writeRawConfig(
	agentDir: string,
	config: string,
): Promise<void> {
	await writeSuiteConfig(agentDir, "convene-council", config);
}

/** Writes context-projection config under the suite-owned config path. */
export async function writeProjectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await writeSuiteConfig(
		agentDir,
		"context-projection",
		JSON.stringify(config),
	);
}

/** Writes one extension config under the suite-owned config path. */
async function writeSuiteConfig(
	agentDir: string,
	extensionDir: string,
	content: string,
): Promise<void> {
	const dir = join(agentDir, "agent-suite", extensionDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.json"), content);
}

/** Restores an environment variable to its previous value. */
function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete env[key];
		return;
	}
	env[key] = value;
}
