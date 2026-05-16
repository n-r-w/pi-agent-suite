import { describe, expect, test } from "bun:test";
import { adaptMcpInputSchema } from "./schema-adapter.ts";

const FETCH_INPUT_SCHEMA = {
	type: "object",
	properties: {
		url: {
			description: "URL to fetch",
			format: "uri",
			minLength: 1,
			title: "Url",
			type: "string",
		},
		max_length: {
			default: 5000,
			description: "Maximum number of characters to return.",
			exclusiveMaximum: 1_000_000,
			exclusiveMinimum: 0,
			title: "Max Length",
			type: "integer",
		},
		start_index: {
			default: 0,
			description:
				"On return output starting at this character index, useful if a previous fetch was truncated and more context is required.",
			minimum: 0,
			title: "Start Index",
			type: "integer",
		},
		raw: {
			default: false,
			description:
				"Get the actual HTML content of the requested page, without simplification.",
			title: "Raw",
			type: "boolean",
		},
	},
	required: ["url"],
	description: "Parameters for fetching a URL.",
	title: "Fetch",
} as const;

describe("mcp-wrapper schema adapter", () => {
	test("passes through MCP input schemas for direct Pi tool registration", () => {
		const result = adaptMcpInputSchema(FETCH_INPUT_SCHEMA);

		expect(result.kind).toBe("valid");
		expect(result.parameters).toEqual(FETCH_INPUT_SCHEMA);
	});

	test("uses an empty object schema when MCP inputSchema is missing", () => {
		const result = adaptMcpInputSchema(undefined);

		expect(result.kind).toBe("valid");
		expect(result.parameters).toEqual({ type: "object", properties: {} });
	});
});
