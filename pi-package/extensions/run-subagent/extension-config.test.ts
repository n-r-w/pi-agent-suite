import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../../test/support/temp-dir";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import { readSubagentExtensionArgs } from "./extension-config";

describe("subagent extension configuration", () => {
	let temporary: ReturnType<typeof createTempDir>;
	let configFile: string;
	let previousSuiteDir: string | undefined;

	beforeEach(() => {
		temporary = createTempDir("subagent-extension-config-");
		previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		process.env[AGENT_SUITE_DIR_ENV] = temporary.path;
		const configDir = join(temporary.path, "agent-selection");
		mkdirSync(configDir);
		configFile = join(configDir, "config.json");
	});

	afterEach(() => {
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		temporary.remove();
	});

	test("uses normal Pi extension discovery when configuration is absent", () => {
		expect(readSubagentExtensionArgs()).toEqual([]);
		for (const config of [{}, { subagents: {} }]) {
			writeFileSync(configFile, JSON.stringify(config));
			expect(readSubagentExtensionArgs()).toEqual([]);
		}
	});

	test.each([
		true,
		false,
	])("preserves the main-agent enabled setting %s", (enabled) => {
		writeFileSync(configFile, JSON.stringify({ enabled }));
		expect(readSubagentExtensionArgs()).toEqual([]);
	});

	test.each([
		{ mode: "all", expected: [] },
		{ mode: "none", expected: ["--no-extensions"] },
	])("selects $mode extension loading", ({ mode, expected }) => {
		writeFileSync(
			configFile,
			JSON.stringify({ subagents: { extensions: { mode } } }),
		);
		expect(readSubagentExtensionArgs()).toEqual(expected);
	});

	test("loads only explicit sources in the listed order", () => {
		const sources = [
			"builtin:codemode",
			join(temporary.path, "custom.ts"),
			"./extensions",
		] as const;
		writeFileSync(
			configFile,
			JSON.stringify({
				subagents: { extensions: { mode: "explicit", include: sources } },
			}),
		);
		expect(readSubagentExtensionArgs()).toEqual([
			"--no-extensions",
			"-e",
			sources[0],
			"-e",
			sources[1],
			"-e",
			sources[2],
		]);
	});

	test("allows an empty explicit list without automatic discovery", () => {
		writeFileSync(
			configFile,
			JSON.stringify({
				subagents: { extensions: { mode: "explicit", include: [] } },
			}),
		);
		expect(readSubagentExtensionArgs()).toEqual(["--no-extensions"]);
	});

	test.each(
		[
			[],
			null,
			{ unexpected: true },
			{ subagents: false },
			{ subagents: { unexpected: true } },
			{ subagents: { extensions: [] } },
			{ subagents: { extensions: {} } },
			{ subagents: { extensions: { mode: "other" } } },
			{ subagents: { extensions: { mode: "all", include: [] } } },
			{ subagents: { extensions: { mode: "none", include: [] } } },
			{ subagents: { extensions: { mode: "explicit" } } },
			{ subagents: { extensions: { mode: "explicit", include: "custom.ts" } } },
			{ subagents: { extensions: { mode: "explicit", include: [42] } } },
			{ subagents: { extensions: { mode: "explicit", include: [" "] } } },
			{ subagents: { extensions: { mode: "all", unexpected: true } } },
		].map((config) => ({ config })),
	)("rejects invalid configuration %# before process startup", ({ config }) => {
		writeFileSync(configFile, JSON.stringify(config));
		expect(readSubagentExtensionArgs).toThrow("agent-selection/config.json");
	});

	test("reports malformed JSON and unreadable configuration", () => {
		writeFileSync(configFile, "{");
		expect(readSubagentExtensionArgs).toThrow("agent-selection/config.json");
		mkdirSync(join(temporary.path, "blocked"));
		process.env[AGENT_SUITE_DIR_ENV] = join(temporary.path, "blocked");
		mkdirSync(
			join(temporary.path, "blocked", "agent-selection", "config.json"),
			{
				recursive: true,
			},
		);
		expect(readSubagentExtensionArgs).toThrow("agent-selection/config.json");
	});
});
