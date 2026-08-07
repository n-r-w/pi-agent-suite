import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type KnowledgeConfigParseOptions,
	parseKnowledgeConfig,
	readKnowledgeConfig,
} from "./config";

const temporaryDirectories: string[] = [];

/** Removes every isolated configuration directory created by a test. */
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

/** Creates an isolated agent-suite directory under the system temporary directory. */
async function createSuiteDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "knowledge-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Creates parse options that validate branch and remote names without consulting real Git state. */
function parseOptions(agentSuiteDir: string): KnowledgeConfigParseOptions {
	return {
		agentSuiteDir,
		isGitBranchName: (name) => name !== "bad branch",
		isGitRemoteName: (name) => name !== "bad remote",
	};
}

/** Writes raw optional configuration content in an isolated suite directory. */
async function writeConfigText(
	agentSuiteDir: string,
	content: string,
): Promise<void> {
	const directory = join(agentSuiteDir, "knowledge");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.json"), content);
}

describe("knowledge configuration", () => {
	/**
	 * Verifies that an absent file resolves every default while model and
	 * thinking omissions remain deferred to operation start.
	 */
	test("loads defaults when config.json is absent", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();

		// ACT
		const result = readKnowledgeConfig(parseOptions(agentSuiteDir));

		// ASSERT
		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			return;
		}
		expect(result.config).toMatchObject({
			enabled: true,
			dataDir: join(agentSuiteDir, "knowledge", "data"),
			globalTokenLimit: 5_000,
			localTokenLimit: 5_000,
			primaryBranches: ["main", "master"],
			preferredRemotes: ["origin"],
			extraction: {
				model: undefined,
				thinking: undefined,
				retryCount: 1,
			},
			merge: {
				model: undefined,
				thinking: undefined,
				retryCount: 2,
			},
		});
		expect(result.config.extraction.systemPrompt).toBeDefined();
		expect(result.config.extraction.taskPrompt).toBeDefined();
		expect(result.config.merge.systemPrompt).toBeDefined();
		expect(result.config.merge.taskPrompt).toBeDefined();
	});

	/** Verifies that every top-level and nested setting can be overridden independently. */
	test("accepts independent overrides", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();
		const dataDir = join(agentSuiteDir, "catalog");
		const extractionSystemPrompt = join(agentSuiteDir, "extract-system.md");
		const extractionTaskPrompt = join(agentSuiteDir, "extract-task.md");
		const mergeSystemPrompt = join(agentSuiteDir, "merge-system.md");
		const mergeTaskPrompt = join(agentSuiteDir, "merge.md");
		await writeFile(extractionSystemPrompt, "Extract durable knowledge.");
		await writeFile(extractionTaskPrompt, "Summarize this branch session.");
		await writeFile(mergeSystemPrompt, "Merge system rules.");
		await writeFile(mergeTaskPrompt, "Merge durable knowledge.");
		const value = {
			enabled: false,
			dataDir,
			globalTokenLimit: 101,
			localTokenLimit: 202,
			primaryBranches: ["trunk", "release/stable"],
			preferredRemotes: ["origin", "upstream"],
			extraction: {
				model: "openai/gpt-5.6",
				thinking: "high",
				systemPromptFile: extractionSystemPrompt,
				taskPromptFile: extractionTaskPrompt,
				retryCount: 3,
			},
			merge: {
				model: "anthropic/claude",
				thinking: "xhigh",
				systemPromptFile: mergeSystemPrompt,
				taskPromptFile: mergeTaskPrompt,
				retryCount: 4,
			},
		} as const;

		// ACT
		const result = parseKnowledgeConfig(value, parseOptions(agentSuiteDir));

		// ASSERT
		expect(result).toEqual({
			kind: "valid",
			config: {
				...value,
				extraction: {
					model: value.extraction.model,
					thinking: value.extraction.thinking,
					systemPrompt: "Extract durable knowledge.",
					taskPrompt: "Summarize this branch session.",
					retryCount: value.extraction.retryCount,
				},
				merge: {
					model: value.merge.model,
					thinking: value.merge.thinking,
					systemPrompt: "Merge system rules.",
					taskPrompt: "Merge durable knowledge.",
					retryCount: value.merge.retryCount,
				},
			},
		});
	});

	/**
	 * Verifies strict rejection for unknown fields and every invalid value class,
	 * including invalid Git branch names and unavailable prompts.
	 */
	test("rejects unknown fields and invalid values", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();
		const emptyPrompt = join(agentSuiteDir, "empty.md");
		await writeFile(emptyPrompt, "");
		const missingPrompt = join(agentSuiteDir, "missing.md");
		const invalidValues: readonly unknown[] = [
			null,
			[],
			{ unknown: true },
			{ enabled: "true" },
			{ dataDir: "relative/data" },
			{ globalTokenLimit: 0 },
			{ localTokenLimit: Number.MAX_SAFE_INTEGER + 1 },
			{ primaryBranches: [] },
			{ primaryBranches: ["main", "main"] },
			{ primaryBranches: ["bad branch"] },
			{ preferredRemotes: [] },
			{ preferredRemotes: ["origin", "origin"] },
			{ preferredRemotes: ["bad remote"] },
			{ extraction: { unknown: true } },
			{ extraction: { model: "" } },
			{ extraction: { thinking: "max" } },
			{ extraction: { retryCount: -1 } },
			{ extraction: { systemPromptFile: "relative.md" } },
			{ extraction: { taskPromptFile: "relative.md" } },
			{ extraction: { systemPromptFile: emptyPrompt } },
			{ extraction: { taskPromptFile: emptyPrompt } },
			{ merge: { unknown: true } },
			{ merge: { model: "" } },
			{ merge: { thinking: "unknown" } },
			{ merge: { retryCount: 1.5 } },
			{ merge: { systemPromptFile: missingPrompt } },
			{ merge: { taskPromptFile: "relative.md" } },
			{ merge: { taskPromptFile: emptyPrompt } },
		];

		// ACT
		const results = invalidValues.map((value) =>
			parseKnowledgeConfig(value, parseOptions(agentSuiteDir)),
		);

		// ASSERT
		expect(results.every((result) => result.kind === "invalid")).toBe(true);
	});

	/** Verifies that malformed present configuration never falls back to defaults. */
	test("disables knowledge for malformed configuration JSON", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();
		await writeConfigText(agentSuiteDir, "{");

		// ACT
		const result = readKnowledgeConfig(parseOptions(agentSuiteDir));

		// ASSERT
		expect(result.kind).toBe("invalid");
	});
});
