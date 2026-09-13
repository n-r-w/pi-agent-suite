import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type UsageEvent, UsageStore } from "./store";

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "usage-store-test-"));
	temporaryDirectories.push(directory);
	return join(directory, "nested", "usage.sqlite");
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
	return {
		eventId: "event-1",
		timestampMs: 1_000,
		sessionId: "session-1",
		agentId: "agent-a",
		source: "agent-turn",
		provider: "provider-b",
		model: "model-c",
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		cost: 0.5,
		saved: 0.25,
		...overrides,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("usage SQLite store", () => {
	test("creates schema and keeps repeated event delivery idempotent", () => {
		// Purpose: prove durable schema initialization and stable event-id deduplication.
		// Inputs and expected output: a nested database path and the same complete event inserted twice produce one row.
		// Edge case: the database parent directory does not exist before opening.
		// Dependencies: isolated system temporary storage and built-in node:sqlite.
		const path = temporaryDatabasePath();
		const store = new UsageStore(path);
		store.insert(event());
		store.insert(event());

		expect(store.queryRange(0, 2_000)).toEqual([event()]);
		store.close();

		const database = new DatabaseSync(path);
		expect(database.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 1,
		});
		database.close();
	});

	test("coordinates inserts from two process-local connections", () => {
		// Purpose: prove the WAL store accepts distinct events from concurrent Pi process connections.
		// Inputs and expected output: two stores open the same temporary database and each insert one event visible in one query.
		// Edge case: schema initialization repeats while another connection remains open.
		// Dependencies: isolated system temporary storage and SQLite WAL coordination.
		const path = temporaryDatabasePath();
		const first = new UsageStore(path);
		const second = new UsageStore(path);
		first.insert(event({ eventId: "first" }));
		second.insert(event({ eventId: "second" }));

		expect(first.queryRange(0, 2_000).map((row) => row.eventId)).toEqual([
			"first",
			"second",
		]);
		second.close();
		first.close();
	});

	test("transactionally resets committed events while preserving schema", () => {
		// Purpose: the reset operation must clear committed usage without deleting the database structure.
		// Inputs and expected output: two committed events followed by reset produce an empty query and retain schema version and indexes.
		// Edge case: the same open store accepts a new event after reset.
		// Dependencies: isolated system temporary storage and the production SQLite transaction.
		const path = temporaryDatabasePath();
		const store = new UsageStore(path);
		store.insert(event({ eventId: "first" }));
		store.insert(event({ eventId: "second" }));
		store.reset();
		expect(store.queryRange(0, 2_000)).toEqual([]);
		store.insert(event({ eventId: "after-reset" }));
		expect(store.queryRange(0, 2_000)).toHaveLength(1);
		store.close();

		const database = new DatabaseSync(path);
		expect(database.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 1,
		});
		expect(
			database
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_events_timestamp'",
				)
				.get(),
		).toEqual({ name: "usage_events_timestamp" });
		database.close();
	});

	test("deletes only events older than the retention cutoff", () => {
		// Purpose: startup retention must use the timestamp index boundary without removing supported history.
		// Inputs and expected output: rows before, at, and after the cutoff retain the cutoff and later rows.
		// Edge case: the deletion boundary is exclusive.
		// Dependencies: isolated system temporary storage and the production cleanup statement.
		const store = new UsageStore(temporaryDatabasePath());
		store.insert(event({ eventId: "before", timestampMs: 99 }));
		store.insert(event({ eventId: "cutoff", timestampMs: 100 }));
		store.insert(event({ eventId: "after", timestampMs: 101 }));
		store.cleanupBefore(100);
		expect(store.queryRange(0, 200).map((row) => row.eventId)).toEqual([
			"cutoff",
			"after",
		]);
		store.close();
	});

	test("returns only events in the inclusive requested range", () => {
		// Purpose: prove that the indexed historical read applies both time boundaries.
		// Inputs and expected output: events before, at both limits, and after return only the two boundary rows.
		// Edge case: both range endpoints are inclusive.
		// Dependencies: isolated system temporary storage and the production schema.
		const store = new UsageStore(temporaryDatabasePath());
		store.insert(event({ eventId: "before", timestampMs: 99 }));
		store.insert(event({ eventId: "start", timestampMs: 100 }));
		store.insert(event({ eventId: "end", timestampMs: 200 }));
		store.insert(event({ eventId: "after", timestampMs: 201 }));

		expect(store.queryRange(100, 200).map((row) => row.eventId)).toEqual([
			"start",
			"end",
		]);
		store.close();
	});
});
