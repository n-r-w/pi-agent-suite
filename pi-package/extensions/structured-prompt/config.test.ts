import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage.ts";
import { parsePromptConfig, readPromptConfig } from "./config.ts";

const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

afterEach(async () => {
	if (previousAgentSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("structured-prompt config", () => {
	test("uses enabled true when config is missing", async () => {
		// Purpose: prompt must be usable without setup because missing config enables the extension.
		// Input and expected output: no config file returns enabled true.
		// Edge case: the suite config directory is absent.
		// Dependencies: this test uses only temporary suite storage.
		await withIsolatedSuiteDir(async () => {
			const result = readPromptConfig();

			expect(result.kind).toBe("valid");
			if (result.kind !== "valid") {
				throw new Error(result.issue);
			}
			expect(result.config).toEqual({ enabled: true });
		});
	});

	test("accepts explicit enabled values", () => {
		// Purpose: users need one supported config key that can enable or disable the extension.
		// Input and expected output: enabled true and false are accepted as booleans.
		// Edge case: false is preserved and does not default back to true.
		// Dependencies: this test exercises the pure parser only.
		expect(parsePromptConfig({ enabled: true })).toEqual({
			kind: "valid",
			config: { enabled: true },
		});
		expect(parsePromptConfig({ enabled: false })).toEqual({
			kind: "valid",
			config: { enabled: false },
		});
	});

	test("rejects unsupported keys and invalid enabled values", () => {
		// Purpose: config validation must fail closed for unsupported public contract changes.
		// Input and expected output: unsupported keys and non-boolean enabled values are invalid.
		// Edge case: an empty object is valid and uses defaults.
		// Dependencies: this test exercises the pure parser only.
		expect(parsePromptConfig({}).kind).toBe("valid");
		expect(parsePromptConfig({ shortcut: "ctrl+alt+p" }).kind).toBe("invalid");
		expect(parsePromptConfig({ enabled: "true" }).kind).toBe("invalid");
		expect(parsePromptConfig(null).kind).toBe("invalid");
	});

	test("reports malformed JSON as invalid", async () => {
		// Purpose: a broken config file must not register a partially configured extension.
		// Input and expected output: malformed JSON returns an invalid result.
		// Edge case: the file exists but cannot be parsed.
		// Dependencies: this test uses only temporary suite storage.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writePromptConfigText(suiteDir, "{");

			const result = readPromptConfig();

			expect(result.kind).toBe("invalid");
		});
	});
});

async function withIsolatedSuiteDir(
	testBody: (suiteDir: string) => Promise<void>,
): Promise<void> {
	const suiteDir = await mkdtemp(join(tmpdir(), "structured-prompt-config-"));
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await testBody(suiteDir);
}

async function writePromptConfigText(
	suiteDir: string,
	content: string,
): Promise<void> {
	const configDir = join(suiteDir, "structured-prompt");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), content);
}
