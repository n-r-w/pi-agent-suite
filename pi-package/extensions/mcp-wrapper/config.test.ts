import { describe, expect, test } from "bun:test";
import { parseMcpWrapperConfig } from "./config.ts";

const UNIX_ENV_PLACEHOLDER = "$" + "{TOKEN}";
const POWERSHELL_ENV_PLACEHOLDER = "$env:TOKEN";

describe("mcp-wrapper config", () => {
	test("uses enabled and timeout defaults when settings are omitted", () => {
		const result = parseMcpWrapperConfig({ mcpServers: {} });

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		const config: Record<string, unknown> = { ...result.config };
		expect(config).toEqual({
			enabled: true,
			timeouts: {
				startupSeconds: 30,
				listToolsSeconds: 15,
				callSeconds: 120,
				maxTotalSeconds: 180,
			},
			widgetLineBudget: 5,
			mcpServers: {},
		});
	});

	test("accepts an empty mcpServers object without registering server configs", () => {
		const result = parseMcpWrapperConfig({
			settings: { enabled: true },
			mcpServers: {},
		});

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(Object.keys(result.config.mcpServers)).toHaveLength(0);
	});

	test("accepts stdio and streamable HTTP server configs", () => {
		const result = parseMcpWrapperConfig({
			settings: {
				enabled: false,
				widgetLineBudget: 3,
				timeouts: {
					startupSeconds: 5,
					listToolsSeconds: 6,
					callSeconds: 7,
					maxTotalSeconds: 8,
				},
			},
			mcpServers: {
				files: {
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
					env: { EXAMPLE_TOKEN: UNIX_ENV_PLACEHOLDER },
					cwd: "/tmp",
				},
				docs: {
					type: "streamableHttp",
					url: "https://example.com/mcp",
					headers: { Authorization: POWERSHELL_ENV_PLACEHOLDER },
				},
			},
		});

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.enabled).toBe(false);
		expect(result.config.timeouts).toEqual({
			startupSeconds: 5,
			listToolsSeconds: 6,
			callSeconds: 7,
			maxTotalSeconds: 8,
		});
		const config: Record<string, unknown> = { ...result.config };
		expect(config).toMatchObject({ widgetLineBudget: 3 });
		expect(result.config.mcpServers["files"]).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			env: { EXAMPLE_TOKEN: UNIX_ENV_PLACEHOLDER },
			cwd: "/tmp",
		});
		expect(result.config.mcpServers["docs"]).toEqual({
			type: "streamableHttp",
			url: "https://example.com/mcp",
			headers: { Authorization: POWERSHELL_ENV_PLACEHOLDER },
		});
	});

	test("rejects unsupported config keys and invalid primitive values", () => {
		expect(parseMcpWrapperConfig({ "mcp-servers": {} }).kind).toBe("invalid");
		expect(
			parseMcpWrapperConfig({ settings: { enabled: true }, mcpServers: [] })
				.kind,
		).toBe("invalid");
		expect(
			parseMcpWrapperConfig({ settings: { unknown: true }, mcpServers: {} })
				.kind,
		).toBe("invalid");
		expect(
			parseMcpWrapperConfig({
				settings: { timeouts: { callSeconds: 0 } },
				mcpServers: {},
			}).kind,
		).toBe("invalid");
		expect(
			parseMcpWrapperConfig({
				settings: { widgetLineBudget: 0 },
				mcpServers: {},
			}).kind,
		).toBe("invalid");
		expect(
			parseMcpWrapperConfig({
				mcpServers: { files: { command: "", args: [] } },
			}).kind,
		).toBe("invalid");
	});
});
