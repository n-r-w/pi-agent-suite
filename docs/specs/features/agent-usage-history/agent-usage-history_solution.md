# Technical Solution: Historical Agent Usage

## Problem Statement

- `docs/specs/features/agent-usage-history/agent-usage-history_problem.md`
- `docs/specs/features/agent-usage-history/agent-usage-history_prd.md`

## Proposed Solution

### 1. Overview

Add a dedicated `pi-package/extensions/usage` extension backed by an independent local SQLite database.

```text
Regular assistant response ─────┐
Every auxiliary model path ─────┼─> validate and attribute ─> usage.sqlite
                                │                              │
Current agent identity ─────────┤                              └─> /usage TUI
Root-session-family identity ───┘
```

The extension records complete usage events when model requests finish. `/usage` queries only this database and never scans Pi conversation sessions or imports prior history.

### 2. Files and Configuration

The extension owns this directory:

```text
{Pi agent dir}/agent-suite/usage/
├── config.json
└── data/
    ├── usage.sqlite
    ├── usage.sqlite-wal
    └── usage.sqlite-shm
```

`usage.sqlite` is the main database. SQLite creates and removes the WAL and shared-memory files as needed.

The configuration contract is:

```json
{
  "enabled": true
}
```

The parser uses the existing suite configuration helpers and applies these rules:

- a missing file means `enabled: true`;
- only the `enabled` key is accepted;
- `enabled` must be a boolean;
- unreadable, malformed, unsupported, or incorrectly typed configuration disables the extension;
- invalid configuration produces one error notification in an interactive session;
- configuration is read once during extension loading and changes require a Pi restart.

When disabled, the extension does not open the database, record events, register `/usage`, run cleanup, or delete existing files.

### 3. Runtime Ownership

Every enabled Pi process opens its own SQLite connection and can record usage events.

Process roles use the existing shared child marker:

```ts
isChildAgentProcess(process.env)
```

A user-launched root Pi process:

- records its model usage;
- registers `/usage` in TUI mode;
- runs retention cleanup once during its first `session_start`;
- shows cleanup notifications when UI is available.

A marked child process:

- records subagent usage with its inherited root-session-family identity;
- does not register `/usage`;
- does not run retention cleanup;
- does not show cleanup notifications.

The root `run-subagent` runtime passes the active root Pi session ID to every launched child through one Subagents-owned environment field. Nested launches preserve the same value. Council participants are marked child processes, but their model responses are attributed through the root-side `convene-council` auxiliary usage hook rather than through child cleanup or UI behavior.

### 4. Cross-Extension Recording

The usage extension owns the SQLite connection and persistence logic for one Pi process.

Add `pi-package/shared/usage-events.ts` with a versioned event-bus request contract. This follows the existing cross-extension event-bus pattern required by Pi's cache-free Jiti extension loading.

- The usage extension subscribes to the record channel after successful configuration and database initialization.
- Its `message_end` handler creates one `eventId` and records the regular finalized assistant response with source `agent-turn`.
- The shared auxiliary recording boundary creates one `eventId` and publishes the ID with the complete assistant response and source. It does not append a cost-only session entry.
- `ask-llm`, `vision`, and `knowledge` publish the complete usage results available at their existing completion boundaries without adding attempt-tracking infrastructure.
- Native compaction records the final aggregate usage exposed by `session_compact` when `fromExtension` is false, which avoids duplicating custom compaction.
- Native branch summary records the final aggregate usage exposed by the completed `session_tree` event.
- The usage event-bus listener preserves the publisher-created `eventId`, adds session, root-session-family, and agent identity, validates the result, calculates cache savings, and inserts one database row.
- Repeated delivery of the same published request preserves its `eventId`. An emitted event without an active usage listener has no effect.

The complete auxiliary source set is:

- `consult-advisor`;
- `context-projection`;
- `convene-council`;
- `custom-compaction`;
- `subagent-query`;
- `ask-llm`;
- `vision`;
- `knowledge`;
- `native-compaction`;
- `branch-summary`.

### 5. Agent and Session Attribution

The recorder resolves identity when the model request finishes.

