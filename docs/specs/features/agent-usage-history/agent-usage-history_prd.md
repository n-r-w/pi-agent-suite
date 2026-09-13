# Idea: Historical Agent Usage

## Definitions

Terms are defined in `docs/specs/features/agent-usage-history/agent-usage-history_problem.md` under `Domain Glossary`.

## Context and Problem

Pi Agent Suite does not independently record or present historical consumption across main agents and subagents. The problem is defined in `docs/specs/features/agent-usage-history/agent-usage-history_problem.md`.

## Goal

Give users a local historical view of independently recorded consumption by agent and model, including processed tokens, cache use, estimated cost, and cache savings.

## Scenarios

- A user opens `/usage` and sees consumption for all agents during the past 24 hours.
- A user changes the time range.
- A user selects a main agent or subagent.
- A user views a total and a model breakdown.
- A user operates the screen in a wide or narrow terminal.
- A user sees a clear empty state when the selected range has no usage.
- A user resets all recorded usage after explicit confirmation.

## Scope and Non-Scope

In scope:

- an independent local usage store;
- main agents and subagents;
- regular and auxiliary model requests recorded with complete attribution and usage data;
- `24h`, `7d`, `30d`, and `90d` ranges;
- aggregation by `agentId` and `provider/model`.

Not in scope:

- importing model requests made before the usage store recorded them;
- requests with missing attribution or usage data, including requests made without a selected agent;
- provider usage API requests;
- provider invoices and subscription limits;
- custom date ranges;
- updates while `/usage` remains open;
- partial reset by agent, model, provider, or time range.

## Requirements

### Functional Requirements

- **FRQ-01:** The `/usage` command opens a dedicated full-screen TUI.
  - Origin: `source` — direct user request.
  - Goal: Make historical consumption accessible from Pi Agent Suite.
  - Goal achievement: Full. Users get a dedicated entry point for usage history.

- **FRQ-02:** `/usage` derives statistics only from the independent local usage store and does not scan Pi conversation sessions.
  - Origin: `source` — the user required storage independent of Pi sessions.
  - Goal: Show historical consumption without rescanning conversation history or calling a provider billing API.
  - Goal achievement: Full. One purpose-specific local store becomes the usage source.

- **FRQ-03:** `/usage` queries the usage store once each time it opens and does not update while it remains open.
  - Origin: `formulated` — approved after Q17 and retained for the independent store.
  - Goal: Provide a stable historical snapshot.
  - Goal achievement: Full. Values do not change while the user views them.

- **FRQ-04:** The screen supports rolling `24h`, `7d`, `30d`, and `90d` ranges and selects `24h` when it opens.
  - Origin: `formulated` — approved after Q11 and Q11.1.
  - Goal: Limit historical statistics to a clear period.
  - Goal achievement: Full. Users can switch between the four agreed ranges.

- **FRQ-05:** In wide mode, the range selector is at the top, the agent list is on the left, and the selected agent table is on the right.
  - Origin: `source` — user description and mockup.
  - Goal: Support agent selection and inspection on one screen.
  - Goal achievement: Full. The main historical usage scenario is available in one view.

- **FRQ-06:** In narrow mode, the screen shows the agent list first; `Enter` opens the selected agent table, and `Escape` returns to the list.
  - Origin: `formulated` — approved after Q19.
  - Goal: Keep all data accessible at limited width.
  - Goal achievement: Full. Both areas remain readable without simultaneous placement.

- **FRQ-07:** The agent list starts with `All agents`, selected by default. Other items are stable main-agent and subagent `agentId` values with consumption in the selected range.
  - Origin: `formulated` — approved after Q3, Q4, Q12, and Q15.
  - Goal: Support system-wide and per-agent analysis.
  - Goal achievement: Full. Users can move from the aggregate to one agent.

- **FRQ-08:** Agent items after `All agents` are sorted by `agentId`.
  - Origin: `formulated` — approved after Q14.
  - Goal: Provide stable agent ordering.
  - Goal achievement: Partial. Stable ordering improves discovery but does not create usage metrics.

- **FRQ-09:** Agent consumption includes regular responses and auxiliary model requests initiated by that agent.
  - Origin: `formulated` — approved after Q5.
  - Goal: Include consumption caused by auxiliary operations.
  - Goal achievement: Full. The result includes all agreed model requests attributable to an agent.

- **FRQ-10:** The table starts with a `Total` row, followed by rows grouped and sorted by the actual `provider/model` pair.
  - Origin: `formulated` — approved after Q9, Q13, and Q14.
  - Goal: Show the aggregate and each model's contribution.
  - Goal achievement: Full. Users can inspect a total and its model breakdown.

