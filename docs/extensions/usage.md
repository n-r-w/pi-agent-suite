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

`Tokens`, `Read`, and `Write` use one `/usage` display format:

- below 1,000: integer without a suffix;
- from 1,000: `K`, no fractional digit, rounded upward;
- from 1,000,000: `M`, exactly one fractional digit, rounded upward to one tenth;
- a result that would render as `1000K` is promoted to millions.

The exact boundary examples are `123` → `123`, `1,000` → `1K`, `1,001` → `2K`, `200,001` → `201K`, `999,999` → `1.0M`, `1,000,000` → `1.0M`, and `2,000,001` → `2.1M`.

Data values under `Hit%`, `Cost`, and `Saved` do not include `%` or `$`. `Hit%` uses one decimal place. `Cost` and `Saved` use four decimal places.

## Historical usage screen

Run `/usage` without arguments to open a snapshot. The extension reads the database once when the screen opens. The snapshot does not update while the screen remains open.

The available rolling ranges are `24h`, `7d`, `30d`, and `90d`. `24h` is selected initially.

The agent list begins with `All agents`. Other entries are stable agent IDs that have consumption in the selected range. Selecting an agent limits the table to that agent.

Wide terminals show the agent list and model table together. Narrow terminals show the agent list first. Press `Enter` to open the table and `Escape` to return to the list.

The Model column is at least 24 terminal columns wide and expands to the longest complete provider/model label. The header, `Total`, short-model rows, and long-model rows use the same visible Model-column width. Each numeric column therefore starts at one terminal column, and horizontal scrolling preserves access to complete labels.

Inactive `Range` and `Agents` titles use the theme `accent` color. The active title uses `borderAccent` instead. All seven table headers change together from `accent` to `borderAccent` when the table becomes active. Data-row labels and numeric values keep the normal text color. Exactly one focus zone is active.

The selected agent has no dot marker. Its full clipped and padded row uses `selectedBg` while Agents has focus and `toolPendingBg` while another zone has focus. Unselected rows have no selected background.

Agents vertical scrolling and table vertical and horizontal scrolling use `muted` track cells. A thumb uses `border` when its pane has focus and `borderMuted` when its pane is inactive. Range focus makes both pane thumbs inactive.

The screen keeps pane-heading and footer dividers, in-frame keyboard hints, a complete bottom border, and the same presentation in wide and narrow layouts.

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
