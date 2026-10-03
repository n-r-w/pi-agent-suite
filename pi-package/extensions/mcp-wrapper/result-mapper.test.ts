import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { mapMcpToolResult } from "./result-mapper.ts";

const SAVED_IMAGE_PATH = /Saved image payload: (.+)$/;
const FULL_OUTPUT_PATH = /Full output: (.+)]$/;
const FILE_MODE_BASE = 0o1000;

describe("mcp-wrapper result mapper", () => {
	test("maps MCP text content to Pi text content", async () => {
		const result = await mapMcpToolResult({
			content: [{ type: "text", text: "hello" }],
		});

		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.details.isError).toBe(false);
	});

	test("keeps under-limit image content as Pi image content", async () => {
		const result = await mapMcpToolResult({
			content: [{ type: "image", data: "abc", mimeType: "image/png" }],
		});

		expect(result.content).toEqual([
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
	});

	test("saves oversized image content to a temp file with private mode", async () => {
		const data = "a".repeat(DEFAULT_MAX_BYTES + 1);
		const result = await mapMcpToolResult({
			content: [{ type: "image", data, mimeType: "image/png" }],
		});
		const text =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		const path = text.match(SAVED_IMAGE_PATH)?.[1];

		expect(path).toBeDefined();
		if (path === undefined) {
			throw new Error("missing image path");
		}
		expect(await readFile(path, "utf8")).toBe(data);
		const mode = (await stat(path)).mode;
		expect(mode - Math.floor(mode / FILE_MODE_BASE) * FILE_MODE_BASE).toBe(
			0o600,
		);
	});

	test("truncates large text output and includes the full output path", async () => {
		const text = Array.from(
			{ length: 20_000 },
			(_, index) => `line ${index}`,
		).join("\n");
		const result = await mapMcpToolResult({
			content: [{ type: "text", text }],
		});
		const output =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		const path = output.match(FULL_OUTPUT_PATH)?.[1];

		expect(path).toBeDefined();
		if (path === undefined) {
			throw new Error("missing full output path");
		}
		expect(await readFile(path, "utf8")).toBe(text);
		expect(output.startsWith("line 0\n")).toBe(true);
		expect(output).toContain("Use offset=");
	});

	test("formats large JSON output into lines and keeps its start", async () => {
		const value = {
			summary: "first section",
			items: Array.from({ length: 5_000 }, (_, index) => ({ index })),
		};
		const result = await mapMcpToolResult({
			content: [{ type: "text", text: JSON.stringify(value) }],
		});
		const output =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		const path = output.match(FULL_OUTPUT_PATH)?.[1];

		expect(output.startsWith('{\n  "summary": "first section",')).toBe(true);
		expect(path).toBeDefined();
		if (path === undefined) {
			throw new Error("missing full output path");
		}
		expect(await readFile(path, "utf8")).toBe(JSON.stringify(value, null, 2));
	});

	test("keeps JSON output within limit unchanged", async () => {
		const text = JSON.stringify({ items: [1, 2, 3] });
		const result = await mapMcpToolResult({
			content: [{ type: "text", text }],
		});

		expect(result.content).toEqual([{ type: "text", text }]);
	});

	test("keeps start of single line longer than output limit", async () => {
		const text = `start ${"x".repeat(DEFAULT_MAX_BYTES * 2)}`;
		const result = await mapMcpToolResult({
			content: [{ type: "text", text }],
		});
		const output =
			result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output.startsWith("start x")).toBe(true);
		expect(output).toContain("of line 1");
	});

	test("cuts long line without splitting multi-byte characters", async () => {
		const text = "ж".repeat(DEFAULT_MAX_BYTES);
		const result = await mapMcpToolResult({
			content: [{ type: "text", text }],
		});
		const output =
			result.content[0]?.type === "text" ? result.content[0].text : "";
		const shown = output.split("\n", 1)[0] ?? "";

		expect(shown).toBe("ж".repeat(DEFAULT_MAX_BYTES / 2));
	});

	test("maps resources, resource links, and audio to safe text", async () => {
		const result = await mapMcpToolResult({
			content: [
				{ type: "resource", resource: { uri: "file:///a", text: "body" } },
				{ type: "resource_link", uri: "file:///b", name: "b" },
				{ type: "audio", data: "abc", mimeType: "audio/wav" },
			],
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: "[Resource: file:///a]\nbody\n[Resource Link: b]\nURI: file:///b\n[Audio content: audio/wav]",
			},
		]);
	});
});
