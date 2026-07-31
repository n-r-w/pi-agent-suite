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
		// Purpose: one project registry must extend both main-agent selection and Subagents without separate formats.
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

	test("preserves absent, empty, and explicit workflow policies", async () => {
		// Purpose: agent frontmatter must preserve the three workflow policy states before catalog resolution.
		// Input and expected output: absent, empty, and mixed-case explicit lists become undefined, [], and original names.
		// Edge case: frontmatter names remain unnormalized until the shared catalog resolver runs.
		// Dependencies: this test uses only temporary suite and project directories.
		await withRegistryFixture(async ({ globalAgentsDir, projectDir }) => {
			await writeFile(
				join(globalAgentsDir, "Unrestricted.md"),
				"---\ntype: main\n---\nUnrestricted",
			);
			await writeFile(
				join(globalAgentsDir, "Empty.md"),
				"---\ntype: main\nworkflows: []\n---\nEmpty",
			);
			await writeFile(
				join(globalAgentsDir, "Explicit.md"),
				"---\ntype: both\nworkflows: [Review, DELIVERY]\n---\nExplicit",
			);
			await writeFile(
				join(globalAgentsDir, "Spaced.md"),
				'---\ntype: main\nworkflows: [" Review"]\n---\nSpaced',
			);

			const agents = await loadAgentDefinitions(projectDir);

			expect(findAgent(agents, "Unrestricted")?.workflows).toBeUndefined();
			expect(findAgent(agents, "Empty")?.workflows).toEqual([]);
			expect(findAgent(agents, "Explicit")?.workflows).toEqual([
				"Review",
				"DELIVERY",
			]);
			expect(findAgent(agents, "Spaced")?.workflows).toEqual([" Review"]);
		});
	});

	test.each([
		["case-insensitive duplicates", "[Review, review]"],
		["wrong primitive", "review"],
		["empty item", '[Review, ""]'],
		["whitespace item", '[Review, "   "]'],
	])("rejects invalid workflows frontmatter: %s", async (_case, workflows) => {
		// Purpose: malformed workflow policy must make only that agent unavailable.
		// Input and expected output: each invalid workflows value produces no parsed agent.
		// Edge case: duplicate detection is case-insensitive while other agent files remain loadable.
		// Dependencies: this test uses only temporary suite and project directories.
		await withRegistryFixture(async ({ globalAgentsDir, projectDir }) => {
			await writeFile(
				join(globalAgentsDir, "Invalid.md"),
				`---\ntype: main\nworkflows: ${workflows}\n---\nInvalid`,
			);
			await writeAgent(globalAgentsDir, "Valid.md", "main", "Valid");

			const agents = await loadAgentDefinitions(projectDir);

			expect(findAgent(agents, "Invalid")).toBeUndefined();
			expect(findAgent(agents, "Valid")).toBeDefined();
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
