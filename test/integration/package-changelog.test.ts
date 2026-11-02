import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../support/temp-dir";

test("includes the default Pi changelog in the published npm package", () => {
	// Purpose: an installed package must contain the changelog that Pi reads after updates.
	// Input and expected output: the package manifest and a fixture changelog produce an npm archive file list containing CHANGELOG.md.
	// Edge case: npm's files allowlist must retain the changelog explicitly.
	// Dependencies: npm's real pack selection and isolated temporary package files.
	const fixture = createTempDir("pi-package-changelog-");
	try {
		copyFileSync(
			join(import.meta.dir, "../../pi-package/package.json"),
			join(fixture.path, "package.json"),
		);
		writeFileSync(
			join(fixture.path, "CHANGELOG.md"),
			"# Changelog\n\n## [1.0.0]\n\n- Initial release.\n",
		);
		const result = spawnSync(
			"npm",
			["pack", "--dry-run", "--json", "--ignore-scripts"],
			{
				cwd: fixture.path,
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const packages = Object.values(
			JSON.parse(result.stdout) as Record<
				string,
				{ readonly files: readonly { readonly path: string }[] }
			>,
		);
		expect(packages[0]?.files.map((file) => file.path)).toContain(
			"CHANGELOG.md",
		);
	} finally {
		fixture.remove();
	}
});
