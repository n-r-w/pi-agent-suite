import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage.ts";
import { readMcpWrapperConfig } from "./config.ts";

const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const CONFIG_DIR = "mcp-wrapper";
const CONFIG_FILE = "config.json";
const LEGACY_CONFIG_DIR = "config";
const LEGACY_CONFIG_FILE = "mcp-wrapper.json";

afterEach(() => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
		return;
	}
	process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
});

describe("mcp-wrapper config file", () => {
	test("treats a missing suite config file as an enabled config with no MCP servers", async () => {
		process.env[AGENT_SUITE_DIR_ENV] = await mkdtemp(
			join(tmpdir(), "mcp-wrapper-config-"),
		);

		const result = await readMcpWrapperConfig();

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.enabled).toBe(true);
		expect(result.config.mcpServers).toEqual({});
	});

	test("reads only the suite-owned config file", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-config-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
		const extensionDir = join(suiteDir, CONFIG_DIR);
		await mkdir(extensionDir, { recursive: true });
		await writeFile(
			join(extensionDir, CONFIG_FILE),
			JSON.stringify({ settings: { enabled: false }, mcpServers: {} }),
		);

		const result = await readMcpWrapperConfig();

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.enabled).toBe(false);
		expect(result.config.mcpServers).toEqual({});
	});

	test("ignores legacy config when suite config is missing", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-config-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
		const legacyDir = join(suiteDir, LEGACY_CONFIG_DIR);
		await mkdir(legacyDir, { recursive: true });
		await writeFile(
			join(legacyDir, LEGACY_CONFIG_FILE),
			JSON.stringify({ settings: { enabled: false }, mcpServers: {} }),
		);

		const result = await readMcpWrapperConfig();

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.enabled).toBe(true);
		expect(result.config.mcpServers).toEqual({});
	});

	test("reports invalid JSON without throwing", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-config-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
		const extensionDir = join(suiteDir, CONFIG_DIR);
		await mkdir(extensionDir, { recursive: true });
		await writeFile(join(extensionDir, CONFIG_FILE), "{");

		const result = await readMcpWrapperConfig();

		expect(result.kind).toBe("invalid");
	});
});
