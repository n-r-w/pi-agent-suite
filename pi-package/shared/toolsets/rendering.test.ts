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

const ansiTheme = {
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[39m`,
} as unknown as Theme;

const toolNames = [
	"files_read",
	"files_write",
	"files_search",
	"files_list",
	"files_move",
	"files_remove",
];

function result(
	status: "activated" | "already_active" = "activated",
	names: readonly string[] = toolNames,
) {
	const details: ToolsetActivationDetails = {
		version: 1,
		activeToolsets: ["files"],
		activation: { name: "files", status, toolNames: names },
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

	/**
	 * Purpose: narrow ANSI-styled rows must close every style after plain-text clipping.
	 * Input and expected output: a 12-column call clips the fixed prefix to a complete styled row.
	 * Edge case: the width is narrower than the fixed prefix and the row is rendered inside Box.
	 * Dependencies: the equivalent ANSI theme and Pi visible-width contract.
	 */
	test("clips plain call text before applying ANSI styles", () => {
		const line =
			renderActivateToolsetCall(
				{ name: "configured-toolset-name" },
				ansiTheme,
			).render(12)[0] ?? "";

		expect(line).toBe("\u001b[32m\u001b[1mactivate_to…\u001b[22m\u001b[39m");
		expect(visibleWidth(line)).toBeLessThanOrEqual(12);

		const shell = new Box(1, 1);
		shell.addChild(
			renderActivateToolsetCall({ name: "configured-toolset-name" }, ansiTheme),
		);
		const shellLine = shell.render(14)[1] ?? "";
		expect(shellLine).toContain(line);
		expect(visibleWidth(shellLine)).toBeLessThanOrEqual(14);
	});

	/**
	 * Purpose: fitting calls must retain the requested toolset name exactly.
	 * Input and expected output: the 22-column prefix-plus-name call contains all five name characters.
	 * Edge case: ANSI wrappers must not affect the fit calculation.
	 * Dependencies: the equivalent ANSI theme and Pi visible-width contract.
	 */
	test("preserves the exact requested name when the full call fits", () => {
		const line =
			renderActivateToolsetCall({ name: "files" }, ansiTheme).render(22)[0] ??
			"";

		expect(line).toContain("files");
		expect(visibleWidth(line)).toBe(22);
	});

	test("wraps comma-separated tools and reports exact hidden lines when collapsed", () => {
		const component = renderActivateToolsetResult(
			result(),
			{ expanded: false },
			theme,
		);
		const lines = component.render(36).map((line) => line.trimEnd());
		const text = lines.join("\n");

		expect(lines.slice(0, 2)).toEqual([
			"Activated: files_read, files_write,",
			"files_search, files_list, ...",
		]);
		expect(lines[2]).toContain("... 1 more line");
		expect(lines[2]).toContain("to expand");
		expect(text).not.toContain('"files"');
		expect(text).not.toContain("6 tools");
		expect(text).not.toContain("- files_");
	});

	test("omits truncation and the hint when collapsed content fits", () => {
		const component = renderActivateToolsetResult(
			result("activated", ["files_read", "files_write"]),
			{ expanded: false },
			theme,
		);
		const lines = component.render(80).map((line) => line.trimEnd());

		expect(lines).toEqual(["Activated: files_read, files_write"]);
		expect(lines.join("\n")).not.toContain("to expand");
	});

	test("colors only the activation status as success", () => {
		const colorCalls: Array<{ color: string; text: string }> = [];
		const trackingTheme = {
			bold: (text: string) => text,
			fg: (color: string, text: string) => {
				colorCalls.push({ color, text });
				return text;
			},
		} as unknown as Theme;
		const component = renderActivateToolsetResult(
			result("activated", ["files_read", "files_write"]),
			{ expanded: false },
			trackingTheme,
		);

		component.render(80);

		expect(colorCalls.filter(({ color }) => color === "success")).toEqual([
			{ color: "success", text: "Activated:" },
		]);
		expect(colorCalls.filter(({ color }) => color === "muted")).toEqual([
			{ color: "muted", text: " files_read, files_write" },
		]);
	});

	test("shows every comma-separated name without truncation when expanded", () => {
		const component = renderActivateToolsetResult(
			result("already_active"),
			{ expanded: true },
			theme,
		);
		const text = component.render(36).join("\n");
		const unwrappedText = component
			.render(36)
			.map((line) => line.trim())
			.join(" ");

		expect(unwrappedText).toBe(
			"Already active: files_read, files_write, files_search, files_list, files_move, files_remove",
		);
		for (const name of toolNames) {
			expect(text).toContain(name);
		}
		expect(text).not.toContain('"files"');
		expect(text).not.toContain("to expand");
		expect(text).not.toContain("parameters");
		expect(text).not.toContain("description");
		expect(text).not.toContain("- files_");
	});

	test("preserves Unicode names within narrow terminal width", () => {
		const names = ["инструмент", "工具", "emoji_🧪"];
		const component = renderActivateToolsetResult(
			result("activated", names),
			{ expanded: true },
			theme,
		);
		const lines = component.render(24);
		const text = lines.join("\n");

		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		for (const name of names) {
			expect(text).toContain(name);
		}
	});

	test("keeps fallback error rendering unchanged", () => {
		const component = renderActivateToolsetResult(
			{
				content: [{ type: "text", text: "unknown toolset: missing" }],
			},
			{ expanded: false, isError: true },
			theme,
		);

		expect(component.render(40).map((line) => line.trimEnd())).toEqual([
			"unknown toolset: missing",
		]);
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
