import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export type ReleaseKind = "patch" | "minor" | "major";
export type ReleaseCommand = (command: readonly string[], cwd: string) => void;

export function checkRelease(
	root: string,
	run: ReleaseCommand,
	kind?: ReleaseKind,
): void {
	run(["bun", "run", "verify"], root);
	run(["make", "audit"], root);
	for (const scenario of ["SCN-02", "SCN-03"]) {
		run(["bun", "scripts/release-consumers.ts", scenario], root);
	}
	if (kind !== undefined) {
		run(
			["npm", "version", kind, "--no-git-tag-version"],
			join(root, "pi-package"),
		);
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