- **FRQ-11:** The table uses the columns `Model | Tokens | Read | Write | Hit% | Cost | Saved`.
  - Origin: `source` — initial mockup; compact labels approved after Q20 and Q20.1.
  - Goal: Show the agreed metrics within limited TUI width.
  - Goal achievement: Full. All primary metrics are available in one table.

- **FRQ-12:** `Tokens` equals the sum of `input + output + cacheRead + cacheWrite` across all included requests.
  - Origin: `formulated` — approved after Q7.
  - Goal: Show the complete processed token volume.
  - Goal achievement: Full. Cached and uncached categories are counted once.

- **FRQ-13:** `Hit%` equals `cacheRead / (input + cacheRead + cacheWrite) × 100%`.
  - Origin: `formulated` — approved after Q20.
  - Goal: Show the share of input obtained from cache.
  - Goal achievement: Partial. The ratio complements the absolute `Read` and `Write` metrics.

- **FRQ-14:** `Cost` shows the persisted `usage.cost.total` without visually distinguishing subscription and API sessions.
  - Origin: `formulated` — approved after Q8 and Q27.
  - Goal: Provide one comparable monetary measure without reconstructing historical prices.
  - Goal achievement: Full. Consumption across models is comparable through Pi's persisted cost estimate.

- **FRQ-15:** `Saved` shows the non-negative cache-read savings estimate calculated from available model pricing.
  - Origin: `formulated` — approved after Q6.1 and Q27.
  - Goal: Show the monetary benefit of cache hits without historical price reconstruction.
  - Goal achievement: Partial. The metric explains cache benefit but does not represent provider billing.

- **FRQ-16:** The model table applies this display contract:
  - `Tokens`, `Read`, and `Write` values below 1,000 are integers without a suffix. Values from 1,000 use `K`, have no fractional digit, and round upward. Values from 1,000,000 use `M`, have exactly one fractional digit, and round upward to one tenth. A thousands result that rounds to `1000K` is promoted to millions. The required conversions are `123` → `123`, `1,000` → `1K`, `1,001` → `2K`, `200,001` → `201K`, `999,999` → `1.0M`, `1,000,000` → `1.0M`, and `2,000,001` → `2.1M`.
  - `Hit%`, `Cost`, and `Saved` data values do not contain `%` or `$`; the `Hit%` header carries the percentage unit.
  - The Model column is at least 24 terminal columns wide and expands to the longest complete provider/model label. The header, `Total`, and every model row use this one visible width, so all numeric columns start at the same terminal columns. Horizontal scrolling preserves access to complete labels.
  - Inactive `Range` and `Agents` titles and all seven inactive table headers use `accent`. The title or complete header group for the one zone activated through `Tab` uses `borderAccent` instead of `accent`. Data-row labels and numeric values keep the normal text color.
  - The selected agent row has no dot marker. Its complete clipped and padded row uses `selectedBg` while Agents has focus and `toolPendingBg` while Range or the table has focus. Unselected agent rows have no selected background.
  - Agents vertical scrolling and table vertical and horizontal scrolling use `muted` for track cells. A thumb uses `border` while its pane has focus and `borderMuted` while another zone has focus. When Range has focus, both pane thumbs use `borderMuted`.
  - Origin: `source` — direct user approval of the final number, alignment, and color presentation.
  - Goal: Present historical usage with predictable compact numbers, aligned columns, and visible focus.
  - Goal achievement: Full. The table and focus zones use the complete approved display contract.

- **FRQ-17:** When the selected range has no consumption, the screen shows `No usage in selected range` and does not select another range automatically.
  - Origin: `formulated` — approved after Q21.
  - Goal: Present an unambiguous empty result.
  - Goal achievement: Full. Users understand the state and can select another range.

- **FRQ-18:** The screen has focus zones for the range selector, agent list, and model table. `Tab` and `Shift+Tab` change zones, arrow keys operate the focused zone, `PageUp` and `PageDown` scroll the table, and `Escape` performs the agreed navigation or closes the screen.
  - Origin: `formulated` — approved after Q18 and Q19.
  - Goal: Preserve interaction consistency with `/subagents`.
  - Goal achievement: Full. Every area is keyboard-accessible through a familiar interaction model.

