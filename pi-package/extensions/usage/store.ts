import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuxiliaryUsageSource } from "../../shared/usage-events";
import type { UsageSessionTotals } from "../../shared/usage-read-broker";

const BUSY_TIMEOUT_MS = 5_000;

export type UsageEventSource = "agent-turn" | "pi-usage" | AuxiliaryUsageSource;

export interface UsageEvent {
	readonly eventId: string;
	readonly timestampMs: number;
	readonly sessionId: string;
	readonly rootSessionId: string;
	readonly agentId: string;
	readonly source: UsageEventSource;
	readonly provider: string;
	readonly model: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly saved: number;
}

interface UsageEventRow {
	readonly event_id: string;
	readonly timestamp_ms: number;
	readonly session_id: string;
	readonly root_session_id: string;
	readonly agent_id: string;
	readonly source: UsageEventSource;
	readonly provider: string;
	readonly model: string;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_read_tokens: number;
	readonly cache_write_tokens: number;
	readonly cost: number;
	readonly cache_savings: number;
}

/** Owns one process-local SQLite connection for usage history. */
export class UsageStore {
	private readonly database: DatabaseSync;
	private readonly insertStatement;
	private readonly queryRangeStatement;
	private readonly queryRootCostStatement;
	private readonly querySessionTotalsStatement;
	private readonly cleanupStatement;
	private readonly resetStatement;

	public constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		this.database.exec(`
			PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS usage_events (
				event_id TEXT PRIMARY KEY,
				timestamp_ms INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				root_session_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				source TEXT NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
				output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
				cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
				cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
				cost REAL NOT NULL CHECK (cost >= 0),
				cache_savings REAL NOT NULL CHECK (cache_savings >= 0)
			);
			CREATE INDEX IF NOT EXISTS usage_events_timestamp
				ON usage_events(timestamp_ms);
			CREATE INDEX IF NOT EXISTS usage_events_root_session
				ON usage_events(root_session_id);
			CREATE INDEX IF NOT EXISTS usage_events_session
				ON usage_events(session_id);
		`);
		this.insertStatement = this.database.prepare(`
			INSERT OR IGNORE INTO usage_events (
				event_id, timestamp_ms, session_id, root_session_id, agent_id, source,
				provider, model, input_tokens, output_tokens, cache_read_tokens,
				cache_write_tokens, cost, cache_savings
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.queryRangeStatement = this.database.prepare(`
			SELECT event_id, timestamp_ms, session_id, root_session_id, agent_id,
				source, provider, model, input_tokens, output_tokens, cache_read_tokens,
				cache_write_tokens, cost, cache_savings
			FROM usage_events
			WHERE timestamp_ms >= ? AND timestamp_ms <= ?
			ORDER BY timestamp_ms, event_id
		`);
		this.queryRootCostStatement = this.database.prepare(`
			SELECT
				COALESCE(SUM(cost), 0) AS total_cost,
				COALESCE(SUM(
					input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
				), 0) AS total_tokens
			FROM usage_events
			WHERE root_session_id = ?
		`);
		this.querySessionTotalsStatement = this.database.prepare(`
			SELECT
				COALESCE(SUM(cost), 0) AS total_cost,
				COALESCE(SUM(
					input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
				), 0) AS total_tokens
			FROM usage_events
			WHERE session_id = ?
		`);
		this.cleanupStatement = this.database.prepare(`
			DELETE FROM usage_events WHERE timestamp_ms < ?
		`);
		this.resetStatement = this.database.prepare("DELETE FROM usage_events");
	}

	/** Inserts one complete event and ignores repeated delivery of its stable ID. */
	public insert(event: UsageEvent): void {
		this.insertStatement.run(
			event.eventId,
			event.timestampMs,
			event.sessionId,
			event.rootSessionId,
			event.agentId,
			event.source,
			event.provider,
			event.model,
			event.input,
			event.output,
			event.cacheRead,
			event.cacheWrite,
			event.cost,
			event.saved,
		);
	}

	/** Reads one inclusive time range from the timestamp index. */
	public queryRange(startMs: number, endMs: number): UsageEvent[] {
		return (
			this.queryRangeStatement.all(startMs, endMs) as unknown as UsageEventRow[]
		).map((row) => ({
			eventId: row.event_id,
			timestampMs: row.timestamp_ms,
			sessionId: row.session_id,
			rootSessionId: row.root_session_id,
			agentId: row.agent_id,
			source: row.source,
			provider: row.provider,
			model: row.model,
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			cost: row.cost,
			saved: row.cache_savings,
		}));
	}

	/** Reads cumulative cost and processed tokens for one root session family. */
	public queryRootTotals(rootSessionId: string): UsageSessionTotals {
		const row = this.queryRootCostStatement.get(rootSessionId) as {
			readonly total_cost: number;
			readonly total_tokens: number;
		};
		return { cost: row.total_cost, tokens: row.total_tokens };
	}

	/** Reads total cost for one root session family. */
	public queryRootCost(rootSessionId: string): number {
		return this.queryRootTotals(rootSessionId).cost;
	}

	/** Reads cumulative cost and processed tokens for one Pi session. */
	public querySessionTotals(sessionId: string): UsageSessionTotals {
		const row = this.querySessionTotalsStatement.get(sessionId) as {
			readonly total_cost: number;
			readonly total_tokens: number;
		};
		return { cost: row.total_cost, tokens: row.total_tokens };
	}

	/** Deletes events before the exclusive retention boundary through the timestamp index. */
	public cleanupBefore(cutoffMs: number): void {
		this.cleanupStatement.run(cutoffMs);
	}

	/** Deletes all events in one immediate transaction while preserving storage structure. */
	public reset(): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.resetStatement.run();
			this.database.exec("COMMIT");
		} catch (error) {
			// Rollback keeps a failed reset from leaving this connection inside a transaction.
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** Closes the connection for direct store owners such as isolated tests. */
	public close(): void {
		this.database.close();
	}
}
