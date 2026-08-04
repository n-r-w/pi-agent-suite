import { describe, expect, test } from "bun:test";
import {
	type GitCommand,
	type GitCommandResult,
	type GitCommandRunner,
	resolveGitProject,
} from "./git-context";

const CWD = "/workspace/project";
const COMMON_GIT_DIR = "/workspace/project/.git";

/** Creates a strict fake that records commands and returns ordered Git results. */
function createGitRunner(responses: readonly GitCommandResult[]): {
	readonly commands: GitCommand[];
	readonly run: GitCommandRunner;
} {
	const commands: GitCommand[] = [];
	let responseIndex = 0;
	return {
		commands,
		run: (command) => {
			commands.push(command);
			const response = responses[responseIndex];
			responseIndex += 1;
			if (response === undefined) {
				throw new Error(`unexpected Git command: ${command.args.join(" ")}`);
			}
			return response;
		},
	};
}

/** Creates one successful Git command result with optional standard output. */
function success(stdout = ""): GitCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

/** Creates one failed Git command result without invoking a real repository. */
function failure(stderr = "failed"): GitCommandResult {
	return { exitCode: 1, stdout: "", stderr };
}

describe("knowledge Git context resolution", () => {
	/** Verifies that failing the required context probe yields the exact not-git outcome. */
	test("returns not-git outside a Git context", () => {
		// ARRANGE
		const fake = createGitRunner([failure()]);

		// ACT
		const result = resolveGitProject({
			cwd: CWD,
			primaryBranches: ["main", "master"],
			runGit: fake.run,
		});

		// ASSERT
		expect(result).toEqual({ kind: "not-git" });
		expect(fake.commands).toEqual([
			{ cwd: CWD, args: ["rev-parse", "--absolute-git-dir"] },
		]);
	});

	/** Verifies that a Git context without any effective fetch URL is unidentified. */
	test("returns unidentified when all remotes lack fetch URLs", () => {
		// ARRANGE
		const fake = createGitRunner([
			success(`${COMMON_GIT_DIR}\n`),
			success(`${COMMON_GIT_DIR}\n`),
			success("origin\n"),
			failure("no URLs configured"),
		]);

		// ACT
		const result = resolveGitProject({
			cwd: CWD,
			primaryBranches: ["main", "master"],
			runGit: fake.run,
		});

		// ASSERT
		expect(result).toEqual({ kind: "unidentified" });
		expect(fake.commands[2]).toEqual({
			cwd: CWD,
			args: [`--git-dir=${COMMON_GIT_DIR}`, "remote"],
		});
		expect(fake.commands[3]).toEqual({
			cwd: CWD,
			args: [
				`--git-dir=${COMMON_GIT_DIR}`,
				"config",
				"--get-all",
				"remote.origin.url",
			],
		});
	});

	/** Verifies that a failed URL expansion cannot be mistaken for an absent fetch URL. */
	test("throws when an existing fetch URL cannot be expanded", () => {
		// ARRANGE
		const commands: GitCommand[] = [];
		const run: GitCommandRunner = (command) => {
			commands.push(command);
			if (command.args.includes("--absolute-git-dir")) {
				return success(`${COMMON_GIT_DIR}\n`);
			}
			if (command.args.includes("--git-common-dir")) {
				return success(`${COMMON_GIT_DIR}\n`);
			}
			if (command.args.includes("--get-all")) {
				return success("https://github.com/n-r-w/pi-agent-suite.git\n");
			}
			if (command.args.includes("get-url")) {
				return failure("could not expand configured URL");
			}
			return success("origin\n");
		};

		// ACT
		const act = () =>
			resolveGitProject({
				cwd: CWD,
				primaryBranches: ["main", "master"],
				runGit: run,
			});

		// ASSERT
		expect(act).toThrow("could not expand Git fetch URLs");
		expect(commands.some((command) => command.args.includes("--get-all"))).toBe(
			true,
		);
	});

	/** Verifies that one unsupported URL invalidates otherwise recognized evidence. */
	test("returns unsupported when any effective fetch URL is unsupported", () => {
		// ARRANGE
		const fake = createGitRunner([
			success(`${COMMON_GIT_DIR}\n`),
			success(`${COMMON_GIT_DIR}\n`),
			success("origin\nmirror\n"),
			success("https://github.com/n-r-w/pi-agent-suite.git\n"),
			success("https://github.com/n-r-w/pi-agent-suite.git\n"),
			success("file:///tmp/pi-agent-suite\n"),
			success("file:///tmp/pi-agent-suite\n"),
		]);

		// ACT
		const result = resolveGitProject({
			cwd: CWD,
			primaryBranches: ["main", "master"],
			runGit: fake.run,
		});

		// ASSERT
		expect(result).toEqual({ kind: "unsupported" });
	});

	/** Verifies that multiple recognized profile-and-identity pairs are ambiguous. */
	test("returns ambiguous when recognized identities differ", () => {
		// ARRANGE
		const fake = createGitRunner([
			success(`${COMMON_GIT_DIR}\n`),
			success(`${COMMON_GIT_DIR}\n`),
			success("origin\nupstream\n"),
			success("https://github.com/example/fork.git\n"),
			success("https://github.com/example/fork.git\n"),
			success("https://github.com/n-r-w/pi-agent-suite.git\n"),
			success("https://github.com/n-r-w/pi-agent-suite.git\n"),
		]);

		// ACT
		const result = resolveGitProject({
			cwd: CWD,
			primaryBranches: ["main", "master"],
			runGit: fake.run,
		});

		// ASSERT
		expect(result).toEqual({ kind: "ambiguous" });
	});

	/**
	 * Verifies all-fetch-URL consensus, common-directory remote reads, current-
	 * worktree branch scope, and credential-free identity metadata.
	 */
	test("resolves a non-primary attached branch as read-write", () => {
		// ARRANGE
		const linkedGitDir = "/workspace/project/.git/worktrees/feature";
		const fake = createGitRunner([
			success(`${linkedGitDir}\n`),
			success(`${COMMON_GIT_DIR}\n`),
			success("origin\nmirror\nempty\n"),
			success("https://github.com/n-r-w/pi-agent-suite.git\n"),
			success(
				"https://github.com/n-r-w/pi-agent-suite.git\ngit@github.com:n-r-w/pi-agent-suite.git\n",
			),
			success("ssh://git@github.com:22/n-r-w/pi-agent-suite.git\n"),
			success("ssh://git@github.com:22/n-r-w/pi-agent-suite.git\n"),
			failure("no URLs configured"),
			success("false\n"),
			success("feature/Knowledge\n"),
		]);

		// ACT
		const result = resolveGitProject({
			cwd: CWD,
			primaryBranches: ["main", "master"],
			runGit: fake.run,
		});

		// ASSERT
		expect(result.kind).toBe("resolved-read-write");
		if (result.kind !== "resolved-read-write") {
			return;
		}
		expect(result.branch).toEqual({
			name: "feature/Knowledge",
			directoryName:
				"feature-Knowledge-91f8ff2554f0509f3df6b6b3a60ac25fbfa1e83420b62e520a921078e3bd499b",
		});
		expect(result.identityMetadata).toMatchObject({
			schema: "knowledge-project-identity/v1",
			profile: "github-v1",
			canonicalIdentity: "github.com/n-r-w/pi-agent-suite",
			remoteNames: ["origin", "mirror"],
		});
		expect(
			result.identityMetadata.redactedFetchUrls.every(
				(url) => !url.includes("git@"),
			),
		).toBe(true);
		expect(fake.commands.at(-2)).toEqual({
			cwd: CWD,
			args: ["rev-parse", "--is-bare-repository"],
		});
		expect(fake.commands.at(-1)).toEqual({
			cwd: CWD,
			args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
		});
	});

	/** Verifies exact read-only topology for bare, detached, and configured primary branches. */
	test("resolves prohibited accumulation topologies as read-only", () => {
		// ARRANGE
		const topologyResponses: readonly (readonly GitCommandResult[])[] = [
			[success("true\n")],
			[success("false\n"), failure("detached")],
			[success("false\n"), success("master\n")],
		];

		// ACT
		const results = topologyResponses.map((topology) => {
			const fake = createGitRunner([
				success(`${COMMON_GIT_DIR}\n`),
				success(`${COMMON_GIT_DIR}\n`),
				success("origin\n"),
				success("https://github.com/n-r-w/pi-agent-suite.git\n"),
				success("https://github.com/n-r-w/pi-agent-suite.git\n"),
				...topology,
			]);
			return resolveGitProject({
				cwd: CWD,
				primaryBranches: ["main", "master"],
				runGit: fake.run,
			});
		});

		// ASSERT
		expect(results.map((result) => result.kind)).toEqual([
			"resolved-read-only",
			"resolved-read-only",
			"resolved-read-only",
		]);
		const branches = results.map((result) =>
			result.kind === "resolved-read-only" ? result.branch : undefined,
		);
		expect(branches).toEqual([
			null,
			null,
			{
				name: "master",
				directoryName:
					"master-fc613b4dfd6736a7bd268c8a0e74ed0d1c04a959f59dd74ef2874983fd443fc9",
			},
		]);
	});
});
