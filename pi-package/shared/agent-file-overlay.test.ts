import { describe, expect, test } from "bun:test";
import { selectAgentFiles } from "./agent-file-overlay";

describe("agent file overlay", () => {
	test("excludes one ambiguous project ID without affecting unrelated files", () => {
		// Purpose: project files that normalize to one ID must not gain an order-dependent winner.
		// Input and expected output: K and Kelvin-sign files both normalize to k, so global k and both project candidates are excluded.
		// Edge case: unrelated global and project agents remain selected in deterministic order.
		// Dependencies: the pure selector avoids filesystem case-folding differences between macOS and Linux.
		expect(
			selectAgentFiles(
				["k.md", "GlobalOnly.md"],
				["K.md", "K.md", "ProjectOnly.md", "notes.txt"],
			),
		).toEqual([
			{ source: "global", entry: "GlobalOnly.md" },
			{ source: "project", entry: "ProjectOnly.md" },
		]);
	});
});
