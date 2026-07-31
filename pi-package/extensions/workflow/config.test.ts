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
	return `description: ${description}\nstages:\n  - id: start\n    description: Start\n    initial: true\n  - id: done\n    description: Done\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n`;
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

	/** Proves one malformed, unknown-field, or invalid graph file rejects the catalog atomically. */
	test.each([
		["malformed", "bad.yaml", "stages: ["],
		["unknown field", "bad.yaml", `${workflowYaml("Bad")}extra: true\n`],
		[
			"mixed catalog",
			"bad.yaml",
			"description: Bad\nstages: []\ntransitions: []\n",
		],
	])("rejects %s with the file path", async (_case, fileName, content) => {
		const root = await createTemporaryDirectory();
		await writeFile(join(root, "good.yaml"), workflowYaml("Good"));
		await writeFile(join(root, fileName), content);
		const result = await loadWorkflowCatalog(root);
		expect(result.workflows).toEqual([]);
		expect(result.error?.message).toContain(join(root, fileName));
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
		await writeFile(join(bundled, "activate-description.md"), " activate \n");
		await writeFile(
			join(bundled, "transition-description.md"),
			" transition \n",
		);
		const override = join(root, "override.md");
		await writeFile(override, " custom activation \n");
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({ activateDescriptionPromptFile: override }),
		);
		expect(await loadWorkflowPrompts(configPath, bundled)).toEqual({
			extensionDescription: "guidelines",
			activateDescription: "custom activation",
			transitionDescription: "transition",
		});
	});

	/** Proves malformed JSON, unknown keys, relative paths, unreadable files, and empty prompts fail closed. */
	test.each([
		["malformed JSON", "{"],
		["unknown key", JSON.stringify({ unknown: "/tmp/x" })],
		[
			"relative path",
			JSON.stringify({ activateDescriptionPromptFile: "relative.md" }),
		],
	])("rejects %s", async (_case, config) => {
		const root = await createTemporaryDirectory();
		const bundled = join(root, "bundled");
		await mkdir(bundled);
		for (const file of [
			"extension-description.md",
			"activate-description.md",
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
});
