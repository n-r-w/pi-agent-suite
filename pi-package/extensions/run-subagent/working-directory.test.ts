import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkingDirectory } from "./working-directory";

describe("working directory", () => {
	test("returns the physical directory for a symlink and retains path diagnostics for invalid targets", () => {
		const fixture = mkdtempSync(join(tmpdir(), "subagent-working-directory-"));
		try {
			const physical = join(fixture, "project");
			const alias = join(fixture, "alias");
			mkdirSync(physical);
			symlinkSync(physical, alias, "dir");
			expect(resolveWorkingDirectory(alias)).toBe(physical);
			const file = join(fixture, "file");
			writeFileSync(file, "fixture");
			for (const path of [join(fixture, "missing"), file]) {
				expect(() => resolveWorkingDirectory(path)).toThrow(path);
			}
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
