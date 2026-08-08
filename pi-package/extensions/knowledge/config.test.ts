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
				maxFractionDenominator: 8,
				initialFraction: 2 / 3,
				reductionCoefficient: 3 / 4,
			},
			mergeLocal: {
				model: undefined,
				thinking: undefined,
				maxFractionDenominator: 8,
				initialFraction: 2 / 3,
				reductionCoefficient: 3 / 4,
			},
			mergeGlobal: {
				model: undefined,
				thinking: undefined,
				maxFractionDenominator: 8,
				initialFraction: 2 / 3,
				reductionCoefficient: 3 / 4,
			},
		});
		expect(result.config.extraction.systemPrompt).toBeDefined();
		expect(result.config.extraction.taskPrompt).toBeDefined();
		expect(result.config.mergeLocal.systemPrompt).toBeDefined();
		expect(result.config.mergeLocal.taskPrompt).toBeDefined();
		expect(result.config.mergeGlobal.systemPrompt).toBeDefined();
		expect(result.config.mergeGlobal.taskPrompt).toBeDefined();
	});

	/** Verifies that every top-level and nested setting can be overridden independently. */
	test("accepts independent overrides", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();
		const dataDir = join(agentSuiteDir, "catalog");
		const extractionSystemPrompt = join(agentSuiteDir, "extract-system.md");
		const extractionTaskPrompt = join(agentSuiteDir, "extract-task.md");
		const mergeLocalSystemPrompt = join(agentSuiteDir, "merge-local-system.md");
		const mergeLocalTaskPrompt = join(agentSuiteDir, "merge-local.md");
		const mergeGlobalSystemPrompt = join(
			agentSuiteDir,
			"merge-global-system.md",
		);
		const mergeGlobalTaskPrompt = join(agentSuiteDir, "merge-global.md");
		await writeFile(extractionSystemPrompt, "Extract durable knowledge.");
		await writeFile(extractionTaskPrompt, "Summarize this branch session.");
		await writeFile(mergeLocalSystemPrompt, "Merge local system rules.");
		await writeFile(mergeLocalTaskPrompt, "Merge local durable knowledge.");
		await writeFile(mergeGlobalSystemPrompt, "Merge global system rules.");
		await writeFile(mergeGlobalTaskPrompt, "Merge global durable knowledge.");
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
				maxFractionDenominator: 16,
				initialFraction: "1/2",
				reductionCoefficient: "1/2",
			},
			mergeLocal: {
				model: "anthropic/claude",
				thinking: "xhigh",
				systemPromptFile: mergeLocalSystemPrompt,
				taskPromptFile: mergeLocalTaskPrompt,
				maxFractionDenominator: 32,
				initialFraction: "5/8",
				reductionCoefficient: "3/4",
			},
			mergeGlobal: {
				model: "openai/gpt-5",
				thinking: "low",
				systemPromptFile: mergeGlobalSystemPrompt,
				taskPromptFile: mergeGlobalTaskPrompt,
				maxFractionDenominator: 4,
				initialFraction: "3/4",
				reductionCoefficient: "1/2",
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
					maxFractionDenominator: value.extraction.maxFractionDenominator,
					initialFraction: 1 / 2,
					reductionCoefficient: 1 / 2,
				},
				mergeLocal: {
					model: value.mergeLocal.model,
					thinking: value.mergeLocal.thinking,
					systemPrompt: "Merge local system rules.",
					taskPrompt: "Merge local durable knowledge.",
					maxFractionDenominator: value.mergeLocal.maxFractionDenominator,
					initialFraction: 5 / 8,
					reductionCoefficient: 3 / 4,
				},
				mergeGlobal: {
					model: value.mergeGlobal.model,
					thinking: value.mergeGlobal.thinking,
					systemPrompt: "Merge global system rules.",
					taskPrompt: "Merge global durable knowledge.",
					maxFractionDenominator: value.mergeGlobal.maxFractionDenominator,
					initialFraction: 3 / 4,
					reductionCoefficient: 1 / 2,
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
			{ extraction: { maxFractionDenominator: -1 } },
			{ extraction: { systemPromptFile: "relative.md" } },
			{ extraction: { taskPromptFile: "relative.md" } },
			{ extraction: { systemPromptFile: emptyPrompt } },
			{ extraction: { taskPromptFile: emptyPrompt } },
			{ extraction: { initialFraction: "0.5" } },
			{ extraction: { initialFraction: "3/2" } },
			{ extraction: { initialFraction: "1/9" } },
			{ extraction: { reductionCoefficient: "x" } },
			{ mergeLocal: { unknown: true } },
			{ mergeLocal: { model: "" } },
			{ mergeLocal: { thinking: "unknown" } },
			{ mergeLocal: { maxFractionDenominator: 1.5 } },
			{ mergeLocal: { systemPromptFile: missingPrompt } },
			{ mergeLocal: { taskPromptFile: "relative.md" } },
			{ mergeLocal: { taskPromptFile: emptyPrompt } },
			{ mergeLocal: { initialFraction: "2" } },
			{ mergeGlobal: { unknown: true } },
			{ mergeGlobal: { model: "" } },
			{ mergeGlobal: { thinking: "unknown" } },
			{ mergeGlobal: { maxFractionDenominator: 3 } },
			{ mergeGlobal: { maxFractionDenominator: 33 } },
			{ mergeGlobal: { systemPromptFile: missingPrompt } },
			{ mergeGlobal: { taskPromptFile: "relative.md" } },
			{ mergeGlobal: { taskPromptFile: emptyPrompt } },
			{ mergeGlobal: { reductionCoefficient: "0.5" } },
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

	/** Verifies that the removed merge key fails closed without a legacy alias. */
	test("rejects the legacy merge key without fallback", async () => {
		// ARRANGE
		const agentSuiteDir = await createSuiteDirectory();

		// ACT
		const result = parseKnowledgeConfig(
			{ merge: { retryCount: 2 } },
			parseOptions(agentSuiteDir),
		);

		// ASSERT
		expect(result.kind).toBe("invalid");
	});
});
