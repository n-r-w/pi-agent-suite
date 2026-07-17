import { describe, expect, test } from "bun:test";

import { extractMermaidBlocks } from "./extraction.js";

/** Full SHA-256 hash stored as a lowercase hexadecimal string. */
const SOURCE_HASH_PATTERN = /^[a-f\d]{64}$/;

/** Covers Markdown fence extraction and Mermaid source preflight behavior. */
describe("Mermaid extraction", () => {
	/** Accepts supported backtick and tilde fences while preserving source order. */
	test("extracts supported Mermaid fences in source order", () => {
		// Arrange
		const textParts = [
			"Before\n````mermaid\nflowchart TD\nA --> B\n```\n````\nAfter",
			"~~~mermaid\nsequenceDiagram\nAlice->>Bob: Hello\n~~~",
		];

		// Act
		const results = extractMermaidBlocks(textParts);

		// Assert
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			status: "accepted",
			block: {
				diagramType: "flowchart",
				source: "flowchart TD\nA --> B\n```",
			},
		});
		expect(results[1]).toMatchObject({
			status: "accepted",
			block: {
				diagramType: "sequenceDiagram",
			},
		});
		expect(
			results[0]?.status === "accepted" && results[0].block.sourceHash,
		).toMatch(SOURCE_HASH_PATTERN);
	});

	/** Ignores incomplete, empty, and unrelated fenced blocks. */
	test("ignores fences that do not contain complete Mermaid source", () => {
		// Arrange
		const textParts = [
			"```ts\nconst value = 1;\n```\n```mermaid\n```\n```mermaid\nflowchart TD",
		];

		// Act
		const results = extractMermaidBlocks(textParts);

		// Assert
		expect(results).toEqual([]);
	});

	/** Rejects unsupported types and source limits before worker execution. */
	test("returns finite failures for unsupported and oversized blocks", () => {
		// Arrange
		const tooManyLines = [
			"flowchart TD",
			...Array.from({ length: 400 }, () => "A"),
		].join("\n");
		const textParts = [
			`\`\`\`mermaid\ngantt\ntitle Plan\n\`\`\`\n\`\`\`mermaid\n${tooManyLines}\n\`\`\``,
		];

		// Act
		const results = extractMermaidBlocks(textParts);

		// Assert
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			status: "failed",
			explanation: "Unsupported Mermaid diagram type",
		});
		expect(results[1]).toEqual({
			status: "failed",
			explanation:
				"Mermaid source exceeds the 400-line or 20000-character limit.",
		});
	});

	/** Keeps unsupported-type diagnostics independent from untrusted token length. */
	test("bounds unsupported type explanations", () => {
		// Arrange
		const unsupportedToken = "x".repeat(20_000);

		// Act
		const results = extractMermaidBlocks([
			`\`\`\`mermaid\n${unsupportedToken}\n\`\`\``,
		]);

		// Assert
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			status: "failed",
			explanation: "Unsupported Mermaid diagram type",
		});
		expect(JSON.stringify(results[0])).not.toContain(unsupportedToken);
	});

	/** Preserves every valid block because resource limits apply to block size, not count. */
	test("accepts more than five Mermaid blocks", () => {
		// Arrange
		const block = "```mermaid\nflowchart TD\nA --> B\n```";

		// Act
		const results = extractMermaidBlocks([
			Array.from({ length: 6 }, () => block).join("\n"),
		]);

		// Assert
		expect(results).toHaveLength(6);
		expect(results.every((result) => result.status === "accepted")).toBe(true);
	});
});