- A subagent uses `PI_SUBAGENT_AGENT_ID`.
- A root process uses `getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent.id`.
- A missing `agentId` maps to one reserved internal identity rendered as `No agent`.
- The active Pi session ID comes from the latest `session_start` context.
- A root event uses that session ID as both `sessionId` and `rootSessionId`.
- A child event uses its own Pi session ID as `sessionId` and the inherited root Pi session ID as `rootSessionId`.
- A request without a non-empty `sessionId` or `rootSessionId` is ignored.

Main-agent selection changes remain queued while a model request is active, so completion-time runtime composition identifies the agent that owns the request when one is selected. No identity marker is written to the Pi conversation session.

### 6. Usage Event

The normalized event contract is:

```ts
interface UsageEvent {
  readonly eventId: string;
  readonly timestampMs: number;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agentId: string;
  readonly source:
    | "agent-turn"
    | "consult-advisor"
    | "context-projection"
    | "convene-council"
    | "custom-compaction"
    | "subagent-query"
    | "ask-llm"
    | "vision"
    | "knowledge"
    | "native-compaction"
    | "branch-summary";
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly saved: number;
}
```

The regular `message_end` handler or auxiliary publisher creates `eventId` once before persistence or event-bus delivery. Every handling attempt preserves that UUID. The assistant response timestamp is used for `timestampMs`.

A record is inserted only when:

- `sessionId`, `rootSessionId`, `provider`, and `model` are non-empty;
- `agentId` is non-empty or is replaced by the reserved no-agent identity;
- timestamp is finite and non-negative;
- all token values are finite non-negative safe integers;
- `usage.cost.total` is finite and non-negative;
- `modelRegistry.find(provider, model)` provides the pricing needed for `saved`.

An incomplete request is ignored as one unit. The no-agent identity is the only synthesized classification. No model, usage, root-session, or historical value is inferred or imported.

### 7. Metric Calculation

The recorder calculates:

```text
Tokens = input + output + cacheRead + cacheWrite
Cost   = usage.cost.total
```

`Saved` is calculated before insertion from the actual model pricing:

```text
Saved = max(
  0,
  cost(cacheRead as ordinary input) - cost(cacheRead at the cache-read rate)
)
```

The calculation applies the model tier selected by the request's complete input volume. Persisting `saved` makes historical reads independent of later price-catalog changes.

For an aggregate row:

```text
Hit% = sum(cacheRead)
       / (sum(input) + sum(cacheRead) + sum(cacheWrite))
       × 100%
```

A zero denominator produces `0%`. `Hit%` uses aggregate token counts rather than an average of request percentages.

### 8. SQLite Storage

Use the built-in `node:sqlite` `DatabaseSync` API. Pi requires Node `>=22.19.0`, so no package dependency is added.

Database initialization applies:

```text
journal_mode = WAL
busy_timeout = bounded
```

The database contains no application schema-version metadata.

Schema:

```sql
CREATE TABLE usage_events (
    event_id           TEXT PRIMARY KEY,
    timestamp_ms       INTEGER NOT NULL,
    session_id         TEXT NOT NULL,
    root_session_id    TEXT NOT NULL,
    agent_id           TEXT NOT NULL,
    source             TEXT NOT NULL,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens      INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens  INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost               REAL NOT NULL CHECK (cost >= 0),
    cache_savings      REAL NOT NULL CHECK (cache_savings >= 0)
);

CREATE INDEX usage_events_timestamp
    ON usage_events(timestamp_ms);

CREATE INDEX usage_events_root_session
    ON usage_events(root_session_id);

CREATE INDEX usage_events_session
    ON usage_events(session_id);
```

Each event uses `INSERT OR IGNORE`. The stable publisher-created UUID primary key makes repeated handling of the same event idempotent. Different logical requests always receive different UUIDs even when their usage fields are equal.

The schema is changed directly without migration or compatibility branches. The old database must be removed before this schema is used.

SQLite WAL coordinates concurrent root and subagent connections. A write failure or lock timeout does not fail the completed model request. The event is omitted, and the original database error remains available through runtime diagnostics.

### 9. Retention Cleanup

