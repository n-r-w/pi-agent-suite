import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { createParticipantSessions } from "./session";

/** Matches Pi-compatible UUIDv7 session identifiers. */
const PI_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("participant session ownership", () => {
	test("writes owned persisted sessions without parent messages", async () => {
		// Purpose: participant sessions must use UUIDv7 without inheriting the main agent transcript.
		// Input and expected output: each child JSONL file contains one session header with a Pi-compatible ID.
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
			expect(llm1Entries[0]).toMatchObject({
				type: "session",
				id: expect.stringMatching(PI_SESSION_ID_PATTERN),
			});
			expect(llm2Entries[0]).toMatchObject({
				type: "session",
				id: expect.stringMatching(PI_SESSION_ID_PATTERN),
			});
		} finally {
			await seed.cleanup();
		}
		expect(existsSync(seed.rootDir)).toBe(false);
	});
});
