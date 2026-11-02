import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../test/support/temp-dir";
import { checkRelease } from "./release.ts";

/** Creates isolated release inputs without running package-manager commands. */
function createReleaseFixture(changelog?: string) {
	const fixture = createTempDir("release-changelog-");
	const packageDir = join(fixture.path, "pi-package");
	mkdirSync(packageDir);
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ version: "2.21.7" }),
	);
	if (changelog !== undefined) {
		writeFileSync(join(packageDir, "CHANGELOG.md"), changelog);
	}
	return fixture;
}

// Purpose: release failures must stop preparation before npm changes the version.
// Inputs: isolated manifests and changelogs, with a fake command runner.
// Expected: changelog errors stop all commands; valid entries allow checks before the version change.
// Edges: all release kinds share the guard; validation without a version change needs no entry.
// Dependencies: temporary fixture files and checkRelease; no real npm, git, or registry.
describe("release preparation", () => {
	for (const failure of ["install", "verify", "audit", "SCN-02", "SCN-03"]) {
		test(`stops before changing the version on ${failure} failure`, () => {
			const fixture = createReleaseFixture(
				"## [2.21.8]\n\n- Preserve tool restrictions.\n",
			);
			try {
				const commands: string[][] = [];
				expect(() =>
					checkRelease(
						fixture.path,
						(command) => {
							commands.push([...command]);
							if (command.includes(failure)) {
								throw new Error(`${failure} failed`);
							}
						},
						"patch",
					),
				).toThrow(`${failure} failed`);
				if (failure === "install") {
					expect(commands).toEqual([["bun", "install", "--frozen-lockfile"]]);
				}
				expect(commands.some((command) => command.includes("version"))).toBe(
					false,
				);
			} finally {
				fixture.remove();
			}
		});
	}

	test.each([
		["patch", "2.21.8"],
		["minor", "2.22.0"],
		["major", "3.0.0"],
		[undefined, undefined],
	] as const)("checks before changing the version for release kind %s", (kind, version) => {
		const fixture = createReleaseFixture(
			version === undefined
				? undefined
				: `# Changelog\n\n## [${version}] - 2026-11-02\n\n### Fixed\n\n- Preserve tool restrictions.\n`,
		);
		try {
			const calls: { command: readonly string[]; cwd: string }[] = [];
			checkRelease(
				fixture.path,
				(command, cwd) => calls.push({ command, cwd }),
				kind,
			);
			expect(calls).toEqual([
				{ command: ["bun", "install", "--frozen-lockfile"], cwd: fixture.path },
				{
					command: ["bun", "install", "--frozen-lockfile"],
					cwd: join(fixture.path, "pi-package"),
				},
				{ command: ["bun", "run", "verify"], cwd: fixture.path },
				{ command: ["make", "audit"], cwd: fixture.path },
				{
					command: ["bun", "scripts/release-consumers.ts", "SCN-02"],
					cwd: fixture.path,
				},
				{
					command: ["bun", "scripts/release-consumers.ts", "SCN-03"],
					cwd: fixture.path,
				},
				...(kind === undefined
					? []
					: [
							{
								command: ["npm", "version", kind, "--no-git-tag-version"],
								cwd: join(fixture.path, "pi-package"),
							},
						]),
			]);
		} finally {
			fixture.remove();
		}
	});

	for (const kind of ["patch", "minor", "major"] as const) {
		for (const [name, changelog] of [
			["missing file", undefined],
			["unreleased changes only", "## [Unreleased]\n\n- New behavior.\n"],
			["another version", "## [2.21.7]\n\n- Previous behavior.\n"],
			["empty entry", "## [2.21.8]\n\n## [2.22.0]\n\n## [3.0.0]\n"],
			[
				"description belongs to another release",
				"## [2.21.8]\n## [2.22.0]\n## [3.0.0]\n## [2.21.7]\n- Previous behavior.\n",
			],
			[
				"headings only",
				"## [2.21.8]\n### Fixed\n## [2.22.0]\n### Added\n## [3.0.0]\n### Changed\n",
			],
			["empty bullet", "## [2.21.8]\n-\n## [2.22.0]\n-\n## [3.0.0]\n-\n"],
		] as const) {
			test(`blocks ${kind} version change for ${name}`, () => {
				const fixture = createReleaseFixture(changelog);
				try {
					const calls: string[][] = [];
					expect(() =>
						checkRelease(
							fixture.path,
							(command) => calls.push([...command]),
							kind,
						),
					).toThrow("pi-package/CHANGELOG.md");
					expect(calls).toEqual([]);
					expect(
						JSON.parse(
							readFileSync(
								join(fixture.path, "pi-package/package.json"),
								"utf8",
							),
						).version,
					).toBe("2.21.7");
					if (changelog !== undefined) {
						expect(
							readFileSync(
								join(fixture.path, "pi-package/CHANGELOG.md"),
								"utf8",
							),
						).toBe(changelog);
					}
				} finally {
					fixture.remove();
				}
			});
		}
	}
});
