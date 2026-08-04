import { spawnSync } from "node:child_process";
import type { ProjectIdentity } from "./identity";
import { createProjectIdentity } from "./identity";
import { createBranchDirectoryName } from "./paths";
import type { FetchUrlIdentity } from "./url-identity";
import { parseFetchUrl } from "./url-identity";

/** Defines Git's line output boundary and missing-config exit contract. */
const LINE_BREAK = /\r?\n/u;
const MISSING_CONFIG_VALUE_EXIT_CODE = 1;

/** Defines one read-only Git process invocation. */
export interface GitCommand {
	readonly cwd: string;
	readonly args: readonly string[];
}

/** Captures the result required from a Git process invocation. */
export interface GitCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs one Git command without granting the resolver direct process access. */
export type GitCommandRunner = (command: GitCommand) => GitCommandResult;

/** Stores the credential-free project identity evidence beside knowledge. */
export interface IdentityMetadata {
	readonly schema: "knowledge-project-identity/v1";
	readonly key: string;
	readonly profile: ProjectIdentity["profile"];
	readonly displayName: string;
	readonly canonicalIdentity: string;
	readonly remoteNames: readonly string[];
	readonly redactedFetchUrls: readonly string[];
}

/** Identifies an attached branch without exposing it as a filesystem path. */
export interface ResolvedBranch {
	readonly name: string;
	readonly directoryName: string;
}

/** Reports every exact project-resolution outcome. */
export type GitProjectResolution =
	| { readonly kind: "not-git" }
	| { readonly kind: "unidentified" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "ambiguous" }
	| {
			readonly kind: "resolved-read-only" | "resolved-read-write";
			readonly project: ProjectIdentity;
			readonly identityMetadata: IdentityMetadata;
			readonly branch: ResolvedBranch | null;
	  };

/** Supplies current-worktree scope and configured primary-branch variants. */
export interface ResolveGitProjectOptions {
	readonly cwd: string;
	readonly primaryBranches: readonly string[];
	readonly runGit?: GitCommandRunner;
}

/** Couples one effective URL with the remote whose fetch config supplied it. */
interface RemoteUrlEvidence {
	readonly remoteName: string;
	readonly url: string;
}

/** Resolves one Git context without consulting refs for project identity. */
export function resolveGitProject(
	options: ResolveGitProjectOptions,
): GitProjectResolution {
	const runGit = options.runGit ?? runGitCommand;
	const gitDirectoryProbe = runGit({
		cwd: options.cwd,
		args: ["rev-parse", "--absolute-git-dir"],
	});
	if (gitDirectoryProbe.exitCode !== 0) {
		return { kind: "not-git" };
	}

	const commonGitDirectory = requireCommandOutput(
		runGit({
			cwd: options.cwd,
			args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
		}),
		"could not resolve the common Git directory",
	);
	const evidence = collectRemoteUrlEvidence(
		options.cwd,
		commonGitDirectory,
		runGit,
	);
	if (evidence.length === 0) {
		return { kind: "unidentified" };
	}

	const parsed = evidence.map((item) => parseFetchUrl(item.url));
	if (parsed.some((identity) => identity === undefined)) {
		return { kind: "unsupported" };
	}
	const supported = parsed.filter(
		(identity): identity is FetchUrlIdentity => identity !== undefined,
	);
	const pairSet = new Set(
		supported.map(
			(identity) => `${identity.profile}\u0000${identity.canonicalIdentity}`,
		),
	);
	if (pairSet.size !== 1) {
		return { kind: "ambiguous" };
	}

	const firstIdentity = supported[0];
	if (firstIdentity === undefined) {
		return { kind: "unidentified" };
	}
	const project = createProjectIdentity(firstIdentity);
	const branch = resolveCurrentBranch(options.cwd, runGit);
	const readOnly =
		branch === null || options.primaryBranches.includes(branch.name);
	return {
		kind: readOnly ? "resolved-read-only" : "resolved-read-write",
		project,
		identityMetadata: createIdentityMetadata(project, evidence, supported),
		branch,
	};
}

