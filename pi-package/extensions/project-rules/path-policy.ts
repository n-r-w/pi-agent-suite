import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAgentSuiteDir } from "../../shared/agent-suite-storage";

export interface ProjectRulesPathPolicy {
	readonly forbiddenRoots: readonly string[];
}

/** Creates the path policy that keeps default and configured global pi storage out of project rules. */
export async function createProjectRulesPathPolicy(): Promise<ProjectRulesPathPolicy> {
	const candidates = [
		join(homedir(), ".pi"),
		getAgentDir(),
		getAgentSuiteDir(),
	];
	const resolvedCandidates = await Promise.all(
		candidates.map(async (candidate) => {
			const lexicalRoot = resolve(candidate);
			try {
				return [lexicalRoot, resolve(await realpath(candidate))];
			} catch {
				// The lexical root stays forbidden when storage is absent or cannot be inspected.
				return [lexicalRoot];
			}
		}),
	);
	return { forbiddenRoots: [...new Set(resolvedCandidates.flat())] };
}

/** Reports whether a rule path is equal to or nested under global pi storage. */
export function isProjectRulesPathForbidden(
	path: string,
	policy: ProjectRulesPathPolicy,
): boolean {
	const resolvedPath = resolve(path);
	return policy.forbiddenRoots.some((root) => {
		const relativePath = relative(root, resolvedPath);
		return (
			relativePath.length === 0 ||
			(relativePath !== ".." &&
				!relativePath.startsWith(`..${sep}`) &&
				!isAbsolute(relativePath))
		);
	});
}
