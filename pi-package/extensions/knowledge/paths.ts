import { createHash } from "node:crypto";
import { join } from "node:path";
import { sanitizeReadablePrefix } from "./identity";

/** Holds project-level catalog paths. */
export interface ProjectPaths {
	readonly projectDirectory: string;
	readonly identityFile: string;
	readonly globalKnowledgeFile: string;
}

/** Holds branch-local catalog paths. */
export interface BranchPaths {
	readonly branchName: string;
	readonly branchDirectory: string;
	readonly knowledgeFile: string;
	readonly globalMergeStateFile: string;
}

/** Creates the identity and global knowledge paths for one project. */
export function createProjectPaths(
	dataDir: string,
	projectDirectoryName: string,
): ProjectPaths {
	const projectDirectory = join(dataDir, projectDirectoryName);
	return {
		projectDirectory,
		identityFile: join(projectDirectory, "identity.json"),
		globalKnowledgeFile: join(projectDirectory, "global", "knowledge.md"),
	};
}

/** Creates a branch directory name from its exact hash and display-only prefix. */
export function createBranchDirectoryName(branchName: string): string {
	const digest = createHash("sha256")
		.update(Buffer.from(branchName, "utf8"))
		.digest("hex");
	const prefix = sanitizeReadablePrefix(branchName, "branch");
	return `${prefix}-${digest}`;
}

/** Creates local knowledge and merge-state paths from an exact branch name. */
export function createBranchPaths(
	project: ProjectPaths,
	branchName: string,
): BranchPaths {
	const branchDirectory = join(
		project.projectDirectory,
		"local",
		createBranchDirectoryName(branchName),
	);
	return {
		branchName,
		branchDirectory,
		knowledgeFile: join(branchDirectory, "knowledge.md"),
		globalMergeStateFile: join(branchDirectory, "global-merge-state.json"),
	};
}