/** Runs Git without a shell so repository names and paths remain opaque arguments. */
function runGitCommand(command: GitCommand): GitCommandResult {
	const result = spawnSync("git", command.args, {
		cwd: command.cwd,
		encoding: "utf8",
		shell: false,
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status === null) {
		throw new Error("Git process terminated without an exit status");
	}
	return {
		exitCode: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/** Reads remotes from the common repository and asks Git for expanded fetch URLs. */
function collectRemoteUrlEvidence(
	cwd: string,
	commonGitDirectory: string,
	runGit: GitCommandRunner,
): readonly RemoteUrlEvidence[] {
	const remoteResult = runGit({
		cwd,
		args: [`--git-dir=${commonGitDirectory}`, "remote"],
	});
	if (remoteResult.exitCode !== 0) {
		throw new Error(`could not enumerate Git remotes: ${remoteResult.stderr}`);
	}
	const remoteNames = splitOutputLines(remoteResult.stdout);
	const evidence: RemoteUrlEvidence[] = [];
	for (const remoteName of remoteNames) {
		const configuredUrls = runGit({
			cwd,
			args: [
				`--git-dir=${commonGitDirectory}`,
				"config",
				"--get-all",
				`remote.${remoteName}.url`,
			],
		});
		// Git config exit code 1 is the documented absence signal. Any other
		// failure would make the remote evidence incomplete and must fail closed.
		if (configuredUrls.exitCode === MISSING_CONFIG_VALUE_EXIT_CODE) {
			continue;
		}
		if (configuredUrls.exitCode !== 0) {
			throw new Error(
				`could not inspect Git fetch URLs: ${configuredUrls.stderr}`,
			);
		}

		const urlsResult = runGit({
			cwd,
			args: [
				`--git-dir=${commonGitDirectory}`,
				"remote",
				"get-url",
				"--all",
				remoteName,
			],
		});
		if (urlsResult.exitCode !== 0) {
			throw new Error(`could not expand Git fetch URLs: ${urlsResult.stderr}`);
		}
		const urls = splitOutputLines(urlsResult.stdout);
		// An explicitly configured empty value is unsupported evidence rather than
		// the same condition as a remote with no URL key.
		if (urls.length === 0) {
			evidence.push({ remoteName, url: "" });
			continue;
		}
		for (const url of urls) {
			evidence.push({ remoteName, url });
		}
	}
	return evidence;
}

/** Resolves bare and current-worktree HEAD topology without remote HEAD evidence. */
function resolveCurrentBranch(
	cwd: string,
	runGit: GitCommandRunner,
): ResolvedBranch | null {
	const bareResult = runGit({
		cwd,
		args: ["rev-parse", "--is-bare-repository"],
	});
	if (bareResult.exitCode !== 0) {
		throw new Error(
			`could not determine bare repository state: ${bareResult.stderr}`,
		);
	}
	if (bareResult.stdout.trim() === "true") {
		return null;
	}

	const branchResult = runGit({
		cwd,
		args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
	});
	if (branchResult.exitCode !== 0) {
		return null;
	}
	const branchName = branchResult.stdout.trim();
	if (branchName.length === 0) {
		return null;
	}
	return {
		name: branchName,
		directoryName: createBranchDirectoryName(branchName),
	};
}

/** Builds the metadata schema from consensus evidence without raw transport userinfo. */
function createIdentityMetadata(
	project: ProjectIdentity,
	evidence: readonly RemoteUrlEvidence[],
	identities: readonly FetchUrlIdentity[],
): IdentityMetadata {
	const remoteNames: string[] = [];
	for (const item of evidence) {
		if (!remoteNames.includes(item.remoteName)) {
			remoteNames.push(item.remoteName);
		}
	}
	return {
		schema: "knowledge-project-identity/v1",
		key: project.key,
		profile: project.profile,
		displayName: project.displayName,
		canonicalIdentity: project.canonicalIdentity,
		remoteNames,
		redactedFetchUrls: identities.map((identity) => identity.redactedUrl),
	};
}

/** Requires one successful command and one non-empty absolute-path-like output. */
function requireCommandOutput(
	result: GitCommandResult,
	message: string,
): string {
	if (result.exitCode !== 0) {
		throw new Error(`${message}: ${result.stderr}`);
	}
	const output = result.stdout.trim();
	if (output.length === 0) {
		throw new Error(`${message}: Git returned empty output`);
	}
	return output;
}

/** Splits Git's line-oriented output while ignoring terminal blank lines. */
function splitOutputLines(output: string): readonly string[] {
	return output.split(LINE_BREAK).filter((line) => line.length > 0);
}
