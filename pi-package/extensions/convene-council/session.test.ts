import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { seedParticipantSessions } from "./session";

/** Creates a user message for seeding tests. */
function userMessage(content: string) {
	return { role: "user" as const, content, timestamp: 1 };
}

describe("participant session seeding", () => {
	test("writes equivalent persisted sessions under the OS temp directory", async () => {
		// Purpose: participant sessions must be physically present before child Pi opens them.
		// Input and expected output: a user-only snapshot creates two JSONL files with identical messages.
		// Edge case: user-only snapshots must not rely on SessionManager assistant-message persistence.
		// Dependencies: real temporary filesystem under the OS temp directory.
		const seed = await seedParticipantSessions({
			cwd: "/tmp/project",
			messages: [userMessage("first"), userMessage("second")],
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
			expect(llm1Entries.map((entry) => entry.type)).toEqual([
				"session",
				"message",
				"message",
			]);
			expect(
				llm1Entries
					.slice(1)
					.map((entry) => (entry.type === "message" ? entry.message : null)),
			).toEqual(
				llm2Entries
					.slice(1)
					.map((entry) => (entry.type === "message" ? entry.message : null)),
			);
			expect(llm1Entries[1]).toMatchObject({ parentId: null });
			expect(llm1Entries[2]).toMatchObject({ parentId: llm1Entries[1]?.id });
		} finally {
			await seed.cleanup();
		}
		expect(existsSync(seed.rootDir)).toBe(false);
	});
});
