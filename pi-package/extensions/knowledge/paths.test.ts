import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBranchPaths, createProjectPaths } from "./paths";

const DATA_DIR = "/agent-suite/knowledge/data";
const PROJECT_DIRECTORY =
	"pi-agent-suite-ed0513b170cc4769a82e13527af2de5202188504fae1fc05c30f7a3193a02541";

describe("knowledge catalog paths", () => {
	/** Verifies the exact project-level catalog layout and full project digest retention. */
	test("creates project identity and global knowledge paths", () => {
		// ARRANGE
		const projectDirectory = join(DATA_DIR, PROJECT_DIRECTORY);

		// ACT
		const paths = createProjectPaths(DATA_DIR, PROJECT_DIRECTORY);

		// ASSERT
		expect(paths).toEqual({
			projectDirectory,
			identityFile: join(projectDirectory, "identity.json"),
			globalKnowledgeFile: join(projectDirectory, "global", "knowledge.md"),
		});
	});

	/**
	 * Verifies that an exact slash-bearing branch name is hashed in full while its
	 * display prefix cannot introduce catalog path separators.
	 */
	test("creates branch-local knowledge and merge-state paths", () => {
		// ARRANGE
		const projectPaths = createProjectPaths(DATA_DIR, PROJECT_DIRECTORY);

		// ACT
		const paths = createBranchPaths(projectPaths, "feature/Knowledge");

		// ASSERT
		expect(paths).toEqual({
			branchName: "feature/Knowledge",
			branchDirectory: join(
				projectPaths.projectDirectory,
				"local",
				"feature-Knowledge-91f8ff2554f0509f3df6b6b3a60ac25fbfa1e83420b62e520a921078e3bd499b",
			),
			knowledgeFile: join(
				projectPaths.projectDirectory,
				"local",
				"feature-Knowledge-91f8ff2554f0509f3df6b6b3a60ac25fbfa1e83420b62e520a921078e3bd499b",
				"knowledge.md",
			),
			globalMergeStateFile: join(
				projectPaths.projectDirectory,
				"local",
				"feature-Knowledge-91f8ff2554f0509f3df6b6b3a60ac25fbfa1e83420b62e520a921078e3bd499b",
				"global-merge-state.json",
			),
		});
	});
});
