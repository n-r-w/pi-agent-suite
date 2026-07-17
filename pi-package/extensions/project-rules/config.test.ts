import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import { parseProjectRulesConfig, readProjectRulesConfig } from "./config";

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

describe("project-rules config", () => {
	test("uses enabled true and .pi/rules when config is missing", async () => {
		// Purpose: project rules must work without setup while staying isolated from other .pi resources.
		// Input and expected output: no config file returns enabled true and rulesDir .pi/rules.
		// Edge case: the suite config directory is absent.
		// Dependencies: this test uses only temporary suite storage.
		await withIsolatedSuiteDir(async () => {
			const result = readProjectRulesConfig();

			expect(result).toEqual({
				kind: "valid",
				config: { enabled: true, rulesDir: ".pi/rules" },
			});
		});
	});

	test("accepts supported keys and applies defaults", () => {
		// Purpose: users need stable config keys for enabling and selecting the rules directory.
		// Input and expected output: supported keys are preserved, omitted keys use defaults.
		// Edge case: enabled false is preserved and does not default back to true.
		// Dependencies: this test exercises the pure parser only.
		expect(parseProjectRulesConfig({})).toEqual({
			kind: "valid",
			config: { enabled: true, rulesDir: ".pi/rules" },
		});
		expect(parseProjectRulesConfig({ enabled: false })).toEqual({
			kind: "valid",
			config: { enabled: false, rulesDir: ".pi/rules" },
		});
		expect(parseProjectRulesConfig({ rulesDir: "rules" })).toEqual({
			kind: "valid",
			config: { enabled: true, rulesDir: "rules" },
		});
	});

	test("rejects unsupported keys and invalid field values", () => {
		// Purpose: config validation must fail closed for unsupported public contract changes.
		// Input and expected output: unsupported keys, non-boolean enabled, and non-string rulesDir are invalid.
		// Edge case: non-object values are invalid before field parsing.
		// Dependencies: this test exercises the pure parser only.
		expect(parseProjectRulesConfig({ recursive: true }).kind).toBe("invalid");
		expect(parseProjectRulesConfig({ enabled: "true" }).kind).toBe("invalid");
		expect(parseProjectRulesConfig({ rulesDir: [".pi"] }).kind).toBe("invalid");
		expect(parseProjectRulesConfig(null).kind).toBe("invalid");
	});

	test("rejects absolute rulesDir and path traversal", () => {
		// Purpose: rulesDir must stay a cwd-relative entry point even when symlink targets may point anywhere.
		// Input and expected output: absolute and parent-traversing paths are invalid.
		// Edge case: nested relative directories are accepted.
		// Dependencies: this test exercises the pure parser only.
		expect(parseProjectRulesConfig({ rulesDir: "/tmp/rules" }).kind).toBe(
			"invalid",
		);
		expect(parseProjectRulesConfig({ rulesDir: "../rules" }).kind).toBe(
			"invalid",
		);
		expect(parseProjectRulesConfig({ rulesDir: "rules/../other" }).kind).toBe(
			"invalid",
		);
		expect(parseProjectRulesConfig({ rulesDir: "nested/rules" }).kind).toBe(
			"valid",
		);
	});

	test("reports malformed JSON as invalid", async () => {
		// Purpose: a broken config file must not append partially configured project rules.
		// Input and expected output: malformed JSON returns an invalid result.
		// Edge case: the file exists but cannot be parsed.
		// Dependencies: this test uses only temporary suite storage.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeProjectRulesConfigText(suiteDir, "{");

			const result = readProjectRulesConfig();

			expect(result.kind).toBe("invalid");
		});
	});
});

async function withIsolatedSuiteDir(
	testBody: (suiteDir: string) => Promise<void>,
): Promise<void> {
	const suiteDir = await mkdtemp(join(tmpdir(), "project-rules-config-"));
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await testBody(suiteDir);
}

async function writeProjectRulesConfigText(
	suiteDir: string,
	content: string,
): Promise<void> {
	const configDir = join(suiteDir, "project-rules");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), content);
}
