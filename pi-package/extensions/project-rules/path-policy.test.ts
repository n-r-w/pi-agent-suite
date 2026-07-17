import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import {
	createProjectRulesPathPolicy,
	isProjectRulesPathForbidden,
} from "./path-policy";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const previousAgentDir = process.env[AGENT_DIR_ENV];
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

afterEach(async () => {
	restoreEnvironment(AGENT_DIR_ENV, previousAgentDir);
	restoreEnvironment(AGENT_SUITE_DIR_ENV, previousSuiteDir);
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

test("forbids home pi storage and active global storage without blocking project resources", async () => {
	// Purpose: project rules must never expose global pi state, including storage moved through supported environment variables.
	// Input and expected output: home .pi, agentDir, and suiteDir descendants are forbidden while an unrelated project .pi remains allowed.
	// Edge case: the active suite directory is outside both the home .pi and active agent directory.
	// Dependencies: this test changes only pi-specific environment variables and uses temporary paths.
	const agentDir = await createTempDir("project-rules-agent-dir-");
	const suiteDir = await createTempDir("project-rules-suite-dir-");
	const projectDir = await createTempDir("project-rules-project-dir-");
	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;

	const policy = await createProjectRulesPathPolicy();

	expect(
		isProjectRulesPathForbidden(
			join(homedir(), ".pi", "agent", "state.md"),
			policy,
		),
	).toBe(true);
	expect(isProjectRulesPathForbidden(join(agentDir, "state.md"), policy)).toBe(
		true,
	);
	expect(isProjectRulesPathForbidden(join(suiteDir, "state.md"), policy)).toBe(
		true,
	);
	expect(
		isProjectRulesPathForbidden(
			join(projectDir, ".pi", "rules", "rule.md"),
			policy,
		),
	).toBe(false);
});

/** Creates one tracked temporary directory for path-policy tests. */
async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Restores one pi-specific environment variable after an isolated test. */
function restoreEnvironment(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