- **FRQ-19:** A model request is persisted and included only when `agentId`, timestamp, `provider`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`, and `usage.cost.total` are available, and when model pricing needed for `Saved` is available. Otherwise, the complete request is ignored. This rule excludes requests made without a selected agent.
  - Origin: `formulated` — approved after Q24, Q25, and Q27, then clarified by the user for all missing data.
  - Goal: Include only complete events without presenting synthetic values.
  - Goal achievement: Full. Every included event supports all agreed dimensions and metrics.

- **FRQ-20:** The feature does not import prior Pi session history, infer missing data from current configuration, or create unknown-agent or unknown-model rows.
  - Origin: `source` — the user required missing prior data to be ignored and approved independent storage.
  - Goal: Prevent incorrect historical attribution and session rescanning.
  - Goal achievement: Full. Only complete events recorded by the usage extension enter statistics.

- **FRQ-21:** Usage storage resides under `{Pi agent dir}/agent-suite/usage/data/`, with `usage.sqlite` as the main database file and SQLite-owned auxiliary files in the same directory.
  - Origin: `source` — direct user requirement after Q31.
  - Goal: Keep database files separate from extension configuration.
  - Goal achievement: Full. All database-owned files have one dedicated data directory.

- **FRQ-22:** Configuration resides at `{Pi agent dir}/agent-suite/usage/config.json`, accepts only `{ "enabled": boolean }`, and defaults to enabled when the file is absent.
  - Origin: `source` — direct user requirement.
  - Goal: Control the extension consistently with other Pi Agent Suite extensions.
  - Goal achievement: Full. The extension has one closed configuration contract and is enabled by default.

- **FRQ-23:** `enabled: true` enables usage-event persistence and `/usage`; `enabled: false` disables both without deleting existing usage data.
  - Origin: `formulated` — approved as O32-1.
  - Goal: Give `enabled` one complete and predictable meaning.
  - Goal achievement: Full. Collection and presentation enter or leave service together while retained history stays intact.

- **FRQ-24:** Configuration is read once during extension loading and changes apply after Pi restarts. Unreadable, malformed, unsupported, or incorrectly typed configuration disables the extension and produces one error notification in an interactive session.
  - Origin: `formulated` — approved as O32-1 using existing extension configuration conventions.
  - Goal: Fail closed on invalid configuration without partial activation.
  - Goal achievement: Full. Invalid configuration cannot start only part of the feature.

- **FRQ-25:** `/usage` with no arguments opens the historical usage TUI. `/usage reset` requests confirmation and, after confirmation, removes all recorded usage while preserving `config.json` and the database schema. Cancellation leaves all data unchanged.
  - Origin: `source` — requested by the user and approved as O33-1.
  - Goal: Provide a safe complete reset without manual file operations.
  - Goal achievement: Full. Users can clear all statistics without deleting configuration or rebuilding storage.

- **FRQ-26:** Command autocomplete describes both `/usage` behaviors and suggests `reset` after `/usage ` or a matching argument prefix.
  - Origin: `formulated` — approved as O33-1 using Pi's command argument-completion contract.
  - Goal: Make the reset operation discoverable without adding another global command.
  - Goal achievement: Full. Users can discover the supported argument from the editor.

- **FRQ-27:** When the enabled extension starts in a user-launched root Pi process, it deletes usage events older than 90 days. Child subagent and council processes never start cleanup. Concurrent user-launched root processes may perform the same idempotent cleanup, and a cleanup failure does not disable usage recording.
  - Origin: `source` — direct user requirement.
  - Goal: Bound retained data to the longest supported range without making child agents perform maintenance.
  - Goal achievement: Full. Root startup cleanup bounds useful history without a timer, scheduler, maintenance table, or child cleanup work.

- **FRQ-28:** In an interactive user-launched root session, startup cleanup shows an information notification immediately before deletion and a terminal notification after the cleanup attempt. Success produces an information notification. Failure produces an error notification containing the database path, failed operation, and original unsanitized error details. A root session without UI performs cleanup without notifications.
  - Origin: `source` — direct user requirement.
  - Goal: Make root-owned startup cleanup and its failure source visible without requiring a maintenance screen.
  - Goal achievement: Full. Interactive users see both the start and outcome of root cleanup, including actionable failure details.

### Non-Functional Requirements

- **NRQ-01:** `/usage` follows the visual and navigation principles of `/subagents`.
  - Origin: `source` — the user named `/subagents` as the reference.
  - Goal: Keep Pi Agent Suite TUI behavior consistent.
  - Goal achievement: Full. The screen does not introduce an independent interaction model.

- **NRQ-02:** Building usage statistics does not call models or external services.
  - Origin: `source` — local history is the selected data source.
  - Goal: Keep analysis local and avoid new model consumption.
  - Goal achievement: Full. Opening `/usage` does not create additional model cost.

## Open Questions

None.

## References

- `docs/specs/features/agent-usage-history/agent-usage-history_problem.md`
- `docs/extensions/footer.md`
- `docs/extensions/run-subagent.md`
