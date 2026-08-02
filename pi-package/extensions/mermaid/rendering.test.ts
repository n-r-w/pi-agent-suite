import { afterEach, describe, expect, test } from "bun:test";
import {
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { renderMermaidEntry } from "./rendering.js";
import type { MermaidRenderEntry } from "./types.js";

/** Width used to exercise the real custom-entry Box contract. */
const WIDTH = 48;
/** Theme fake that leaves text visible while marking no terminal state. */
const THEME = {
	bg: (_name: string, value: string) => value,
	bold: (value: string) => value,
	fg: (_name: string, value: string) => value,
};

/** Creates deterministic ASCII variants for entry-rendering tests. */
function createVariants(): Extract<
	MermaidRenderEntry,
	{ status: "rendered" }
>["variants"] {
	const text = Array.from(
		{ length: 12 },
		(_, index) => `row ${index + 1}`,
	).join("\n");
	return {
		default: { text, maxLineWidth: 6 },
		tight: { text, maxLineWidth: 6 },
	};
}

/** Renders entry data through the production custom-entry component. */
function renderEntry(
	entry: unknown,
	expanded: boolean,
	width = WIDTH,
): string[] {
	return renderMermaidEntry(
		{ data: entry },
		{ expanded },
		THEME as never,
	).render(width);
}

/** Asserts every visual row fits the width passed to the production Box. */
function expectRowsToFit(lines: readonly string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

/** Covers persisted entry rendering, visibility, and terminal safety. */
describe("Mermaid entry rendering", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	/** Shows ten diagram rows while collapsed and all rows while expanded. */
	test("renders collapsed and expanded ASCII previews", () => {
		// Arrange
		setKeybindings(
			new KeybindingsManager(
				{
					...TUI_KEYBINDINGS,
					"app.tools.expand": {
						defaultKeys: "ctrl+o",
						description: "Expand collapsed output",
					},
				},
				{ "app.tools.expand": "alt+x" },
			),
		);
		const entry: MermaidRenderEntry = {
			status: "rendered",
			variants: createVariants(),
		};

		// Act
		const collapsed = renderEntry(entry, false);
		const expanded = renderEntry(entry, true);

		// Assert
		expect(collapsed.join("\n")).toContain("row 10");
		expect(collapsed.join("\n")).not.toContain("row 11");
		expect(collapsed.join("\n")).toContain("alt+x to expand");
		expect(collapsed.join("\n")).not.toContain("ctrl+o");
		expect(expanded.join("\n")).toContain("row 12");
		expectRowsToFit(collapsed, WIDTH);
		expectRowsToFit(expanded, WIDTH);
	});

	/** Keeps compatibility warnings visible in both expansion states. */
	test("always renders compatibility warnings", () => {
		// Arrange
		const entry: MermaidRenderEntry = {
			status: "warning",
			variants: createVariants(),
			warnings: [
				{
					code: "circle_edge_omission",
					explanation: "The renderer can omit the target node.",
				},
			],
		};

		// Act
		const collapsed = renderEntry(entry, false);
		const expanded = renderEntry(entry, true);

		// Assert
		expect(collapsed.join("\n")).toContain(
			"Warning: The renderer can omit the target",
		);
		expect(expanded.join("\n")).toContain(
			"Warning: The renderer can omit the target",
		);
	});

	/** Displays safe failure details and never repeats Mermaid source. */
	test("renders failed entries without source", () => {
		// Arrange
		const entry: MermaidRenderEntry = {
			status: "failed",
			explanation: "Unsupported Mermaid diagram type",
		};

		// Act
		const lines = renderEntry(entry, false);

		// Assert
		const contentRows = lines.map((line) => line.trim()).filter(Boolean);
		expect(contentRows).toEqual(["Unsupported Mermaid diagram type"]);
		expectRowsToFit(lines, WIDTH);
	});

	/** Removes terminal controls while preserving Unicode and clipping diagram rows. */
	test("sanitizes and clips untrusted worker rows", () => {
		// Arrange
		const unsafeText =
			"\u001b[31mvery-long-diagram-row-which-does-not-fit\u001b[0m\n  Á\u001b]0;title\u0007 👩‍💻\u0001 ‏\u0085  ";
		const entry: MermaidRenderEntry = {
			status: "rendered",
			variants: {
				default: { text: unsafeText, maxLineWidth: 44 },
				tight: { text: unsafeText, maxLineWidth: 44 },
			},
		};

		// Act
		const lines = renderEntry(entry, true, 24);
		const output = lines.join("\n");

		// Assert
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("title");
		expect(output).not.toContain("\u0001");
		expect(output).not.toContain("\u0085");
		expect(output).toContain("   Á 👩‍💻 ‏  ");
		expectRowsToFit(lines, 24);
	});

	/** Sanitizes persisted diagnostics before terminal replay. */
	test("sanitizes persisted diagnostics", () => {
		// Arrange
		const unsafeFailure = {
			status: "failed",
			explanation: "Failed\u001b]0;owned\u0007 safely.",
		};

		// Act
		const failureOutput = renderEntry(unsafeFailure, false).join("\n");

		// Assert
		expect(failureOutput).toContain("Failed safely.");
		expect(failureOutput).not.toContain("\u001b");
		expect(failureOutput).not.toContain("owned");
	});

	/** Rejects over-limit variants and duplicate persisted warning codes. */
	test("rejects persisted entries outside finite replay limits", () => {
		// Arrange
		const oversized = {
			status: "rendered",
			variants: {
				default: { text: "x".repeat(100_001), maxLineWidth: 1 },
				tight: { text: "x", maxLineWidth: 1 },
			},
		};
		const duplicateWarnings = {
			status: "warning",
			variants: {
				default: { text: "A", maxLineWidth: 1 },
				tight: { text: "A", maxLineWidth: 1 },
			},
			warnings: Array.from({ length: 7 }, () => ({
				code: "circle_edge_omission",
				explanation: "Warning.",
			})),
		};

		// Act
		const oversizedOutput = renderEntry(oversized, false).join("\n");
		const warningOutput = renderEntry(duplicateWarnings, false).join("\n");

		// Assert
		expect(oversizedOutput).toContain(
			"Invalid persisted Mermaid preview data.",
		);
		expect(warningOutput).toContain("Invalid persisted Mermaid preview data.");
	});

	/** Handles malformed persisted data without throwing during session replay. */
	test("fails safely for malformed persisted data", () => {
		// Arrange
		const malformed = { status: "rendered", variants: { default: null } };

		// Act
		const lines = renderEntry(malformed, false);

		// Assert
		expect(lines.join("\n")).toContain(
			"Invalid persisted Mermaid preview data.",
		);
		expectRowsToFit(lines, WIDTH);
	});
});
