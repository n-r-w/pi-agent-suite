import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistedSession } from "../../../test/support/persisted-session";
import { SessionSnapshotLoader } from "./session-snapshot-loader";

const fixtures: string[] = [];

/** Creates one isolated temporary directory owned by the current test. */
function createFixtureDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "session-snapshot-loader-"));
	fixtures.push(directory);
	return directory;
}

/** Removes every isolated session fixture after its test. */
afterEach(() => {
	for (const directory of fixtures.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SessionSnapshotLoader", () => {
	test("loads a branch through the public SessionManager", async () => {
		// Purpose: saved conversations must be interpreted exclusively by the installed Pi version.
		// Input and expected output: one public persisted session produces the same root-to-leaf branch through the production loader.
		// Edge case: the loader must delegate storage parsing to SessionManager rather than interpret JSONL itself.
		// Dependencies: a temporary public SessionManager fixture and the production snapshot loader.
		const directory = createFixtureDirectory();
		const manager = createPersistedSession(directory, {
			id: "snapshot-session",
			text: "loaded by Pi",
		});
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) {
			throw new Error("persisted session fixture did not create a file");
		}
		const loader = new SessionSnapshotLoader();

		const branch = await loader.load(sessionFile);

		expect(branch).toEqual(manager.getBranch());
	});

	test("deduplicates concurrent loads of one session file", async () => {
		// Purpose: one saved file must not be opened by two SessionManager migrations at the same time.
		// Input and expected output: two concurrent requests for one file share the same in-flight promise and result.
		// Edge case: deduplication applies before the asynchronous file preflight has completed.
		// Dependencies: a temporary public SessionManager fixture and the production in-flight registry.
		const directory = createFixtureDirectory();
		const manager = createPersistedSession(directory, {
			id: "deduplicated-session",
			text: "one load",
		});
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) {
			throw new Error("persisted session fixture did not create a file");
		}
		const loader = new SessionSnapshotLoader();

		const first = loader.load(sessionFile);
		const second = loader.load(sessionFile);

		expect(second).toBe(first);
		await expect(first).resolves.toEqual(manager.getBranch());
	});

	test("rejects missing, empty, and invalid session files", async () => {
		// Purpose: snapshot loading must fail without allowing SessionManager to create or initialize invalid paths.
		// Input and expected output: missing, empty, and non-session files each reject with an actionable loading error.
		// Edge case: an existing zero-byte file must remain empty after rejection.
		// Dependencies: isolated temporary files and the production preflight boundary.
		const directory = createFixtureDirectory();
		const missingFile = join(directory, "missing.jsonl");
		const emptyFile = join(directory, "empty.jsonl");
		const invalidFile = join(directory, "invalid.jsonl");
		closeSync(openSync(emptyFile, "w"));
		writeFileSync(invalidFile, "not a Pi session\n");
		const loader = new SessionSnapshotLoader();

		await expect(loader.load(missingFile)).rejects.toThrow(
			"saved Pi session file is unavailable",
		);
		await expect(loader.load(emptyFile)).rejects.toThrow(
			"saved Pi session file is empty",
		);
		await expect(loader.load(invalidFile)).rejects.toThrow(
			"failed to load saved Pi session",
		);
		expect(Bun.file(emptyFile).size).toBe(0);
	});
});
