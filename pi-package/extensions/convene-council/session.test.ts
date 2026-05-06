import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { createParticipantSessions } from "./session";

describe("participant session ownership", () => {
	test("writes owned persisted sessions without parent messages", async () => {
		// Purpose: participant sessions must not inherit the main agent transcript as memory.
		// Input and expected output: each child JSONL file contains only the session header.
		// Edge case: cleanup still removes both empty participant session directories.
		// Dependencies: real temporary filesystem under the OS temp directory.
		const seed = await createParticipantSessions({
			cwd: "/tmp/project",
		});
		try {
			expect(seed.rootDir.startsWith(tmpdir())).toBe(true);
			expect(existsSync(seed.sessions.llm1.sessionFile)).toBe(true);
			expect(existsSync(seed.sessions.llm2.sessionFile)).toBe(true);

			const llm1Entries = parseSessionEntries(
				readFileSync(seed.sessions.llm1.sessionFile, "utf8"),
			);
			const llm2Entries = parseSessionEntries(
				readFileSync(seed.sessions.llm2.sessionFile, "utf8"),
			);
			expect(llm1Entries.map((entry) => entry.type)).toEqual(["session"]);
			expect(llm2Entries.map((entry) => entry.type)).toEqual(["session"]);
		} finally {
			await seed.cleanup();
		}
		expect(existsSync(seed.rootDir)).toBe(false);
	});
});
