import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

const RUN_SUBAGENT_EXTENSION = "./extensions/run-subagent/index.ts";
const KNOWLEDGE_EXTENSION = "./extensions/knowledge/index.ts";
const WORKFLOW_EXTENSION = "./extensions/workflow/index.ts";

describe("knowledge package order", () => {
	/** Ensures child transport initializes before knowledge and workflow dispatch follows it. */
	test("loads after run-subagent and before workflow", () => {
		// ARRANGE
		const extensions = packageJson.pi.extensions;

		// ACT
		const knowledgeIndex = extensions.indexOf(KNOWLEDGE_EXTENSION);

		// ASSERT
		expect(knowledgeIndex).toBeGreaterThan(
			extensions.indexOf(RUN_SUBAGENT_EXTENSION),
		);
		expect(knowledgeIndex).toBeLessThan(extensions.indexOf(WORKFLOW_EXTENSION));
	});
});
