import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	test("merges project agents while preserving exact case variants", async () => {
		// Purpose: one project registry must extend both main-agent selection and Subagents without collapsing distinct agent names.
		// Input and expected output: project main, subagent, and both definitions extend the global set, while builder and Builder remain separate agents.
		// Edge case: exact case-sensitive identity still permits a project file to override an NFC-equivalent global name.
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

			expect(findAgent(agents, "Builder")).toMatchObject({
				id: "Builder",
				type: "main",
				prompt: "Global builder",
			});
			expect(findAgent(agents, "builder")).toMatchObject({
				id: "builder",
				type: "main",
				prompt: "Project builder",
			});
			expect(findAgent(agents, "GlobalOnly")?.type).toBe("subagent");
			expect(findAgent(agents, "ProjectWorker")?.type).toBe("subagent");
			expect(findAgent(agents, "ProjectHybrid")?.type).toBe("both");
			expect(agents).toHaveLength(5);
		});
	});

	test("preserves valid workflow policies and rejects padded names", async () => {
		// Purpose: agent frontmatter must preserve valid policy states without admitting names outside the shared single-line contract.
		// Input and expected output: absent, empty, and mixed-case explicit lists remain available, while a padded name invalidates its agent.
		// Edge case: case remains significant while identity values normalize only canonical Unicode composition.
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
			expect(findAgent(agents, "Spaced")).toBeUndefined();
		});
	});

	test.each([
		["NFC-equivalent duplicates", "[Café, Café]"],
		["wrong primitive", "review"],
		["empty item", '[Review, ""]'],
		["whitespace item", '[Review, "   "]'],
	])("rejects invalid workflows frontmatter: %s", async (_case, workflows) => {
		// Purpose: malformed workflow policy must make only that agent unavailable.
		// Input and expected output: each invalid workflows value produces no parsed agent.
		// Edge case: duplicate detection normalizes Unicode without folding case while other agent files remain loadable.
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

	test("keeps a differently cased global agent beside an invalid project file", async () => {
		// Purpose: a broken project definition must reserve only its exact NFC identity.
		// Input and expected output: malformed local HELPER does not hide distinct global helper, while unrelated agents remain available.
		// Edge case: case-sensitive identity prevents an invalid name variant from suppressing another agent.
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

			expect(findAgent(agents, "helper")).toBeDefined();
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

/** Finds one logical agent ID using exact NFC identity. */
function findAgent(
	agents: readonly AgentDefinition[],
	agentId: string,
): AgentDefinition | undefined {
	const matchKey = agentId.normalize("NFC");
	return agents.find((agent) => agent.id.normalize("NFC") === matchKey);
}
