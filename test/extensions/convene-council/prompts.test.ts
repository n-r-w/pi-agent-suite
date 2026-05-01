import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildParticipantSystemPrompt } from "../../../pi-package/extensions/convene-council/prompts";

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

test("participant system prompt renders selected tool placeholder", () => {
	// Purpose: participant prompt must describe the child runtime tools without hardcoded production tool names.
	// Input and expected output: selected tool names replace the tool placeholder inside the tool-access section.
	// Edge case: prompt contains no unreplaced tool placeholder after rendering.
	// Dependencies: bundled participant-system prompt template.
	const prompt = buildParticipantSystemPrompt([], ["read", "grep"]);

	expect(prompt).toContain("Current participant tools: read, grep.");
	expect(prompt).not.toContain("{{tools}}");
});

test("participant system prompt renders empty selected tools as none", () => {
	// Purpose: participants with no configured tools must receive an explicit no-tools instruction.
	// Input and expected output: empty selected tool list renders none inside the tool-access section.
	// Edge case: prompt contains no unreplaced tool placeholder after rendering.
	// Dependencies: bundled participant-system prompt template.
	const prompt = buildParticipantSystemPrompt([], []);

	expect(prompt).toContain("Current participant tools: none.");
	expect(prompt).not.toContain("{{tools}}");
});
