import { describe, expect, test } from "bun:test";
import { buildPiToolCatalog, buildPiToolName } from "./tool-catalog.ts";

const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FETCH_TOOL_NAME = "fetch_fetch";

describe("mcp-wrapper tool catalog", () => {
	test("builds deterministic provider-safe tool names with server provenance", () => {
		const first = buildPiToolName("local-files", "read/file");
		const second = buildPiToolName("local-files", "read/file");

		expect(first).toEqual(second);
		expect(first.kind).toBe("valid");
		if (first.kind !== "valid") {
			throw new Error(first.issue);
		}
		expect(first.name).toBe("local_files_read_file");
		expect(first.name).toMatch(PROVIDER_SAFE_TOOL_NAME);
	});

	test("builds exact fetch tool name", () => {
		const name = buildPiToolName("fetch", "fetch");

		expect(name).toEqual({ kind: "valid", name: FETCH_TOOL_NAME });
	});

	test("truncates long names to the provider limit", () => {
		const name = buildPiToolName(
			"server-name-that-is-far-longer-than-the-provider-tool-name-limit",
			"tool-name-that-is-also-far-longer-than-the-provider-tool-name-limit",
		);
		expect(name.kind).toBe("valid");
		if (name.kind !== "valid") {
			throw new Error(name.issue);
		}

		expect(name.name).toMatch(PROVIDER_SAFE_TOOL_NAME);
		expect(name.name.length).toBeLessThanOrEqual(64);
	});

	test("rejects routes whose names cannot produce provider-safe tool names", () => {
		expect(buildPiToolName("---", "read").kind).toBe("invalid");
		expect(buildPiToolName("files", "!!!").kind).toBe("invalid");
		expect(buildPiToolName("123-server", "read").kind).toBe("invalid");
	});

	test("normalization collisions produce identical names for catalog rejection", () => {
		const first = buildPiToolName("server/a", "tool:a");
		const second = buildPiToolName("server a", "tool a");

		expect(first).toEqual({ kind: "valid", name: "server_a_tool_a" });
		expect(second).toEqual({ kind: "valid", name: "server_a_tool_a" });
	});

	test("builds route catalog for valid MCP tools", () => {
		const catalog = buildPiToolCatalog([
			{
				serverKey: "files",
				tools: [
					{
						name: "read",
						description: "Read a file",
						inputSchema: {
							type: "object",
							title: "Read file arguments",
						},
					},
					{ name: "write", inputSchema: { type: "object" } },
				],
			},
		]);

		expect(catalog.rejected).toEqual([]);
		expect(catalog.tools).toHaveLength(2);
		expect(catalog.tools[0]?.route).toEqual({
			serverKey: "files",
			mcpToolName: "read",
		});
		expect(catalog.tools[0]?.definition.name).toMatch(PROVIDER_SAFE_TOOL_NAME);
		expect(catalog.tools[0]?.definition.parameters).toMatchObject({
			type: "object",
		});
	});

	test("rejects only the affected server when serverKey cannot produce provider-safe names", () => {
		const catalog = buildPiToolCatalog([
			{
				serverKey: "123-files",
				tools: [{ name: "read", inputSchema: { type: "object" } }],
			},
			{
				serverKey: "docs",
				tools: [{ name: "search", inputSchema: { type: "object" } }],
			},
		]);

		expect(catalog.tools).toHaveLength(1);
		expect(catalog.tools[0]?.route).toEqual({
			serverKey: "docs",
			mcpToolName: "search",
		});
		expect(catalog.rejected).toEqual([
			{
				kind: "server",
				serverKey: "123-files",
				issue: "server key slug must start with an ASCII letter or underscore",
			},
		]);
	});

	test("passes MCP JSON schemas through to Pi tool definitions", () => {
		const schema = {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["fast"], default: "fast" },
			},
			additionalProperties: false,
		};
		const catalog = buildPiToolCatalog([
			{
				serverKey: "files",
				tools: [{ name: "read", inputSchema: schema }],
			},
		]);

		expect(catalog.rejected).toEqual([]);
		expect(catalog.tools).toHaveLength(1);
		expect(catalog.tools[0]?.definition.parameters).toEqual(schema);
	});

	test("rejects only the affected MCP tool when its name cannot produce provider-safe names", () => {
		const catalog = buildPiToolCatalog([
			{
				serverKey: "files",
				tools: [
					{ name: "!!!", inputSchema: { type: "object" } },
					{ name: "read", inputSchema: { type: "object" } },
				],
			},
		]);

		expect(catalog.tools).toHaveLength(1);
		expect(catalog.tools[0]?.route).toEqual({
			serverKey: "files",
			mcpToolName: "read",
		});
		expect(catalog.rejected).toEqual([
			{
				kind: "tool",
				serverKey: "files",
				mcpToolName: "!!!",
				issue: "MCP tool name must contain ASCII letters or digits",
			},
		]);
	});

	test("rejects all routes with duplicate generated Pi tool names", () => {
		const catalog = buildPiToolCatalog([
			{
				serverKey: "files",
				tools: [
					{ name: "read", inputSchema: { type: "object" } },
					{ name: "read", inputSchema: { type: "object" } },
				],
			},
		]);

		expect(catalog.tools).toEqual([]);
		expect(catalog.rejected).toEqual([
			{
				kind: "tool",
				serverKey: "files",
				mcpToolName: "read",
				issue: "generated Pi tool name collides with another MCP route",
			},
			{
				kind: "tool",
				serverKey: "files",
				mcpToolName: "read",
				issue: "generated Pi tool name collides with another MCP route",
			},
		]);
	});
});
