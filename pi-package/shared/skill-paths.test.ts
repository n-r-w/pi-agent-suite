import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getReadToolCallPath, resolveReadInputPath } from "./skill-paths";

test("extracts supported read arguments and rejects missing paths", () => {
	expect(getReadToolCallPath({ path: "primary", file_path: "alternate" })).toBe(
		"primary",
	);
	expect(getReadToolCallPath({ file_path: "alternate" })).toBe("alternate");
	expect(getReadToolCallPath({ path: 1, file_path: "alternate" })).toBe(
		"alternate",
	);
	for (const args of [null, [], "path", {}, { path: 1 }]) {
		expect(getReadToolCallPath(args)).toBeUndefined();
	}
});

test("resolves @ prefixes and home-directory shorthand", () => {
	const cwd = resolve("test/fixtures");
	expect(resolveReadInputPath("@notes.md", cwd)).toBe(resolve(cwd, "notes.md"));
	expect(resolveReadInputPath("@~/notes.md", cwd)).toBe(
		resolve(homedir(), "notes.md"),
	);
	expect(resolveReadInputPath("~", cwd)).toBe(resolve(homedir()));
});
