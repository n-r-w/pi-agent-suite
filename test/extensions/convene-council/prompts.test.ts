import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const NO_CONSENSUS_RESULT_PROMPT =
	"pi-package/extensions/convene-council/prompts/no-consensus-result.md";

test("no-consensus result prompt exposes answer macros", async () => {
	// Purpose: editable no-consensus result text must keep both runtime substitution points.
	// Input and expected output: prompt file contains answer1 and answer2 macros.
	// Edge case: wording around the macros is intentionally not part of this test.
	// Dependencies: bundled prompt file loaded at runtime by the extension.
	const prompt = await readFile(NO_CONSENSUS_RESULT_PROMPT, "utf8");

	expect(prompt).toContain("{{answer1}}");
	expect(prompt).toContain("{{answer2}}");
});
