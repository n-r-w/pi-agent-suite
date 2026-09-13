# usage

## Purpose

`usage` records complete local model-usage events independently of Pi conversation sessions. The `/usage` command shows historical consumption by agent and provider/model.

The extension does not import older sessions, call provider usage APIs, or represent provider invoices and subscription limits.

## Configuration

Default file: `~/.pi/agent/agent-suite/usage/config.json`.

The extension is enabled when the file is missing. The complete configuration is:

```json
{
  "enabled": true
}
```

A present file must contain `enabled` with a boolean value, and no other field is accepted. An unreadable file, invalid JSON, missing `enabled`, unsupported field, or invalid value disables recording and `/usage`. An interactive session reports the configuration error once.

Configuration is read once per Pi process. Restart Pi to apply a change. Setting `enabled` to `false` does not delete existing usage data.

## Storage

The extension stores data under:

```text
~/.pi/agent/agent-suite/usage/data/
├── usage.sqlite
├── usage.sqlite-wal
└── usage.sqlite-shm
```

SQLite creates and removes the WAL and shared-memory files as needed. The database supports concurrent Pi root and subagent processes.

A request is stored only when these values are complete and valid:

- active session ID and stable `agentId`;
- timestamp, provider, and model;
- non-negative safe-integer `input`, `output`, `cacheRead`, and `cacheWrite` values;
- non-negative finite estimated total cost;
- current pricing metadata for the recorded provider/model.

An incomplete request is ignored as one unit. Missing values are not inferred, and previous Pi sessions are not scanned.

## Included requests

Agent consumption includes regular assistant responses and these auxiliary request sources:

- `consult-advisor`;
- `context-projection`;
- `convene-council`;
- `custom-compaction`;
- `subagent-query`.

The initiating agent owns an auxiliary request. Requests from `ask-llm`, `vision`, and internal `knowledge` operations are not included.

Repeated delivery of one event ID is idempotent. Distinct requests receive distinct IDs.

## Metrics

The model table contains:

| Column | Meaning |
| --- | --- |
| `Model` | The actual `provider/model` pair. |
| `Tokens` | `input + output + cacheRead + cacheWrite`. |
| `Read` | Tokens read from the provider cache. |
| `Write` | Tokens written to the provider cache. |
| `Hit%` | `cacheRead / (input + cacheRead + cacheWrite) * 100`. A zero denominator produces `0%`. |
| `Cost` | Pi's persisted estimated API-price total. |
| `Saved` | Non-negative estimated savings from charging cache reads below the ordinary input rate. |

`Total` is the first row. Other rows are sorted by provider/model. `Cost` and `Saved` are estimates, not billing records.

## Historical usage screen

Run `/usage` without arguments to open a snapshot. The extension reads the database once when the screen opens. The snapshot does not update while the screen remains open.

The available rolling ranges are `24h`, `7d`, `30d`, and `90d`. `24h` is selected initially.

The agent list begins with `All agents`. Other entries are stable agent IDs that have consumption in the selected range. Selecting an agent limits the table to that agent.

Wide terminals show the agent list and model table together. Narrow terminals show the agent list first. Press `Enter` to open the table and `Escape` to return to the list.

Keyboard controls:

- `Tab` and `Shift+Tab` change the focused range, agents, or table zone.
- Arrow keys operate the focused zone.
- `PageUp` and `PageDown` scroll the table.
- Left and Right scroll a focused table horizontally.
- `Escape` returns from the narrow table or closes the screen.

An empty range shows `No usage in selected range` and keeps the selected range.

## Reset

Run `/usage reset` to request confirmation before deleting all recorded events. Cancellation makes no change.

A confirmed reset preserves `config.json`, the SQLite files, schema, and indexes. Events committed by another process after the reset transaction remain available.

## Retention and diagnostics

An enabled user-launched root Pi process deletes events older than 90 days during its first `session_start`. The cleanup runs once per process. Child processes do not run cleanup.

An interactive root session reports cleanup start and completion. A cleanup failure reports the database path, failed operation, and original error details. Cleanup and insertion failures do not fail a completed model response. Runtime diagnostics retain persistence failures when diagnostics are enabled.