Only a user-launched root Pi process runs cleanup. One in-process guard limits cleanup to the first `session_start` of that process, including session switches, reloads, and new sessions.

After schema initialization and before deletion, an interactive root shows:

```text
Usage cleanup started
```

Cleanup executes:

```sql
DELETE FROM usage_events
WHERE timestamp_ms < :startupTimeMs - 90 days;
```

Concurrent root processes may run the same indexed and idempotent deletion. SQLite serializes their write transactions. No timer, scheduler, maintenance table, or child-process cleanup is used.

After success, an interactive root shows:

```text
Usage cleanup completed
```

After failure, it shows the database path, operation, and original unsanitized error. `Error.stack` is included without rewriting when available. A cleanup failure does not disable subsequent event recording. A root process without UI performs the same cleanup without notifications.

SQLite reuses pages freed by deletion, so the main file approaches the high-water storage needed for the rolling 90-day event volume instead of growing with unlimited history.

### 10. Historical Query and Aggregation

Opening `/usage` captures one `openedAt` value and reads rows where:

```sql
timestamp_ms >= openedAt - 90 days
AND timestamp_ms <= openedAt
```

The query uses `usage_events_timestamp`. The extension aggregates the returned rows once into these rolling views:

- `1h`;
- `24h`;
- `7d`;
- `30d`;
- `90d`.

`7d` is the default. Changing the range filters the immutable in-memory snapshot and does not query SQLite again.

The opening context also captures the current root Pi session ID. The session selector displays `Sessions: [Current] All`. `Current` filters by that root session ID and `All` removes the root-session filter. Session scope changes reuse the same immutable query result.

Aggregation groups rows by:

```text
session scope
└── agentId or reserved no-agent identity
    └── provider/model
```

`All agents` contains every selected event once. The reserved identity is rendered as `No agent`. Agent IDs are sorted by normalized string value. Model rows are sorted by exact unrounded cost share descending, with normalized `provider/model` ascending as the tie-breaker.

### 11. Commands

The enabled root TUI registers one command, `/usage`.

- Empty arguments open the historical usage TUI.
- The exact argument `reset` starts the reset flow.
- Other arguments produce a command-usage error.
- `getArgumentCompletions` suggests `reset` after `/usage ` and matching prefixes.
- The command description mentions both viewing and reset behavior.

`/usage reset` calls `ctx.ui.confirm` before mutation. Confirmation executes:

```sql
BEGIN IMMEDIATE;
DELETE FROM usage_events;
COMMIT;
```

Cancellation makes no database change. Reset preserves `config.json`, the SQLite files, schema, and indexes. It deletes events committed before the reset transaction; events committed later by concurrent processes remain.

### 11.1 Footer Usage

The usage extension exposes a process-local read-only broker through the shared Pi event bus. The footer obtains cost and processed tokens only through this broker and does not open SQLite or scan session entries.

When `showApiCost` or `showApiTokens` is enabled, root `session_start` supplies the active root Pi session ID to the broker. The broker performs one indexed query:

```sql
SELECT
    COALESCE(SUM(cost), 0),
    COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)
FROM usage_events
WHERE root_session_id = :rootSessionId;
```

One root-only timer repeats this query every 10 seconds while the footer is active. The footer render path reads only the cached aggregate. The timer stops when the footer component is disposed. A maximum 10-second delay is accepted because the footer is informational rather than a billing surface.

The footer does not scan assistant entries or use cost-only session entries. It uses the same regular, subagent, and auxiliary event set as the Current `/usage` scope. Cost renders with three fractional digits and no subscription marker. Processed tokens use the shared usage token format with a `T` prefix.

If the initial broker read is unavailable because usage is disabled, invalid, failed during database initialization, or missing, the footer hides the enabled usage segments and an interactive root emits one warning. If a later refresh is unavailable, the footer hides the cached aggregate, emits the warning unless that root session already received it, and keeps the timer active. A later valid result restores the enabled segments. The footer warning remains independent from any usage extension startup error. The footer does not request the broker or warn when the footer is disabled or both usage segments are disabled.

### 11.2 Subagent Session Consumption

