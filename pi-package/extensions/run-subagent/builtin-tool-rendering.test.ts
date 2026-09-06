import { beforeEach, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createEventBus,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createToolPresentationRegistry } from "./tool-rendering.ts";

const CWD = "/tmp";
const UI = { requestRender(): void {} } as TUI;

describe("built-in tool presentation", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	// Purpose: each built-in uses Pi's renderers, rather than generic JSON output.
	// Input and expected output: public tool definitions resolve to their native renderers and shell.
	// Edge cases: file, shell, and search tools retain separate presentations.
	// Dependencies: public Pi factories and the presentation registry; no tool execution.
	test.each([
		createReadToolDefinition,
		createBashToolDefinition,
		createEditToolDefinition,
		createWriteToolDefinition,
		createGrepToolDefinition,
		createFindToolDefinition,
		createLsToolDefinition,
	])("preserves native renderers from %p", (factory) => {
		const expected = factory(CWD);
		const registry = createToolPresentationRegistry(CWD, createEventBus());
		const resolution = registry.resolve(expected.name);
		expect(resolution.category).toBe("builtin");
		const render = (
			definition: ConstructorParameters<typeof ToolExecutionComponent>[4],
		) => {
			const component = new ToolExecutionComponent(
				expected.name,
				"builtin-fixture",
				{ path: "fixture.ts", command: "printf fixture", pattern: "fixture" },
				{},
				definition,
				UI,
				CWD,
			);
			component.setArgsComplete();
			component.updateResult({
				content: [{ type: "text", text: "fixture output" }],
				isError: false,
			});
			return component.render(80).map(stripVTControlCharacters);
		};
		expect(typeof resolution.definition?.renderCall).toBe("function");
		expect(typeof resolution.definition?.renderResult).toBe("function");
		expect(render(resolution.definition)).toEqual(render(expected));
		expect(resolution.definition?.renderShell ?? "default").toBe(
			expected.renderShell ?? "default",
		);
	});

	// Purpose: replay displays a file title and a diff through the real Pi component.
	// Input and expected output: a synthetic edit result renders its path and changed lines.
	// Edge cases: both collapsed and expanded views use the native self-rendered shell.
	// Dependencies: the presentation registry and ToolExecutionComponent; no filesystem access.
	test.each([
		false,
		true,
	])("renders an edit diff with expanded=%p", (expanded) => {
		const registry = createToolPresentationRegistry(CWD, createEventBus());
		const component = new ToolExecutionComponent(
			"edit",
			"edit-fixture",
			{
				path: "fixture.ts",
				edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
			},
			{},
			registry.resolve("edit").definition,
			UI,
			CWD,
		);
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			content: [
				{
					type: "text",
					text: "Successfully replaced 1 block(s) in fixture.ts.",
				},
			],
			details: {
				diff: "-1 const value = 1;\n+1 const value = 2;",
				firstChangedLine: 1,
			},
			isError: false,
		});
		const rendered = component
			.render(80)
			.map(stripVTControlCharacters)
			.join("\n");
		expect(rendered).toContain("edit fixture.ts");
		expect(rendered).toContain("-1 const value = 1;");
		expect(rendered).toContain("+1 const value = 2;");
	});
});
