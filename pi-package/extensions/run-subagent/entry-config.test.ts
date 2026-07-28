import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import { readConfig } from "./entry-config";

describe("subagents V2 entry config", () => {
	let suiteDir = "";
	let previousSuiteDir: string | undefined;

	beforeEach(() => {
		previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		suiteDir = mkdtempSync(join(tmpdir(), "subagents-v2-entry-config-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	});

	afterEach(() => {
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		rmSync(suiteDir, { recursive: true, force: true });
	});

	test("loads independent extension and tool description prompt files", async () => {
		// Purpose: each supported path must resolve independently without replacing defaults for omitted descriptions.
		// Input and expected output: absolute files with padded text produce trimmed config descriptions for only configured keys.
		// Edge case: extension guidance can be configured without customizing any tool description.
		// Dependencies: suite-owned config files and isolated description prompt files.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const descriptionFiles = {
			extensionDescriptionPromptFile: join(suiteDir, "extension.md"),
			startDescriptionPromptFile: join(suiteDir, "start.md"),
			steerDescriptionPromptFile: join(suiteDir, "steer.md"),
			waitDescriptionPromptFile: join(suiteDir, "wait.md"),
		};
		writeFileSync(
			descriptionFiles.extensionDescriptionPromptFile,
			"  custom extension  \n",
		);
		writeFileSync(
			descriptionFiles.startDescriptionPromptFile,
			"  custom start  \n",
		);
		writeFileSync(
			descriptionFiles.steerDescriptionPromptFile,
			"\ncustom steer\t",
		);
		writeFileSync(descriptionFiles.waitDescriptionPromptFile, " custom wait ");
		const cases = [
			{
				paths: {
					extensionDescriptionPromptFile:
						descriptionFiles.extensionDescriptionPromptFile,
				},
				descriptions: { extensionDescription: "custom extension" },
			},
			{
				paths: {
					startDescriptionPromptFile:
						descriptionFiles.startDescriptionPromptFile,
				},
				descriptions: { startDescription: "custom start" },
			},
			{
				paths: {
					startDescriptionPromptFile:
						descriptionFiles.startDescriptionPromptFile,
					steerDescriptionPromptFile:
						descriptionFiles.steerDescriptionPromptFile,
				},
				descriptions: {
					startDescription: "custom start",
					steerDescription: "custom steer",
				},
			},
			{
				paths: descriptionFiles,
				descriptions: {
					extensionDescription: "custom extension",
					startDescription: "custom start",
					steerDescription: "custom steer",
					waitDescription: "custom wait",
				},
			},
		] as const;

		for (const configCase of cases) {
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify(configCase.paths),
			);
			expect(await readConfig()).toEqual({
				enabled: true,
				maxDepth: 1,
				...configCase.descriptions,
			});
		}
	});

	test("fails closed for every invalid description path or file", async () => {
		// Purpose: no invalid configured description may allow a partially customized runtime.
		// Input and expected output: wrong types, empty or relative paths, unreadable files, and whitespace-only files disable config with no descriptions.
		// Edge case: each invalid case also configures one readable custom description that must not escape the failed parse.
		// Dependencies: suite-owned config files and isolated readable, missing, and empty prompt files.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const validFile = join(suiteDir, "valid.md");
		const whitespaceFile = join(suiteDir, "whitespace.md");
		writeFileSync(validFile, "valid custom description");
		writeFileSync(whitespaceFile, " \n\t ");
		const invalidCases: readonly Record<string, unknown>[] = [
			{
				startDescriptionPromptFile: validFile,
				extensionDescriptionPromptFile: join(suiteDir, "missing.md"),
			},
			{
				startDescriptionPromptFile: validFile,
				steerDescriptionPromptFile: 1,
			},
			{
				startDescriptionPromptFile: validFile,
				steerDescriptionPromptFile: "",
			},
			{
				startDescriptionPromptFile: validFile,
				steerDescriptionPromptFile: "relative.md",
			},
			{
				startDescriptionPromptFile: validFile,
				steerDescriptionPromptFile: join(suiteDir, "missing.md"),
			},
			{
				startDescriptionPromptFile: validFile,
				steerDescriptionPromptFile: whitespaceFile,
			},
		];

		for (const invalidCase of invalidCases) {
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify(invalidCase),
			);
			const config = await readConfig();
			expect({
				enabled: config.enabled,
				maxDepth: config.maxDepth,
				hasExtensionDescription: Reflect.has(config, "extensionDescription"),
				hasStartDescription: Reflect.has(config, "startDescription"),
				hasSteerDescription: Reflect.has(config, "steerDescription"),
				hasWaitDescription: Reflect.has(config, "waitDescription"),
				issue: typeof config.issue,
			}).toEqual({
				enabled: false,
				maxDepth: 1,
				hasExtensionDescription: false,
				hasStartDescription: false,
				hasSteerDescription: false,
				hasWaitDescription: false,
				issue: "string",
			});
		}
	});
});
