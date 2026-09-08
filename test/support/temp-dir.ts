import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDir(prefix: string): {
	path: string;
	remove: () => void;
} {
	const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
