import { describe, expect, test } from "bun:test";
import { checkRelease } from "./release.ts";

// Purpose: release failures must stop preparation before npm changes the version.
// Inputs: a fake command runner fails installation, validation, audit, or either consumer scenario.
// Expected: frozen installation runs first; errors propagate; success bumps last.
// Edges: all release kinds use the same checks. No real npm, git, or registry.
// Dependencies: checkRelease only; no dependency on other tests.
describe("release preparation", () => {
	for (const failure of ["install", "verify", "audit", "SCN-02", "SCN-03"]) {
		test(`stops before changing the version on ${failure} failure`, () => {
			const commands: string[][] = [];
			expect(() =>
				checkRelease(
					"/fixture",
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
		});
	}

	test.each([
		"patch",
		"minor",
		"major",
		undefined,
	] as const)("installs dependencies before checks for release kind %s", (kind) => {
		const calls: { command: readonly string[]; cwd: string }[] = [];
		checkRelease(
			"/fixture",
			(command, cwd) => calls.push({ command, cwd }),
			kind,
		);
		expect(calls).toEqual([
			{ command: ["bun", "install", "--frozen-lockfile"], cwd: "/fixture" },
			{ command: ["bun", "run", "verify"], cwd: "/fixture" },
			{ command: ["make", "audit"], cwd: "/fixture" },
			{
				command: ["bun", "scripts/release-consumers.ts", "SCN-02"],
				cwd: "/fixture",
			},
			{
				command: ["bun", "scripts/release-consumers.ts", "SCN-03"],
				cwd: "/fixture",
			},
			...(kind === undefined
				? []
				: [
						{
							command: ["npm", "version", kind, "--no-git-tag-version"],
							cwd: "/fixture/pi-package",
						},
					]),
		]);
	});
});
