import { describe, expect, test } from "bun:test";
import { appendKnowledgeBlock } from "../../shared/knowledge-runtime";
import { renderKnowledgeBlock } from "./context";

describe("knowledge context rendering", () => {
	/**
	 * Proves global and branch-local Markdown share one provider-visible knowledge block.
	 * Inputs and expected outputs: both snapshots render in labeled sections and append after the existing system prompt.
	 * Edge case: opaque Markdown is preserved rather than parsed or escaped.
	 * Dependencies: scope selection occurs before this pure renderer.
	 */
	test("renders one block with every applicable scope", () => {
		// Arrange: both applicable files contain opaque Markdown.
		const block = renderKnowledgeBlock({
			global: "## Global\nUse one queue.",
			local: "## Local\nKeep the branch rule.",
		});

		// Act: append the rendered block to an explicit system context.
		const systemPrompt = appendKnowledgeBlock("Base system", block);

		// Assert: one outer block preserves both independently labeled inputs.
		expect(block?.match(/<knowledge>/gu)).toHaveLength(1);
		expect(block).toContain("<global>");
		expect(block).toContain("## Global\nUse one queue.");
		expect(block).toContain("<local>");
		expect(block).toContain("## Local\nKeep the branch rule.");
		expect(systemPrompt).toBe(`Base system\n\n${block}`);
	});

	/**
	 * Proves read-only and absent states add only their applicable content.
	 * Inputs and expected outputs: global-only omits the local section; complete absence returns null and leaves the prompt unchanged.
	 * Edge case: local-only knowledge remains deliverable when the global file is absent.
	 * Dependencies: primary, detached, and bare scope resolution supplies local null.
	 */
	test("omits absent sections and adds no empty block", () => {
		// Arrange and act: render global-only, local-only, and absent snapshots.
		const globalOnly = renderKnowledgeBlock({ global: "global", local: null });
		const localOnly = renderKnowledgeBlock({ global: null, local: "local" });
		const absent = renderKnowledgeBlock({ global: null, local: null });

		// Assert: section presence follows files exactly and absence does not change system context.
		expect(globalOnly).toContain("<global>\nglobal\n</global>");
		expect(globalOnly).not.toContain("<local>");
		expect(localOnly).toContain("<local>\nlocal\n</local>");
		expect(localOnly).not.toContain("<global>");
		expect(absent).toBeNull();
		expect(appendKnowledgeBlock("Base system", absent)).toBe("Base system");
	});
});
