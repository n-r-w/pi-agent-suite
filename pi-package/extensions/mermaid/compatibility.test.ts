import { describe, expect, test } from "bun:test";

import { detectCompatibilityWarnings } from "./compatibility.js";
import type { MermaidDiagramType, MermaidSourceBlock } from "./types.js";

/** Creates a source block for compatibility behavior tests. */
function createBlock(
	source: string,
	diagramType: MermaidDiagramType,
): MermaidSourceBlock {
	return {
		diagramType,
		source,
		sourceHash: "hash",
	};
}

/** Covers parent-owned warnings and parser-owned warning presentation. */
describe("Mermaid compatibility warnings", () => {
	/** Presents parser-owned structural findings once in stable public order. */
	test("combines structural warning codes", () => {
		// Arrange
		const block = createBlock("flowchart TD\nA --> B", "flowchart");

		// Act
		const warnings = detectCompatibilityWarnings(block, [
			"subgraph_endpoint_phantom_node",
			"cross_edge_omission",
			"circle_edge_omission",
			"circle_edge_omission",
		]);

		// Assert
		expect(warnings.map(({ code }) => code)).toEqual([
			"circle_edge_omission",
			"cross_edge_omission",
			"subgraph_endpoint_phantom_node",
		]);
	});

	/** Detects early notes without warning for notes after any supported message arrow. */
	test("orders sequence notes against every supported message arrow", () => {
		// Arrange
		const arrows = ["->>", "-->>", "-)", "--)", "-x", "--x", "->", "-->"];

		// Act
		const earlyWarnings = arrows.map((arrow) =>
			detectCompatibilityWarnings(
				createBlock(
					`sequenceDiagram\nNote over Alice: Early\nAlice${arrow}Bob: Hello`,
					"sequenceDiagram",
				),
			),
		);
		const laterWarnings = arrows.map((arrow) =>
			detectCompatibilityWarnings(
				createBlock(
					`sequenceDiagram\nAlice${arrow}Bob: Hello\nNote over Alice: Later`,
					"sequenceDiagram",
				),
			),
		);

		// Assert
		expect(
			earlyWarnings.every((warnings) =>
				warnings.some(({ code }) => code === "early_sequence_note_omission"),
			),
		).toBe(true);
		expect(
			laterWarnings.every((warnings) =>
				warnings.every(({ code }) => code !== "early_sequence_note_omission"),
			),
		).toBe(true);
	});

	/** Detects unsupported HTML tags and terminal-wide rendered labels. */
	test("detects display compatibility risks", () => {
		// Arrange
		const block = createBlock(
			"flowchart TD\nA[<b>Start</b>] --> B[🚀]",
			"flowchart",
		);

		// Act
		const warnings = detectCompatibilityWarnings(block);

		// Assert
		expect(warnings.map(({ code }) => code)).toEqual([
			"literal_html_tag",
			"wide_character_alignment",
		]);
	});

	/** Ignores comments and renderer-supported HTML line breaks. */
	test("returns no warnings for non-rendered comments and HTML breaks", () => {
		// Arrange
		const block = createBlock(
			"flowchart TD\n%% 日本語 🚀 <b>comment</b> --o B --x C\nA[Hello<br>World] --> B[Again<br/>Here]",
			"flowchart",
		);

		// Act
		const warnings = detectCompatibilityWarnings(block);

		// Assert
		expect(warnings).toEqual([]);
	});

	/** Leaves ordinary supported source without warnings. */
	test("returns no warnings for ordinary source", () => {
		// Arrange
		const block = createBlock("flowchart TD\nA --> B", "flowchart");

		// Act
		const warnings = detectCompatibilityWarnings(block);

		// Assert
		expect(warnings).toEqual([]);
	});
});
