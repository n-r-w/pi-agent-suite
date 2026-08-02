import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CHILD_STARTUP_CONFIG,
	readChildStartupConfig,
} from "./child-startup-config";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const temporaryDirectories: string[] = [];
const originalSuiteDirectory = process.env[AGENT_SUITE_DIR_ENV];

/** Creates an isolated suite directory for one configuration scenario. */
async function createSuiteDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-child-startup-config-"));
	temporaryDirectories.push(directory);
	process.env[AGENT_SUITE_DIR_ENV] = directory;
	return directory;
}

/** Writes the shared child startup configuration under the suite-owned path. */
async function writeConfig(
	suiteDirectory: string,
	value: string,
): Promise<void> {
	const directory = join(suiteDirectory, "child-startup");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.json"), value, "utf8");
}

afterEach(async () => {
	if (originalSuiteDirectory === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = originalSuiteDirectory;
	}
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("child startup configuration", () => {
	test("uses documented defaults when the shared config file is absent", async () => {
		// Purpose: installations without an override must receive the documented recovery window.
		// Input and expected output: an empty suite returns ten retries with a fixed two-second delay.
		// Edge case: the child-startup directory itself is absent.
		// Dependencies: an isolated system-temporary suite directory and the production storage resolver.
		await createSuiteDirectory();

		expect(readChildStartupConfig()).toEqual(DEFAULT_CHILD_STARTUP_CONFIG);
	});

	test("loads valid shared authentication retry settings", async () => {
		// Purpose: both child launchers must consume one validated retry policy.
		// Input and expected output: explicit safe integers replace both default values.
		// Edge case: zero retries is valid and still permits the initial attempt.
		// Dependencies: an isolated system-temporary config file.
		const suiteDirectory = await createSuiteDirectory();
		await writeConfig(
			suiteDirectory,
			JSON.stringify({ authRetry: { maxRetries: 0, delayMs: 1 } }),
		);

		expect(readChildStartupConfig()).toEqual({
			authRetry: { maxRetries: 0, delayMs: 1 },
		});
	});

	test("rejects invalid shared configuration during startup", async () => {
		// Purpose: an explicit but invalid policy must stop extension startup instead of hiding the error.
		// Input and expected output: malformed JSON, unsupported keys, and invalid retry values throw.
		// Edge case: delay zero is invalid while retry zero remains valid.
		// Dependencies: isolated system-temporary config files rewritten between assertions.
		const suiteDirectory = await createSuiteDirectory();
		for (const value of [
			"{",
			JSON.stringify({ unsupported: true }),
			JSON.stringify({ authRetry: { maxRetries: -1, delayMs: 1 } }),
			JSON.stringify({ authRetry: { maxRetries: 1, delayMs: 0 } }),
		]) {
			await writeConfig(suiteDirectory, value);
			expect(() => readChildStartupConfig()).toThrow();
		}
	});
});
