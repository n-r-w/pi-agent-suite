import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowCatalog, loadWorkflowConfiguration } from "./config";

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
	test("loads optional ordered kinds and skips unknown-kind workflows with valid siblings", async () => {
		const root = await createTemporaryDirectory();
		const directory = join(root, "workflows");
		await mkdir(directory);
		const yaml = `version: 3\n${workflowYaml("Classified")}`.replaceAll(
			"    prompt:",
			"    goal: Ready\n    prompt:",
		);
		await writeFile(join(directory, "good.yaml"), yaml);
		await writeFile(join(directory, "known.yaml"), `${yaml}kind: review\n`);
		await writeFile(join(directory, "unknown.yaml"), `${yaml}kind: missing\n`);
		const absent = await loadWorkflowCatalog(directory);
		expect(absent.workflows.map(({ id }) => id)).toEqual(["good"]);
		expect(absent.warnings).toHaveLength(2);
		await writeFile(
			join(root, "kinds.yaml"),
			"- id: review\n  description: Review work\n- id: task\n  description: Whole task\n",
		);
		const loaded = await loadWorkflowCatalog(directory);
		expect(loaded.kinds).toEqual([
			{ id: "review", description: "Review work" },
			{ id: "task", description: "Whole task" },
		]);
		expect(loaded.workflows.map(({ id, kind }) => [id, kind])).toEqual([
			["good", undefined],
			["known", "review"],
		]);
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings?.[0]?.message).toContain(
			"unknown workflow kind missing",
		);
		await writeFile(
			join(root, "kinds.yaml"),
			"- id: review\n  description: Review\n- id: review\n  description: Duplicate\n",
		);
		const invalid = await loadWorkflowCatalog(directory);
		expect(invalid.error?.message).toContain("duplicate workflow kind");
		expect(invalid.workflows).toEqual([]);
	});
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

	/**
	 * Proves that a file reference in any workflow string is replaced with the trimmed text of the file.
	 * Inputs and expected output: references in the workflow prompt and in a stage prompt, with paths relative to the workflow directory, return the file texts in their places.
	 * Edge case: a reference inside text keeps the text around it.
	 * Dependencies: isolated filesystem entries and catalog file reading.
	 */
	test("substitutes referenced files into workflow strings", async () => {
		const root = await createTemporaryDirectory();
		await mkdir(join(root, "rules"));
		await writeFile(join(root, "rules", "shared.md"), "1. Shared rule.\n");
		await writeFile(join(root, "inline.md"), "carefully\n");
		const yaml = workflowYaml("Included")
			.replace(
				"description: Included\n",
				'description: Included\nprompt: "Rules:\\n{{rules/shared.md}}"\n',
			)
			.replace("prompt: Start work", "prompt: Start {{ inline.md }} now");
		await writeFile(join(root, "included.yaml"), yaml);
		const result = await loadWorkflowCatalog(root);
		expect(result.warnings).toBeUndefined();
		const workflow = result.workflows[0];
		expect(workflow?.prompt).toBe("Rules:\n1. Shared rule.");
		expect(workflow?.stages[0]?.prompt).toBe("Start carefully now");
	});

	/**
	 * Proves that a reference to a missing file disables only the referencing workflow.
	 * Inputs and expected output: a valid sibling and a workflow that references a missing file return the sibling plus one warning that names the missing file.
	 * Edge case: the reference stands in a stage prompt, not in the workflow prompt.
	 * Dependencies: isolated filesystem entries and catalog file reading.
	 */
	test("skips a workflow that references a missing file", async () => {
		const root = await createTemporaryDirectory();
		await writeFile(join(root, "good.yaml"), workflowYaml("Good"));
		await writeFile(
			join(root, "broken.yaml"),
			workflowYaml("Broken").replace(
				"prompt: Start work",
				"prompt: Start {{rules/missing.md}}",
			),
		);
		const result = await loadWorkflowCatalog(root);
		expect(result.workflows.map(({ id }) => id)).toEqual(["good"]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]?.message).toContain(join(root, "broken.yaml"));
		expect(result.warnings?.[0]?.message).toContain(
			join(root, "rules", "missing.md"),
		);
	});
});

describe("workflow configuration", () => {
	test("uses the configured exit description path and validates its file atomically", async () => {
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
			await writeFile(join(bundled, file), "fixture");
		}
		const override = join(root, "exit.md");
		const config = join(root, "config.json");
		await writeFile(
			config,
			JSON.stringify({ exitDescriptionPromptFile: override }),
		);
		await expect(loadWorkflowConfiguration(config, bundled)).rejects.toThrow(
			override,
		);
		await writeFile(override, " \n\t ");
		await expect(loadWorkflowConfiguration(config, bundled)).rejects.toThrow(
			"empty",
		);
		await writeFile(override, "fixture exit description");
		expect(
			(await loadWorkflowConfiguration(config, bundled))
				.reminderToolCallInterval,
		).toBe(50);
	});
	/**
	 * Proves prompt defaults, a partial override, and the default reminder interval load atomically.
	 * Input and expected output: one prompt override and an omitted interval return trimmed prompts and interval 50.
	 * Edge case: omission uses the documented default without requiring a config file field.
	 * Dependencies: isolated prompt files and the workflow configuration loader.
	 */
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
		await writeFile(join(bundled, "exit-description.md"), "fixture");
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
		expect(
			(await loadWorkflowConfiguration(configPath, bundled))
				.reminderToolCallInterval,
		).toBe(50);
	});

	/**
	 * Proves valid configured reminder intervals are retained.
	 * Input and expected output: zero and a positive safe integer return unchanged.
	 * Edge case: zero disables reminders without being replaced by the default.
	 * Dependencies: isolated prompt files and the workflow configuration loader.
	 */
	test.each([0, 75])("retains reminder interval %i", async (interval) => {
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
			"exit-description.md",
		]) {
			await writeFile(join(bundled, file), "default");
		}
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({ reminderToolCallInterval: interval }),
		);

		expect(
			(await loadWorkflowConfiguration(configPath, bundled))
				.reminderToolCallInterval,
		).toBe(interval);
	});

	/** Proves malformed JSON, unknown keys, invalid fields, unreadable files, and empty prompts fail closed. */
	test.each([
		["malformed JSON", "{"],
		["unknown key", JSON.stringify({ unknown: "/tmp/x" })],
		[
			"relative path",
			JSON.stringify({ createDescriptionPromptFile: "relative.md" }),
		],
		["negative interval", JSON.stringify({ reminderToolCallInterval: -1 })],
		["fractional interval", JSON.stringify({ reminderToolCallInterval: 1.5 })],
		[
			"unsafe interval",
			JSON.stringify({ reminderToolCallInterval: Number.MAX_SAFE_INTEGER + 1 }),
		],
		["string interval", JSON.stringify({ reminderToolCallInterval: "50" })],
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
		await expect(
			loadWorkflowConfiguration(configPath, bundled),
		).rejects.toThrow(configPath);
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
			await expect(
				loadWorkflowConfiguration(configPath, bundled),
			).rejects.toThrow(configPath);
		}
	});
});
