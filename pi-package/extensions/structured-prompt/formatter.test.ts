import { describe, expect, test } from "bun:test";
import { formatStructuredPrompt, PROMPT_SECTIONS } from "./formatter.ts";

describe("structured-prompt formatter", () => {
	test("formats non-empty sections in the configured order", () => {
		// Purpose: generated prompts must be deterministic and easy to scan.
		// Input and expected output: unordered values are emitted by section order with Markdown headings.
		// Edge case: a section value can contain multiple lines.
		// Dependencies: this test exercises the pure formatter only.
		const result = formatStructuredPrompt(PROMPT_SECTIONS, [
			{ sectionId: "task", value: "Implement the extension" },
			{ sectionId: "goal", value: "Create structured requests" },
			{ sectionId: "context", value: "Line one\nLine two" },
		]);

		expect(result).toBe(
			[
				"## Goal",
				"Create structured requests",
				"",
				"## Task",
				"Implement the extension",
				"",
				"## Context",
				"Line one\nLine two",
			].join("\n"),
		);
	});

	test("omits empty sections after trimming whitespace", () => {
		// Purpose: generated prompts must not include unused form sections.
		// Input and expected output: whitespace-only values are omitted, and kept values are trimmed at boundaries.
		// Edge case: an omitted middle section does not leave duplicate blank separators.
		// Dependencies: this test exercises the pure formatter only.
		const result = formatStructuredPrompt(PROMPT_SECTIONS, [
			{ sectionId: "goal", value: "  " },
			{ sectionId: "criteria", value: "  Must pass tests  " },
			{ sectionId: "constraints", value: "\n\t" },
		]);

		expect(result).toBe(["## Criteria", "Must pass tests"].join("\n"));
	});

	test("returns an empty string when all sections are empty", () => {
		// Purpose: callers need an explicit empty result to cancel submission before sending.
		// Input and expected output: no non-empty values returns an empty string.
		// Edge case: unknown section ids do not create output.
		// Dependencies: this test exercises the pure formatter only.
		const result = formatStructuredPrompt(PROMPT_SECTIONS, [
			{ sectionId: "goal", value: "" },
			{ sectionId: "unknown", value: "Ignored" },
		]);

		expect(result).toBe("");
	});
});
