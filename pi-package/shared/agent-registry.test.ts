import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAgentIdMatchKey } from "./agent-id";
import { type AgentDefinition, loadAgentDefinitions } from "./agent-registry";
import { AGENT_SUITE_DIR_ENV } from "./agent-suite-storage";

const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

afterEach(async () => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("agent registry project overlay", () => {
	test("merges project agents of every type and overrides global IDs case-insensitively", async () => {
		// Purpose: one project registry must extend both main-agent-selection and run-subagent without separate formats.
		// Input and expected output: project main, subagent, and both definitions extend the global set, and local builder replaces global Builder.
		// Edge case: override matching ignores file-name case while preserving the selected local agent ID.
		// Dependencies: this test uses only temporary suite and project directories.
		await withRegistryFixture(async ({ globalAgentsDir, projectDir }) => {
			await writeAgent(globalAgentsDir, "Builder.md", "main", "Global builder");
			await writeAgent(
				globalAgentsDir,
				"GlobalOnly.md",
				"subagent",
				"Global only",
			);
			const projectAgentsDir = join(projectDir, ".pi", "agents");
			await writeAgent(
				projectAgentsDir,
				"builder.md",
				"main",
				"Project builder",
			);
			await writeAgent(
				projectAgentsDir,
				"ProjectWorker.md",
				"subagent",
				"Project worker",
			);
			await writeAgent(
				projectAgentsDir,
				"ProjectHybrid.md",
				"both",
				"Project hybrid",
			);

			const agents = await loadAgentDefinitions(projectDir);

			expect(findAgent(agents, "builder")).toMatchObject({
				id: "builder",
				type: "main",
				prompt: "Project builder",
			});
			expect(findAgent(agents, "GlobalOnly")?.type).toBe("subagent");
			expect(findAgent(agents, "ProjectWorker")?.type).toBe("subagent");
			expect(findAgent(agents, "ProjectHybrid")?.type).toBe("both");
			expect(agents).toHaveLength(4);
		});
	});

	test("keeps an invalid project override unavailable while loading unrelated agents", async () => {
		// Purpose: a broken project override must not silently expose the global agent that it intended to replace.
		// Input and expected output: malformed local HELPER hides global helper, while valid global and project agents remain available.
		// Edge case: the local file must reserve its normalized ID before frontmatter parsing fails.
		// Dependencies: this test uses only temporary suite and project directories.
		await withRegistryFixture(async ({ globalAgentsDir, projectDir }) => {
			await writeAgent(
				globalAgentsDir,
				"helper.md",
				"subagent",
				"Global helper",
			);
			await writeAgent(globalAgentsDir, "GlobalOnly.md", "main", "Global only");
			const projectAgentsDir = join(projectDir, ".pi", "agents");
			await mkdir(projectAgentsDir, { recursive: true });
			await writeFile(
				join(projectAgentsDir, "HELPER.md"),
				"---\nmodel: [\n---\nBroken helper",
			);
			await writeAgent(
				projectAgentsDir,
				"ProjectOnly.md",
				"both",
				"Project only",
			);

			const agents = await loadAgentDefinitions(projectDir);

			expect(findAgent(agents, "helper")).toBeUndefined();
			expect(findAgent(agents, "GlobalOnly")).toBeDefined();
			expect(findAgent(agents, "ProjectOnly")).toBeDefined();
		});
	});
});

/** Runs one registry test with isolated global and project roots. */
async function withRegistryFixture(
	testBody: (fixture: {
		readonly globalAgentsDir: string;
		readonly projectDir: string;
	}) => Promise<void>,
): Promise<void> {
	const suiteDir = await createTempDir("agent-registry-suite-");
	const projectDir = await createTempDir("agent-registry-project-");
	const globalAgentsDir = join(suiteDir, "agent-selection", "agents");
	await mkdir(globalAgentsDir, { recursive: true });
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await testBody({ globalAgentsDir, projectDir });
}

/** Creates one tracked temporary directory for isolated filesystem behavior. */
async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Writes one valid agent definition with the requested type and prompt. */
async function writeAgent(
	agentsDir: string,
	fileName: string,
	type: AgentDefinition["type"],
	prompt: string,
): Promise<void> {
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		join(agentsDir, fileName),
		[
			"---",
			`description: ${JSON.stringify(prompt)}`,
			`type: ${type}`,
			"---",
			prompt,
		].join("\n"),
	);
}

/** Finds one logical agent ID using the registry's case-insensitive matching rule. */
function findAgent(
	agents: readonly AgentDefinition[],
	agentId: string,
): AgentDefinition | undefined {
	const matchKey = toAgentIdMatchKey(agentId);
	return agents.find((agent) => toAgentIdMatchKey(agent.id) === matchKey);
}
