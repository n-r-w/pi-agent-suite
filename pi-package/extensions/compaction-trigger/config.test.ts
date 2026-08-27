import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompactionTriggerConfig } from "./config";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

afterEach(async () => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}
	await Promise.all(
		tempDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

/** Creates isolated agent-suite storage and writes an optional extension config. */
async function createConfigFixture(config?: unknown): Promise<string> {
	const suiteDir = await mkdtemp(
		join(tmpdir(), "pi-compaction-trigger-config-"),
	);
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	if (config === undefined) {
		return suiteDir;
	}
	const extensionDir = join(suiteDir, "compaction-trigger");
	await mkdir(extensionDir);
	await writeFile(join(extensionDir, "config.json"), JSON.stringify(config));
	return suiteDir;
}

describe("compaction-trigger config", () => {
	test("uses enabled zero-tolerance defaults when config is missing", async () => {
		// Purpose: installing the new config support must preserve existing trigger behavior.
		// Input and expected output: missing config returns enabled with zero percent tolerance.
		// Edge case: the agent-suite directory exists without an extension directory.
		// Dependencies: isolated agent-suite storage.
		await createConfigFixture();

		expect(readCompactionTriggerConfig()).toEqual({
			kind: "enabled",
			config: { tolerancePercent: 0 },
		});
	});

	test("accepts disabled and unbounded non-negative tolerance settings", async () => {
		// Purpose: users must control both extension activation and thresholds beyond one artificial context window.
		// Input and expected output: disabled config disables; 250 and 12.5 percent remain unchanged.
		// Edge case: tolerance exceeds 100 percent and can be fractional.
		// Dependencies: isolated agent-suite storage and strict config parsing.
		await createConfigFixture({ enabled: false, tolerancePercent: 250 });
		expect(readCompactionTriggerConfig()).toEqual({ kind: "disabled" });

		await createConfigFixture({ enabled: true, tolerancePercent: 250 });
		expect(readCompactionTriggerConfig()).toEqual({
			kind: "enabled",
			config: { tolerancePercent: 250 },
		});

		await createConfigFixture({ tolerancePercent: 12.5 });
		expect(readCompactionTriggerConfig()).toEqual({
			kind: "enabled",
			config: { tolerancePercent: 12.5 },
		});
	});

	test("rejects malformed JSON, invalid values, and unsupported fields", async () => {
		// Purpose: invalid safety settings must not silently fall back to a different threshold.
		// Input and expected output: malformed JSON, invalid types, negative or non-finite values, and unknown keys return invalid.
		// Edge case: JSON converts non-finite numbers to null, which must remain invalid instead of selecting the default.
		// Dependencies: isolated agent-suite storage and strict config parsing.
		const malformedSuiteDir = await createConfigFixture();
		const malformedExtensionDir = join(malformedSuiteDir, "compaction-trigger");
		await mkdir(malformedExtensionDir);
		await writeFile(join(malformedExtensionDir, "config.json"), "{");
		expect(readCompactionTriggerConfig()).toEqual({ kind: "invalid" });

		const invalidConfigs: unknown[] = [
			{ enabled: "yes" },
			{ tolerancePercent: -1 },
			{ tolerancePercent: "250" },
			{ tolerancePercent: Number.NaN },
			{ tolerancePercent: Number.POSITIVE_INFINITY },
			{ enabled: true, extra: true },
			[],
		];

		for (const config of invalidConfigs) {
			await createConfigFixture(config);
			expect(readCompactionTriggerConfig()).toEqual({ kind: "invalid" });
		}
	});
});
