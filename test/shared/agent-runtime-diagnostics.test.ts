import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getRuntimeDiagnosticsPath,
	writeRuntimeDiagnostic,
} from "../../pi-package/shared/agent-runtime-diagnostics";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

/** Runs diagnostics tests against an isolated suite directory. */
async function withIsolatedSuiteDir<T>(
	action: (suiteDir: string) => Promise<T>,
): Promise<T> {
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const suiteDir = await mkdtemp(join(tmpdir(), "pi-runtime-diagnostics-"));
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	try {
		return await action(suiteDir);
	} finally {
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		await rm(suiteDir, { recursive: true, force: true });
	}
}

/** Writes the agent-selection config used by runtime diagnostics. */
async function writeAgentSelectionConfig(
	suiteDir: string,
	config: Record<string, unknown>,
): Promise<void> {
	const configDir = join(suiteDir, "agent-selection");
	await mkdir(configDir, { recursive: true });
	await Bun.write(join(configDir, "config.json"), JSON.stringify(config));
}

test("runtime diagnostics are disabled by default", async () => {
	// Purpose: diagnostics must not write files unless explicitly enabled in agent-selection config.
	// Input and expected output: no config exists, and writeRuntimeDiagnostic leaves the diagnostics path absent.
	// Edge case: default-disabled behavior prevents background logging during normal agent use.
	// Dependencies: this test uses only isolated suite storage and the diagnostics helper.
	await withIsolatedSuiteDir(async () => {
		writeRuntimeDiagnostic("test.default-disabled");

		await expect(
			readFile(getRuntimeDiagnosticsPath(), "utf8"),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

test("runtime diagnostics write under agent-selection when explicitly enabled", async () => {
	// Purpose: diagnostics must use the agent-selection extension directory and honor diagnosticsEnabled=true.
	// Input and expected output: config enables diagnostics, and one JSONL record is written under agent-selection/runtime-diagnostics.jsonl.
	// Edge case: the legacy main-agent-selection directory is not used for new diagnostics.
	// Dependencies: this test uses only isolated suite storage and the diagnostics helper.
	await withIsolatedSuiteDir(async (suiteDir) => {
		await writeAgentSelectionConfig(suiteDir, { diagnosticsEnabled: true });

		writeRuntimeDiagnostic("test.enabled", { value: "ok" });

		const diagnosticsPath = getRuntimeDiagnosticsPath();
		expect(diagnosticsPath).toBe(
			join(suiteDir, "agent-selection", "runtime-diagnostics.jsonl"),
		);
		const content = await readFile(diagnosticsPath, "utf8");
		expect(content).toContain('"event":"test.enabled"');
		expect(content).toContain('"value":"ok"');
	});
});

test("runtime diagnostics stay disabled when diagnosticsEnabled is false", async () => {
	// Purpose: explicit diagnosticsEnabled=false must suppress diagnostic writes.
	// Input and expected output: config disables diagnostics, and writeRuntimeDiagnostic leaves no log file.
	// Edge case: users can keep agent-selection enabled while disabling diagnostic output.
	// Dependencies: this test uses only isolated suite storage and the diagnostics helper.
	await withIsolatedSuiteDir(async (suiteDir) => {
		await writeAgentSelectionConfig(suiteDir, {
			enabled: true,
			diagnosticsEnabled: false,
		});

		writeRuntimeDiagnostic("test.disabled");

		await expect(
			readFile(getRuntimeDiagnosticsPath(), "utf8"),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
