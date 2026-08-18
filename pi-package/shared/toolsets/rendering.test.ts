import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolsetActivationDetails } from "./contracts.ts";
import {
	renderActivateToolsetCall,
	renderActivateToolsetResult,
} from "./rendering.ts";

initTheme(undefined, false);

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const toolNames = [
	"files_read",
	"files_write",
	"files_search",
	"files_list",
	"files_move",
	"files_remove",
];

function result(status: "activated" | "already_active" = "activated") {
	const details: ToolsetActivationDetails = {
		version: 1,
		activeToolsets: ["files"],
		activation: { name: "files", status, toolNames },
	};
	return {
		content: [{ type: "text", text: "LLM content must not drive rendering" }],
		details,
	};
}

describe("activate_toolset rendering", () => {
	test("renders a compact width-bounded call with the exact requested name", () => {
		const component = renderActivateToolsetCall(
			{ name: "проектные-файлы-с-длинным-именем" },
			theme,
		);
		const lines = component.render(24);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("activate_toolset");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
	});

	test("shows status, count, a bounded preview, and expansion hint when collapsed", () => {
		const component = renderActivateToolsetResult(
			result(),
			{ expanded: false },
			theme,
		);
		const lines = component.render(36);
		const text = lines.join("\n");

		expect(text).toContain('Activated "files"');
		expect(text).toContain("6 tools");
		expect(text).toContain("files_read");
		expect(text).not.toContain("files_remove");
		expect(text).toContain("to expand");
		expect(lines.length).toBeLessThanOrEqual(4);
	});

	test("shows every allowed name and no schema or description when expanded", () => {
		const component = renderActivateToolsetResult(
			result("already_active"),
			{ expanded: true },
			theme,
		);
		const text = component.render(80).join("\n");

		expect(text).toContain('Toolset "files" is already active');
		for (const name of toolNames) {
			expect(text).toContain(name);
		}
		expect(text).not.toContain("parameters");
		expect(text).not.toContain("description");
	});

	test("keeps collapsed and expanded output inside Pi default tool shell width", () => {
		for (const expanded of [false, true]) {
			const shell = new Box(1, 1);
			shell.addChild(
				renderActivateToolsetResult(result(), { expanded }, theme),
			);
			const lines = shell.render(32);
			expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
		}
	});
});
