import { describe, expect, test } from "bun:test";
import { selectAgentFiles } from "./agent-file-overlay";

describe("agent file overlay", () => {
	test("excludes one NFC-ambiguous project ID without folding case", () => {
		// Purpose: project files with one NFC identity must not gain an order-dependent winner or hide a differently cased global agent.
		// Input and expected output: K and Kelvin-sign files normalize to K and are excluded, while lowercase global k remains distinct.
		// Edge case: unrelated global and project agents remain selected in deterministic order.
		// Dependencies: the pure selector avoids filesystem normalization differences between macOS and Linux.
		expect(
			selectAgentFiles(
				["k.md", "GlobalOnly.md"],
				["K.md", "K.md", "ProjectOnly.md", "notes.txt"],
			),
		).toEqual([
			{ source: "global", entry: "GlobalOnly.md" },
			{ source: "global", entry: "k.md" },
			{ source: "project", entry: "ProjectOnly.md" },
		]);
	});
});
