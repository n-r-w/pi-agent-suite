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
	test("returns enabled settings with reserve tokens", async () => {
		// Purpose: callers need the effective native threshold inputs from Pi settings.
		// Input and expected output: enabled compaction with reserveTokens 12000 returns the enabled result and 12000.
		// Edge case: enabled is explicit rather than inherited from Pi's default.
		// Dependencies: SettingsManager and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: { enabled: true, reserveTokens: 12_000 },
		});

		expect(readNativeCompactionSettings(cwd)).toEqual({
			status: "enabled",
			reserveTokens: 12_000,
		});
	});

	test("returns disabled settings with reserve tokens", async () => {
		// Purpose: manual threshold owners need reserveTokens even when Pi automatic compaction is disabled.
		// Input and expected output: enabled false returns disabled status with reserveTokens 12000.
		// Edge case: disabled still prevents Pi automatic compaction while preserving threshold input.
		// Dependencies: SettingsManager and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeSettings(agentDir, {
			compaction: { enabled: false, reserveTokens: 12_000 },
		});

		expect(readNativeCompactionSettings(cwd)).toEqual({
			status: "disabled",
			reserveTokens: 12_000,
		});
	});

	test("returns invalid when SettingsManager reports errors", async () => {
		// Purpose: callers must fail closed when Pi rejects native settings.
		// Input and expected output: malformed settings JSON returns only the invalid status.
		// Edge case: Pi still supplies defaults after reporting the parse error.
		// Dependencies: SettingsManager parsing and isolated agent settings.
		const { agentDir, cwd } = await createSettingsFixture();
		await writeFile(join(agentDir, "settings.json"), "{");

		expect(readNativeCompactionSettings(cwd)).toEqual({ status: "invalid" });
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

		expect(readNativeCompactionSettings(cwd)).toEqual({
			status: "enabled",
			reserveTokens: 10_000,
		});
	});
});