The `/subagents` screen sends the selected node's child Pi `sessionId` to the process-local usage broker. The broker returns one indexed aggregate:

```sql
SELECT
    COALESCE(SUM(cost), 0),
    COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)
FROM usage_events
WHERE session_id = :sessionId;
```

Rows from the initial invocation, later continuations, and auxiliary requests share the child Pi `sessionId` and contribute to the aggregate. The selected-session render reads the aggregate when Pi renders the overlay. When the broker is unavailable, the render omits both session-consumption fields.

### 12. TUI

The TUI continues to follow the approved `/subagents` interaction pattern.

Wide mode shows:

```text
┌─ USAGE ──────────────────────────────────────────────────────────────┐
│ Range: 1h  24h  [7d]  30d  90d   Sessions: [Current]  All        │
├──────────────────┬──────────────────────────────────────────────────┤
│ Agents           │ Model  Cost%  Tokens CacheR CacheW Hit% Cost Saved│
├──────────────────┼──────────────────────────────────────────────────┤
│ All agents       │ Total  100.0  ...                               │
│ MainAgent        │ provider/a ...                                  │
│ No agent         │ provider/b ...                                  │
├──────────────────┴──────────────────────────────────────────────────┤
│ context-sensitive key hints                                        │
└─────────────────────────────────────────────────────────────────────┘
```

Narrow mode shows the agent list first. `Enter` opens the model table, `Escape` returns to the list, and the next `Escape` closes the screen.

The screen provides focus zones for range, sessions, agents, and the table. `Tab` and `Shift+Tab` move one active focus among these zones. Inactive `Range`, `Sessions`, and `Agents` titles use the theme `accent` color. The active title uses `borderAccent` instead. All eight table headers use `accent` while the table is inactive and change together to `borderAccent` while the table is active. Data-row labels and numeric values keep the normal text color.

The selected agent has no dot marker. The renderer clips and pads its plain row before applying a background across the complete pane width. It uses `selectedBg` while Agents has focus and `toolPendingBg` while Range, Sessions, or the table has focus. Other agent rows have no selected background.

Every Agents vertical, table vertical, and table horizontal scroll track cell uses `theme.fg("muted", "░")`. A thumb in the focused pane uses `theme.fg("border", "█")`; a thumb in an inactive pane uses `theme.fg("borderMuted", "█")`. Range or Sessions focus leaves both pane thumbs inactive.

The table uses:

```text
Model | Cost% | Tokens | CacheR | CacheW | Hit% | Cost | Saved
```

The table computes one Model-column width with Pi `visibleWidth`. The width is at least 24 terminal columns and expands to the longest complete provider/model label. The header and all rows use this width, so every numeric column has one terminal start column. Existing horizontal scrolling provides access to labels and columns wider than the viewport.

`Tokens`, `CacheR`, and `CacheW` share one `/usage`-local formatter:

- values below 1,000 render as integers without a suffix;
- values from 1,000 render with `K`, no fractional digit, and upward rounding;
- values from 1,000,000 render with `M`, exactly one fractional digit, and upward rounding to one tenth;
- values from 1,000,000,000 render with `B`, exactly one fractional digit, and upward rounding to one tenth;
- a thousands value that rounds to `1000K` is promoted to millions;
- a millions value that rounds to `1000.0M` is promoted to billions.

The conversion contract is:

```text
123       -> 123
1,000     -> 1K
1,001     -> 2K
200,001   -> 201K
999,999       -> 1.0M
1,000,000     -> 1.0M
2,000,001     -> 2.1M
999,999,999   -> 1.0B
1,000,000,000 -> 1.0B
1,000,000,001 -> 1.1B
```

`Cost%`, `Hit%`, `Cost`, and `Saved` data values contain no `%` or `$` symbol. `Cost%` and `Hit%` retain one decimal place. `Cost` and `Saved` use at most seven visible characters, retain up to four fractional digits, and reduce fractional precision as the integer part grows. The formatter selects the highest precision from four through zero that fits after standard rounding. For example, `1551.75686` becomes `1551.76`. If the rounded integer part cannot fit, the formatter selects `K`, `M`, or `B` by magnitude and uses the greatest fractional precision that keeps the complete value within seven characters. For example, `12345678` becomes `12.346M`.

