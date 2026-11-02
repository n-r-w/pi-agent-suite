import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type ReleaseKind = "patch" | "minor" | "major";
export type ReleaseCommand = (command: readonly string[], cwd: string) => void;

/** Reads the released version from a Pi-compatible changelog heading. */
const RELEASE_HEADING_PATTERN = /^## \[?(\d+\.\d+\.\d+)\]?(?:[ \t].*)?$/;

/** Requires a description for the target version before npm can change the package version. */
function requireReleaseChangelog(packageDir: string, kind: ReleaseKind): void {
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as { version: string };
	const [major = 0, minor = 0, patch = 0] = manifest.version
		.split(".")
		.map(Number);
	const nextVersion = {
		patch: `${major}.${minor}.${patch + 1}`,
		minor: `${major}.${minor + 1}.0`,
		major: `${major + 1}.0.0`,
	}[kind];
	const changelogPath = join(packageDir, "CHANGELOG.md");
	const lines = existsSync(changelogPath)
		? readFileSync(changelogPath, "utf8")
				.split("\n")
				.map((line) => line.trimEnd())
		: [];
	const start = lines.findIndex(
		(line) => line.match(RELEASE_HEADING_PATTERN)?.[1] === nextVersion,
	);
	const end = lines.findIndex(
		(line, index) => index > start && line.startsWith("## "),
	);
	const description =
		start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
	if (
		!description.some((line) => {
			const text = line.trim();
			return !["", "-", "*", "+"].includes(text) && !text.startsWith("#");
		})
	) {
		throw new Error(
			`Add a nonempty entry for ${nextVersion} to pi-package/CHANGELOG.md before changing the package version.`,
		);
	}
}

/** Runs release checks and changes the version only when its changelog entry is ready. */
export function checkRelease(
	root: string,
	run: ReleaseCommand,
	kind?: ReleaseKind,
): void {
	const packageDir = join(root, "pi-package");
	if (kind !== undefined) {
		requireReleaseChangelog(packageDir, kind);
	}
	run(["bun", "install", "--frozen-lockfile"], root);
	run(["bun", "install", "--frozen-lockfile"], packageDir);
	run(["bun", "run", "verify"], root);
	run(["make", "audit"], root);
	for (const scenario of ["SCN-02", "SCN-03"]) {
		run(["bun", "scripts/release-consumers.ts", scenario], root);
	}
	if (kind !== undefined) {
		run(["npm", "version", kind, "--no-git-tag-version"], packageDir);
	}
}

if (import.meta.main) {
	const kind = process.argv[2];
	if (
		kind !== undefined &&
		kind !== "patch" &&
		kind !== "minor" &&
		kind !== "major"
	) {
		throw new Error("Expected patch, minor, major, or no release kind");
	}
	checkRelease(
		resolve(import.meta.dir, ".."),
		(command, cwd) => {
			const [executable, ...args] = command;
			if (!executable) {
				throw new Error("Empty release command");
			}
			const result = spawnSync(executable, args, {
				cwd,
				stdio: "inherit",
				timeout: 900_000,
			});
			if (result.error || result.status !== 0) {
				throw new Error(`Release check failed: ${command.join(" ")}`, {
					cause: result.error,
				});
			}
		},
		kind,
	);
}
