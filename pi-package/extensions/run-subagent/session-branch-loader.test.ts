import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	openSessionBranchCursor,
	readLatestSessionEntryId,
} from "./session-branch-loader";

/** Creates one deterministic user entry for a JSONL session fixture. */
function userEntry(
	id: string,
	parentId: string | null,
	text: string,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

/** Creates one custom entry that keeps branch routing independent of rendering. */
function customEntry(id: string, parentId: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		customType: "fixture",
		data: { text: id },
	};
}

/** Writes one Pi-compatible append-only session fixture. */
function writeSession(
	directory: string,
	entries: readonly SessionEntry[],
): string {
	const sessionFile = join(directory, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "session-fixture",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: directory,
	};
	writeFileSync(
		sessionFile,
		`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return sessionFile;
}

/** Removes one temporary branch-loader fixture directory. */
function removeFixture(directory: string): void {
	rmSync(directory, { recursive: true, force: true });
}

describe("session branch loader", () => {
	test("reads the selected branch backward as complete user turns", async () => {
		// Purpose: prove that preview pagination follows parentId instead of append order and never starts with an orphaned tool/custom result.
		// Input and expected output: a file with two branches returns the latest branch turn first and its shared ancestor turn second.
		// Edge case: an off-branch entry is newer than the shared ancestor but must never enter the selected preview.
		// Dependencies: only a system-temporary JSONL fixture and the production reverse cursor.
		const directory = mkdtempSync(join(tmpdir(), "subagent-branch-loader-"));
		try {
			const root = userEntry("root", null, "root prompt");
			const shared = customEntry("shared", root.id);
			const abandoned = userEntry("abandoned", shared.id, "abandoned branch");
			const selected = userEntry("selected", shared.id, "selected branch");
			const leaf = customEntry("leaf", selected.id);
			const sessionFile = writeSession(directory, [
				root,
				shared,
				abandoned,
				selected,
				leaf,
			]);

			const cursor = await openSessionBranchCursor({ sessionFile });
			const latestTurn = await cursor.readPreviousTurn();
			const earlierTurn = await cursor.readPreviousTurn();

			expect(latestTurn.map((entry) => entry.id)).toEqual(["selected", "leaf"]);
			expect(earlierTurn.map((entry) => entry.id)).toEqual(["root", "shared"]);
			expect(cursor.complete).toBe(true);
			expect(await cursor.readRemaining()).toEqual([]);
			await cursor.dispose();
		} finally {
			removeFixture(directory);
		}
	});

	test("finds an explicit earlier leaf and consumes remaining ancestors", async () => {
		// Purpose: prove that active leaf selection is independent from the physically latest appended branch.
		// Input and expected output: an explicit abandoned leaf returns only its branch, while readRemaining returns the shared root turn.
		// Edge case: the cursor skips a later branch while searching backward for the requested leaf.
		// Dependencies: only a system-temporary JSONL fixture and the production reverse cursor.
		const directory = mkdtempSync(join(tmpdir(), "subagent-branch-leaf-"));
		try {
			const root = userEntry("root", null, "root prompt");
			const shared = customEntry("shared", root.id);
			const abandoned = userEntry("abandoned", shared.id, "abandoned branch");
			const selected = userEntry("selected", shared.id, "selected branch");
			const sessionFile = writeSession(directory, [
				root,
				shared,
				abandoned,
				selected,
			]);

			const cursor = await openSessionBranchCursor({
				sessionFile,
				leafId: abandoned.id,
			});
			const latestTurn = await cursor.readPreviousTurn();
			const remaining = await cursor.readRemaining();

			expect(latestTurn.map((entry) => entry.id)).toEqual(["abandoned"]);
			expect(remaining.map((entry) => entry.id)).toEqual(["root", "shared"]);
			expect(cursor.complete).toBe(true);
			await cursor.dispose();
		} finally {
			removeFixture(directory);
		}
	});

	test("reads the latest id and rejects cancelled or disposed reads", async () => {
		// Purpose: prove that active catch-up can identify the persisted append boundary and that selection cancellation closes file work.
		// Input and expected output: a UTF-8 entry is found as latest, a pre-aborted open rejects, and a disposed cursor rejects later reads.
		// Edge case: a large multibyte scalar crosses reverse-read chunk boundaries without corrupting the entry id.
		// Dependencies: only a system-temporary JSONL fixture, AbortController, and the production reverse reader.
		const directory = mkdtempSync(join(tmpdir(), "subagent-branch-abort-"));
		try {
			const root = userEntry("root", null, "начало");
			const large = userEntry("large", root.id, "🙂".repeat(40_000));
			const sessionFile = writeSession(directory, [root, large]);
			expect(await readLatestSessionEntryId(sessionFile)).toBe("large");

			const controller = new AbortController();
			controller.abort(new Error("selection changed"));
			await expect(
				openSessionBranchCursor({
					sessionFile,
					signal: controller.signal,
				}),
			).rejects.toThrow("selection changed");

			const cursor = await openSessionBranchCursor({ sessionFile });
			await cursor.dispose();
			await expect(cursor.readPreviousTurn()).rejects.toThrow(
				"session branch cursor is disposed",
			);
		} finally {
			removeFixture(directory);
		}
	});
});