For the visible range, session scope, and agent selection:

```text
Cost% = model row Cost / Total Cost × 100
```

A non-zero `Total` row displays `100.0`. A zero-cost total and its model rows display `0.0`. Exact unrounded shares determine descending model order before one-decimal rendering.

`Total` is the first row. `All agents` is the initial agent selection. `Current` is the initial session scope. An empty range or scope shows `No usage in selected range`. The pane-heading divider, footer divider, in-frame keyboard hints, complete bottom border, wide and narrow layouts, scrolling, and navigation remain part of the screen.

### 13. Code Structure

```text
pi-package/extensions/usage/
├── aggregation.ts
├── agent-pane.ts
├── config.ts
├── index.ts
├── recorder.ts
├── screen.ts
├── store.ts
└── table-pane.ts

pi-package/shared/
├── usage-events.ts
├── usage-read-broker.ts
└── tui/scroll-indicator.ts
```

Register `./extensions/usage/index.ts` after `main-agent-selection` and `run-subagent` in `pi-package/package.json`.

Documentation changes:

- update `docs/extensions/usage.md` with the complete source and session-family contract;
- update `docs/extensions/footer.md` to describe usage-store cost and disabled-usage behavior;
- document the approved auxiliary attribution boundary where relevant.

### 14. Verification

Use RED-GREEN-REFACTOR for each behavior slice.

Unit tests cover:

- strict configuration and default-enabled behavior;
- disabled and invalid configuration lifecycle;
- schema creation and repeated opening;
- two concurrent SQLite connections;
- root and child process ownership;
- regular turns and each of the ten auxiliary sources;
- all complete usage exposed by each auxiliary source's existing completion boundary;
- final native compaction aggregates without custom-compaction duplication and final native branch-summary aggregates;
- repeated handling with one stable `eventId` and distinct IDs for distinct requests;
- root-session-family propagation through direct and nested subagents;
- reserved no-agent attribution and incomplete-event omission;
- metric and tiered-pricing calculations;
- retention deletion and root-only cleanup;
- cleanup start, success, and unsanitized failure notifications;
- five-range filtering with default `7d`;
- default Current and alternate All session scopes;
- cost-share aggregation, descending model sorting, tie-breaking, and totals;
- `/usage`, autocomplete, confirmed reset, and cancelled reset;
- wide and narrow TUI rendering, focus, scrolling, empty state, and disposal;
- footer current-session-family cost without session scanning and one warning for every unavailable-usage state.

Integration checks verify one `/usage` registration, standalone usage-extension loading, and whole-package loading.

Tests use isolated temporary directories and databases. They do not read real user sessions, databases, credentials, models, network resources, or git state.

## Overengineering and Overspecification Considerations

- SQLite is both the append store and query index; no second cache or indexer is added.
- No conversation-session scanning, legacy import, or database migration is performed.
- No timer, watcher, scheduler, maintenance table, or child cleanup is added for retention. The only timer refreshes the informational footer total every 10 seconds.
- Retention matches the longest supported range.
- No provider API, billing integration, or pricing history is added.
- One shared auxiliary publication boundary replaces source-specific and footer-specific cost persistence.
- The configuration contains only `enabled`.

## Open Questions

None.

## References

- `docs/specs/features/agent-usage-history/agent-usage-history_problem.md` - approved problem and Domain Glossary.
- `docs/specs/features/agent-usage-history/agent-usage-history_prd.md` - approved requirements.
- `pi-package/shared/agent-runtime-composition.ts` - main-agent identity and cross-extension event-bus pattern.
- `pi-package/shared/child-agent-environment.ts` - root and child process distinction.
- `pi-package/shared/usage-read-broker.ts` - process-local root-family cost query contract.
- `pi-package/extensions/run-subagent/management-screen/screen.ts` - full-screen TUI behavior.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` - command, UI, lifecycle, and assistant-event contracts.
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts` - usage and model pricing contracts.
- `node_modules/@earendil-works/pi-coding-agent/package.json` - Node `>=22.19.0` runtime requirement.
