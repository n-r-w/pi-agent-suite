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

	test("preserves nonblank additional instructions for both transports", () => {
		const localText = `  First line

Second line  `;
		const result = parseMcpWrapperConfig({
			mcpServers: {
				files: { command: "server", additionalInstructions: localText },
				docs: {
					type: "streamableHttp",
					url: "https://example.com/mcp",
					additionalInstructions: localText,
				},
			},
		});

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.mcpServers["files"]).toMatchObject({
			additionalInstructions: localText,
		});
		expect(result.config.mcpServers["docs"]).toMatchObject({
			additionalInstructions: localText,
		});
	});

	test("omits empty and whitespace-only additional instructions", () => {
		const result = parseMcpWrapperConfig({
			mcpServers: {
				empty: { command: "server", additionalInstructions: "" },
				whitespace: { command: "server", additionalInstructions: " \n\t" },
				httpWhitespace: {
					type: "streamableHttp",
					url: "https://example.com/mcp",
					additionalInstructions: " \n\t",
				},
			},
		});

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.mcpServers["empty"]).not.toHaveProperty(
			"additionalInstructions",
		);
		expect(result.config.mcpServers["whitespace"]).not.toHaveProperty(
			"additionalInstructions",
		);
		expect(result.config.mcpServers["httpWhitespace"]).not.toHaveProperty(
			"additionalInstructions",
		);
	});

	test("rejects non-string additional instructions", () => {
		for (const value of [null, 1, false, {}, []]) {
			expect(
				parseMcpWrapperConfig({
					mcpServers: {
						files: { command: "server", additionalInstructions: value },
					},
				}).kind,
			).toBe("invalid");
			expect(
				parseMcpWrapperConfig({
					mcpServers: {
						docs: {
							type: "streamableHttp",
							url: "https://example.com/mcp",
							additionalInstructions: value,
						},
					},
				}).kind,
			).toBe("invalid");
		}
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

	test("accepts a strict onDemand toolset declaration", () => {
		const result = parseMcpWrapperConfig({
			mcpServers: {
				files: {
					command: "server",
					onDemand: { name: "files", description: "Read files when needed" },
				},
			},
		});

		expect(result.kind).toBe("valid");
		if (result.kind !== "valid") {
			throw new Error(result.issue);
		}
		expect(result.config.mcpServers["files"]).toMatchObject({
			onDemand: { name: "files", description: "Read files when needed" },
		});
	});

	test("accepts exact case-sensitive on-demand names across transport types", () => {
		// Purpose: exact names with different case must remain distinct across stdio and HTTP servers.
		// Input and expected output: two valid declarations parse without normalization.
		// Edge case: name identity differs only by case.
		// Dependencies: strict root and transport parsing only.
		const result = parseMcpWrapperConfig({
			mcpServers: {
				files: {
					command: "server",
					onDemand: { name: "Files", description: "Read files" },
				},
				docs: {
					type: "streamableHttp",
					url: "https://example.com/mcp",
					onDemand: { name: "files", description: "Read documentation" },
				},
			},
		});

		expect(result.kind).toBe("valid");
	});

	test("rejects duplicate and malformed on-demand declarations", () => {
		// Purpose: invalid declarations must enter the extension's existing invalid-config path.
		// Input and expected output: duplicates, extra keys, empty values, and surrounding whitespace are rejected.
		// Edge case: duplicate identity spans stdio and HTTP servers.
		// Dependencies: strict server parsing and cross-server validation only.
		const invalidOnDemandValues = [
			{ name: "", description: "Read files" },
			{ name: "files", description: "" },
			{ name: " files", description: "Read files" },
			{ name: "files ", description: "Read files" },
			{ name: "files", description: " Read files" },
			{ name: "files", description: "Read files " },
			{ name: "files", description: "Read files", extra: true },
		];
		for (const onDemand of invalidOnDemandValues) {
			expect(
				parseMcpWrapperConfig({
					mcpServers: { files: { command: "server", onDemand } },
				}).kind,
			).toBe("invalid");
		}

		expect(
			parseMcpWrapperConfig({
				mcpServers: {
					files: {
						command: "server",
						onDemand: { name: "shared", description: "Read files" },
					},
					docs: {
						type: "streamableHttp",
						url: "https://example.com/mcp",
						onDemand: { name: "shared", description: "Read docs" },
					},
				},
			}).kind,
		).toBe("invalid");
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
