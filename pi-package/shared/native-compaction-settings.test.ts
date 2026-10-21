import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeCompactionSettings } from "./native-compaction-settings";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const tempDirs: string[] = [];
const previousAgentDir = process.env[AGENT_DIR_ENV];

afterEach(async () => {
	if (previousAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = previousAgentDir;
	}
	await Promise.all(
		tempDirs
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

/** Creates isolated agent and project directories for one settings read. */
async function createSettingsFixture(): Promise<{
	readonly agentDir: string;
	readonly cwd: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-native-compaction-settings-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	process.env[AGENT_DIR_ENV] = agentDir;
	return { agentDir, cwd };
}

/** Writes one native Pi settings file under the supplied settings directory. */
async function writeSettings(path: string, settings: unknown): Promise<void> {
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "settings.json"), JSON.stringify(settings));
}

describe("native compaction settings", () => {
	test("returns invalid for malformed selected-model overrides", async () => {
		const { agentDir, cwd } = await createSettingsFixture();
		for (const override of [
			{ reserveTokens: -1 },
			{ keepRecentTokens: "4000" },
			null,
		]) {
			await writeSettings(agentDir, {
				compaction: { modelOverrides: { "test/selected": override } },
			});
			expect(
				readNativeCompactionSettings(cwd, { provider: "test", id: "selected" }),
			).toEqual({ status: "invalid" });
		}
	});

	test("returns selected-model token overrides with native compaction enabled or disabled", async () => {
		const { agentDir, cwd } = await createSettingsFixture();
		for (const enabled of [true, false]) {
			await writeSettings(agentDir, {
				compaction: {
					enabled,
					reserveTokens: 16_000,
					keepRecentTokens: 20_000,
					modelOverrides: {
						"test/selected": { reserveTokens: 8_000, keepRecentTokens: 4_000 },
					},
				},
			});
			expect(
				readNativeCompactionSettings(cwd, { provider: "test", id: "selected" }),
			).toEqual({
				status: enabled ? "enabled" : "disabled",
				reserveTokens: 8_000,
				keepRecentTokens: 4_000,
			});
		}
	});

	test("uses ordinary settings and defaults for missing model token overrides", async () => {
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: {
				keepRecentTokens: 7_000,
				modelOverrides: { "test/selected": { reserveTokens: 8_000 } },
			},
		});
		expect(
			readNativeCompactionSettings(cwd, { provider: "test", id: "selected" }),
		).toEqual({
			status: "enabled",
			reserveTokens: 8_000,
			keepRecentTokens: 7_000,
		});
		for (const model of [
			undefined,
			{ provider: "other", id: "selected" },
			{ provider: "test", id: "other" },
		]) {
			expect(readNativeCompactionSettings(cwd, model)).toEqual({
				status: "enabled",
				reserveTokens: 16_384,
				keepRecentTokens: 7_000,
			});
		}
	});

	test("uses Pi defaults when compaction settings are absent", async () => {
		const { cwd } = await createSettingsFixture();
		expect(
			readNativeCompactionSettings(cwd, { provider: "test", id: "selected" }),
		).toEqual({
			status: "enabled",
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		});
	});

	test("returns enabled settings with reserve and default recent-message tokens", async () => {
		// Purpose: callers need the effective native threshold inputs from Pi settings.
		// Input and expected output: enabled compaction returns reserveTokens 12000 and default keepRecentTokens 20000.
		// Edge case: enabled is explicit rather than inherited from Pi's default.
		// Dependencies: SettingsManager and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: { enabled: true, reserveTokens: 12_000 },
		});

		expect(readNativeCompactionSettings(cwd, undefined)).toEqual({
			status: "enabled",
			reserveTokens: 12_000,
			keepRecentTokens: 20_000,
		});
	});

	test("returns disabled settings with reserve and default recent-message tokens", async () => {
		// Purpose: manual threshold owners need reserveTokens even when Pi automatic compaction is disabled.
		// Input and expected output: enabled false returns disabled status, reserveTokens 12000, and default keepRecentTokens 20000.
		// Edge case: disabled still prevents Pi automatic compaction while preserving threshold input.
		// Dependencies: SettingsManager and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: { enabled: false, reserveTokens: 12_000 },
		});

		expect(readNativeCompactionSettings(cwd, undefined)).toEqual({
			status: "disabled",
			reserveTokens: 12_000,
			keepRecentTokens: 20_000,
		});
	});

	test("returns invalid when SettingsManager reports errors", async () => {
		// Purpose: callers must fail closed when Pi rejects native settings.
		// Input and expected output: malformed settings JSON returns only the invalid status.
		// Edge case: Pi still supplies defaults after reporting the parse error.
		// Dependencies: SettingsManager parsing and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeFile(join(agentDir, "settings.json"), "{");

		expect(readNativeCompactionSettings(cwd, undefined)).toEqual({
			status: "invalid",
		});
	});

	test("applies project settings after agent settings", async () => {
		// Purpose: the shared reader must preserve SettingsManager project precedence.
		// Input and expected output: project reserveTokens 10000 overrides agent reserveTokens 16000.
		// Edge case: both files define the same nested compaction field.
		// Dependencies: SettingsManager and isolated agent and project settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: { enabled: true, reserveTokens: 16_000 },
		});
		await writeSettings(join(cwd, ".pi"), {
			compaction: { reserveTokens: 10_000 },
		});

		expect(readNativeCompactionSettings(cwd, undefined)).toEqual({
			status: "enabled",
			reserveTokens: 10_000,
			keepRecentTokens: 20_000,
		});
	});
});
