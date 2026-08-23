import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowCatalog, loadWorkflowPrompts } from "./config";

const temporaryDirectories: string[] = [];

/** Creates one isolated system-temporary fixture owned by the current test. */
async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-workflow-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Creates one minimal valid workflow YAML document. */
function workflowYaml(description: string): string {
	return `description: ${description}\nstages:\n  - id: start\n    description: Start\n    prompt: Start work\n    initial: true\n  - id: done\n    description: Done\n    prompt: Finish work\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n`;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("workflow catalog configuration", () => {
	/** Proves a missing or empty workflow directory is a quiet inactive catalog. */
	test("returns an empty catalog for missing and empty directories", async () => {
		const root = await createTemporaryDirectory();
		expect(await loadWorkflowCatalog(join(root, "missing"))).toEqual({
			workflows: [],
		});
		await mkdir(join(root, "empty"));
		expect(await loadWorkflowCatalog(join(root, "empty"))).toEqual({
			workflows: [],
		});
	});

	/** Proves .yaml files use filename IDs and deterministic lexical ordering. */
	test("loads only yaml workflows in lexical order", async () => {
		const root = await createTemporaryDirectory();
		await writeFile(join(root, "b.yaml"), workflowYaml("B"));
		await writeFile(join(root, "a.yaml"), workflowYaml("A"));
		await writeFile(join(root, "ignored.yml"), workflowYaml("Ignored"));
		const result = await loadWorkflowCatalog(root);
		expect(result.error).toBeUndefined();
		expect(result.workflows.map(({ id }) => id)).toEqual(["a", "b"]);
	});

	/**
	 * Proves catalog YAML preserves ordered duplicate trigger objects in normalized workflow state.
	 * Input and expected output: the initial stage lists local, global, then local triggers in the same order.
	 * Edge case: the target stage omits triggers and receives an empty list.
	 * Dependencies: YAML parsing and workflow stage validation.
	 */
	test("loads ordered workflow stage triggers", async () => {
		const root = await createTemporaryDirectory();
		const yaml = workflowYaml("Triggered").replace(
			"    initial: true\n",
			"    initial: true\n    triggers:\n      - type: local_knowledge_accumulation\n      - type: global_knowledge_accumulation\n      - type: local_knowledge_accumulation\n",
		);
		await writeFile(join(root, "triggered.yaml"), yaml);

		const result = await loadWorkflowCatalog(root);

		expect(result.error).toBeUndefined();
		expect(result.workflows[0]?.stages[0]?.triggers).toEqual([
			{ type: "local_knowledge_accumulation" },
			{ type: "global_knowledge_accumulation" },
			{ type: "local_knowledge_accumulation" },
		]);
		expect(result.workflows[0]?.stages[1]?.triggers).toEqual([]);
	});

	/**
	 * Proves invalid workflow files do not suppress valid catalog siblings.
	 * Inputs and expected output: one valid file plus one malformed, unknown-field, or invalid-graph file returns the valid workflow and one repair-relevant warning.
	 * Edge case: invalid files sort both before and after the valid file.
	 * Dependencies: isolated catalog files, YAML parsing, and workflow graph validation.
	 */
	test.each([
		["malformed after valid", "z-bad.yaml", "stages: [", undefined],
		[
			"unknown field before valid",
			"bad.yaml",
			`${workflowYaml("Bad")}extra: true\n`,
			"workflow contains an unsupported key",
		],
		[
			"invalid graph before valid",
			"bad.yaml",
			"description: Bad\nstages: []\ntransitions: []\n",
			"workflow must have exactly one initial stage",
		],
	] as const)("skips %s without rejecting valid siblings", async (_case, fileName, content, expectedIssue) => {
		const root = await createTemporaryDirectory();
		const filePath = join(root, fileName);
		await writeFile(join(root, "good.yaml"), workflowYaml("Good"));
		await writeFile(filePath, content);
		const result = await loadWorkflowCatalog(root);
		expect(result.workflows.map(({ id }) => id)).toEqual(["good"]);
		expect(result.error).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		const warning = result.warnings?.[0];
		if (warning === undefined) {
			throw new Error("workflow warning missing");
		}
		expect(warning.message).toContain(filePath);
		expect(warning.message.replace(filePath, "").trim().length).toBeGreaterThan(
			0,
		);
		if (expectedIssue !== undefined) {
			// Stable validation rules prove repair details without coupling to YAML parser wording.
			expect(warning.message).toContain(expectedIssue);
		}
	});

	/**
	 * Proves a per-entry read failure disables only the unreadable workflow.
	 * Inputs and expected output: a readable valid file and a directory named as YAML return the valid workflow plus one warning with the unreadable path and issue.
	 * Edge case: the workflow directory itself remains readable, so the failure belongs to one catalog entry.
	 * Dependencies: isolated filesystem entries and catalog file reading.
	 */
	test("skips an unreadable workflow entry", async () => {
		const root = await createTemporaryDirectory();
		const unreadablePath = join(root, "unreadable.yaml");
		await writeFile(join(root, "good.yaml"), workflowYaml("Good"));
		await mkdir(unreadablePath);
		const result = await loadWorkflowCatalog(root);
		expect(result.workflows.map(({ id }) => id)).toEqual(["good"]);
		expect(result.error).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		const warning = result.warnings?.[0];
		if (warning === undefined) {
			throw new Error("unreadable workflow warning missing");
		}
		expect(warning.message).toContain(unreadablePath);
		expect(
			warning.message.replace(unreadablePath, "").trim().length,
		).toBeGreaterThan(0);
	});
});

describe("workflow prompt configuration", () => {
	/** Proves bundled defaults and partial absolute overrides are loaded and trimmed atomically. */
	test("loads defaults and one configured override", async () => {
		const root = await createTemporaryDirectory();
		const bundled = join(root, "bundled");
		await mkdir(bundled);
		await writeFile(
			join(bundled, "extension-description.md"),
			" guidelines \n",
		);
		await writeFile(join(bundled, "create-description.md"), " create \n");
		await writeFile(join(bundled, "activate-description.md"), " activate \n");
		await writeFile(join(bundled, "get-stage-description.md"), " get stage \n");
		await writeFile(
			join(bundled, "edit-stage-description.md"),
			" edit stage \n",
		);
		await writeFile(
			join(bundled, "transition-description.md"),
			" transition \n",
		);
		const override = join(root, "override.md");
		await writeFile(override, " custom creation \n");
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({ createDescriptionPromptFile: override }),
		);
		expect(await loadWorkflowPrompts(configPath, bundled)).toEqual({
			extensionDescription: "guidelines",
			createDescription: "custom creation",
			activateDescription: "activate",
			getStageDescription: "get stage",
			editStageDescription: "edit stage",
			transitionDescription: "transition",
		});
	});

	/** Proves malformed JSON, unknown keys, relative paths, unreadable files, and empty prompts fail closed. */
	test.each([
		["malformed JSON", "{"],
		["unknown key", JSON.stringify({ unknown: "/tmp/x" })],
		[
			"relative path",
			JSON.stringify({ createDescriptionPromptFile: "relative.md" }),
		],
	])("rejects %s", async (_case, config) => {
		const root = await createTemporaryDirectory();
		const bundled = join(root, "bundled");
		await mkdir(bundled);
		for (const file of [
			"extension-description.md",
			"create-description.md",
			"activate-description.md",
			"get-stage-description.md",
			"edit-stage-description.md",
			"transition-description.md",
		]) {
			await writeFile(join(bundled, file), "default");
		}
		const configPath = join(root, "config.json");
		await writeFile(configPath, config);
		await expect(loadWorkflowPrompts(configPath, bundled)).rejects.toThrow(
			configPath,
		);
	});

	/**
	 * Proves createDescriptionPromptFile uses the shared readability and non-empty-content contract.
	 * Input and expected output: missing and whitespace-only absolute files reject the complete prompt load.
	 * Edge case: both failures are attributed to the configuration file path.
	 * Dependencies: isolated temporary files and the workflow prompt loader.
	 */
	test("rejects unreadable and empty create description overrides", async () => {
		const root = await createTemporaryDirectory();
		const bundled = join(root, "bundled");
		await mkdir(bundled);
		for (const file of [
			"extension-description.md",
			"create-description.md",
			"activate-description.md",
			"get-stage-description.md",
			"edit-stage-description.md",
			"transition-description.md",
		]) {
			await writeFile(join(bundled, file), "default");
		}
		const configPath = join(root, "config.json");
		for (const override of [join(root, "missing.md"), join(root, "empty.md")]) {
			if (override.endsWith("empty.md")) {
				await writeFile(override, " \n\t ");
			}
			await writeFile(
				configPath,
				JSON.stringify({ createDescriptionPromptFile: override }),
			);
			await expect(loadWorkflowPrompts(configPath, bundled)).rejects.toThrow(
				configPath,
			);
		}
	});
});
