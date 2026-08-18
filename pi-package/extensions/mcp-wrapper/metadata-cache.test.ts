import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage.ts";
import type { McpServerConfig } from "./config.ts";
import {
	computeMcpServerConfigHash,
	getMcpWrapperCachePath,
	loadMcpWrapperCache,
	saveMcpWrapperCache,
} from "./metadata-cache.ts";

const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

afterEach(() => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
		return;
	}
	process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
});

describe("mcp-wrapper metadata cache", () => {
	test("stores cache in the suite-owned mcp-wrapper directory", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-cache-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;

		expect(getMcpWrapperCachePath()).toBe(
			join(suiteDir, "mcp-wrapper", "cache.json"),
		);
	});

	test("returns null when cache file is missing or invalid", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-cache-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;

		expect(await loadMcpWrapperCache()).toBeNull();

		await mkdir(join(suiteDir, "mcp-wrapper"), { recursive: true });
		await writeFile(join(suiteDir, "mcp-wrapper", "cache.json"), "{");

		expect(await loadMcpWrapperCache()).toBeNull();
	});

	test("round-trips tool metadata and MCP instructions with private file permissions", async () => {
		const suiteDir = await mkdtemp(join(tmpdir(), "mcp-wrapper-cache-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;

		await saveMcpWrapperCache({
			version: 1,
			servers: {
				fetch: {
					configHash: "hash",
					cachedAt: 1_700_000_000_000,
					tools: [
						{
							name: "fetch",
							description: "Fetch URL",
							inputSchema: { type: "object", properties: {} },
						},
					],
					instructions: "Use fetch only for public URLs.",
				},
			},
		});

		expect(await loadMcpWrapperCache()).toEqual({
			version: 1,
			servers: {
				fetch: {
					configHash: "hash",
					cachedAt: 1_700_000_000_000,
					tools: [
						{
							name: "fetch",
							description: "Fetch URL",
							inputSchema: { type: "object", properties: {} },
						},
					],
					instructions: "Use fetch only for public URLs.",
				},
			},
		});
		expect((await stat(getMcpWrapperCachePath())).mode % 0o1000).toBe(0o600);
	});

	test("hashes only server identity fields", () => {
		const config: McpServerConfig = {
			type: "stdio",
			command: "node",
			args: ["server.js"],
			env: { TOKEN: "value" },
		};

		expect(computeMcpServerConfigHash(config)).toBe(
			computeMcpServerConfigHash({
				...config,
				env: { TOKEN: "value" },
			}),
		);
		expect(computeMcpServerConfigHash(config)).not.toBe(
			computeMcpServerConfigHash({ ...config, args: ["other.js"] }),
		);
		expect(computeMcpServerConfigHash(config)).toBe(
			computeMcpServerConfigHash({
				...config,
				additionalInstructions: "Use this server for files.",
			}),
		);
		expect(computeMcpServerConfigHash(config)).toBe(
			computeMcpServerConfigHash({
				...config,
				onDemand: { name: "files", description: "Read files" },
			}),
		);
		expect(
			computeMcpServerConfigHash({
				...config,
				onDemand: { name: "files", description: "Read files" },
			}),
		).toBe(
			computeMcpServerConfigHash({
				...config,
				onDemand: { name: "renamed", description: "Changed trigger" },
			}),
		);
	});
});
