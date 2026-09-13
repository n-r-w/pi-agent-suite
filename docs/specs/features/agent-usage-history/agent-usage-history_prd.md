# Idea: Historical Agent Usage

## Definitions

Terms are defined in `docs/specs/features/agent-usage-history/agent-usage-history_problem.md` under `Domain Glossary`.

## Context and Problem

Pi Agent Suite does not independently record or present historical consumption across main agents and subagents. The problem is defined in `docs/specs/features/agent-usage-history/agent-usage-history_problem.md`.

## Goal

Give users a local historical view of independently recorded consumption by agent and model, including processed tokens, cache use, estimated cost, and cache savings.

## Scenarios

- A user opens `/usage` and sees consumption for the current root session family during the past 7 days.
- A user changes the time range, including a 1-hour view.
- A user switches between the current root session family and all recorded sessions.
- A user selects a main agent, subagent, or the `No agent` group.
- A user views a total, cost share, and model breakdown ordered by descending cost share.
- A user operates the screen in a wide or narrow terminal.
- A user sees a clear empty state when the selected range has no usage.
- A user resets all recorded usage after explicit confirmation.

## Scope and Non-Scope

In scope:

- an independent local usage store;
- main agents and subagents;
- regular model requests and all identified auxiliary model-request sources recorded with complete usage data;
- current-root-session-family and all-session filtering;
- a reserved `No agent` group for complete requests without an `agentId`;
- `1h`, `24h`, `7d`, `30d`, and `90d` ranges;
- aggregation by agent identity and `provider/model`.

Not in scope:

- importing model requests made before the usage store recorded them;
- requests with missing usage or model data;
- migrating an existing usage database to the changed schema;
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

- **FRQ-04:** The screen supports rolling `1h`, `24h`, `7d`, `30d`, and `90d` ranges in that order and selects `7d` when it opens.
  - Origin: `source` — direct user correction of the range set and default.
  - Goal: Limit historical statistics to a clear period.
  - Goal achievement: Full. Users can switch between five agreed ranges and start with the approved 7-day view.

- **FRQ-05:** In wide mode, the range and session selectors are at the top, the agent list is on the left, and the selected agent table is on the right.
  - Origin: `source` — user description and mockups.
  - Goal: Support session scope, agent selection, and inspection on one screen.
  - Goal achievement: Full. The main historical usage scenario is available in one view.

- **FRQ-06:** In narrow mode, the screen shows the agent list first; `Enter` opens the selected agent table, and `Escape` returns to the list.
  - Origin: `formulated` — approved after Q19.
  - Goal: Keep all data accessible at limited width.
  - Goal achievement: Full. Both areas remain readable without simultaneous placement.

- **FRQ-07:** The agent list starts with `All agents`, selected by default. Other items are stable main-agent and subagent `agentId` values with consumption in the selected range and session scope. Complete requests without an `agentId` appear as `No agent`.
  - Origin: `source` — direct user approval of the aggregate, agent groups, and no-agent label.
  - Goal: Support system-wide, per-agent, and unattributed-cost analysis.
  - Goal achievement: Full. Users can move from the aggregate to one agent or the explicit no-agent group.

- **FRQ-08:** Agent items after `All agents` are sorted by `agentId`.
  - Origin: `formulated` — approved after Q14.
  - Goal: Provide stable agent ordering.
  - Goal achievement: Partial. Stable ordering improves discovery but does not create usage metrics.

- **FRQ-09:** Consumption includes regular responses and every auxiliary model-request source listed in FRQ-30. An auxiliary request belongs to the initiating agent when an `agentId` is available and to `No agent` otherwise.
  - Origin: `source` — direct user requirement to include all incidental model costs.
  - Goal: Include consumption caused by regular and auxiliary operations.
  - Goal achievement: Full. The result includes every identified local model-request path with complete usage data.

- **FRQ-10:** The table starts with a `Total` row, followed by rows grouped by the actual `provider/model` pair and sorted by exact unrounded `Cost%` descending. Equal values use `provider/model` ascending as the tie-breaker.
  - Origin: `source` — direct user requirement and approved tie-breaker.
  - Goal: Show the aggregate and put the most expensive models first.
  - Goal achievement: Full. Users can inspect a total and its model breakdown in descending cost-share order.

- **FRQ-11:** The table uses the columns `Model | Cost% | Tokens | CacheR | CacheW | Hit% | Cost | Saved`.
  - Origin: `source` — direct user corrections for cost share and explicit cache labels.
  - Goal: Show the agreed metrics within limited TUI width without ambiguous cache columns.
  - Goal achievement: Full. All primary metrics and model cost share are available in one table.

- **FRQ-12:** `Tokens` equals the sum of `input + output + cacheRead + cacheWrite` across all included requests.
  - Origin: `formulated` — approved after Q7.
  - Goal: Show the complete processed token volume.
  - Goal achievement: Full. Cached and uncached categories are counted once.

- **FRQ-13:** `CacheR` equals `cacheRead`, `CacheW` equals `cacheWrite`, and `Hit%` equals `cacheRead / (input + cacheRead + cacheWrite) × 100%`.
  - Origin: `source` — the cache-hit formula was approved earlier, and the user directly renamed the absolute cache columns.
  - Goal: Show the absolute cache activity and the share of input obtained from cache.
  - Goal achievement: Full. Explicit labels distinguish cache reads from cache writes.

- **FRQ-14:** `Cost` shows the persisted `usage.cost.total` without visually distinguishing subscription and API sessions.
  - Origin: `formulated` — approved after Q8 and Q27.
  - Goal: Provide one comparable monetary measure without reconstructing historical prices.
  - Goal achievement: Full. Consumption across models is comparable through Pi's persisted cost estimate.

- **FRQ-15:** `Saved` shows the non-negative cache-read savings estimate calculated from available model pricing.
  - Origin: `formulated` — approved after Q6.1 and Q27.
  - Goal: Show the monetary benefit of cache hits without historical price reconstruction.
  - Goal achievement: Partial. The metric explains cache benefit but does not represent provider billing.

- **FRQ-16:** The model table applies this display contract:
  - `Tokens`, `CacheR`, and `CacheW` values below 1,000 are integers without a suffix. Values from 1,000 use `K`, have no fractional digit, and round upward. Values from 1,000,000 use `M`, have exactly one fractional digit, and round upward to one tenth. Values from 1,000,000,000 use `B`, have exactly one fractional digit, and round upward to one tenth. A rounded `1000K` result is promoted to `M`, and a rounded `1000.0M` result is promoted to `B`. The required conversions are `123` → `123`, `1,000` → `1K`, `1,001` → `2K`, `200,001` → `201K`, `999,999` → `1.0M`, `1,000,000` → `1.0M`, `2,000,001` → `2.1M`, `999,999,999` → `1.0B`, `1,000,000,000` → `1.0B`, and `1,000,000,001` → `1.1B`.
  - `Cost%` and `Hit%` retain one decimal place. `Cost%`, `Hit%`, `Cost`, and `Saved` data values do not contain `%` or `$`; the percentage headers carry the units. `Cost` and `Saved` each use at most seven visible characters. They retain up to four fractional digits and reduce fractional precision as the integer part grows. For example, `1551.75686` displays as `1551.76`. When the rounded integer part alone would exceed seven characters, the value uses a `K`, `M`, or `B` suffix and the greatest fractional precision that fits; for example, `12345678` displays as `12.346M`.
  - The Model column is at least 24 terminal columns wide and expands to the longest complete provider/model label. The header, `Total`, and every model row use this one visible width, so all numeric columns start at the same terminal columns. Horizontal scrolling preserves access to complete labels.
  - Inactive `Range`, `Sessions`, and `Agents` titles and all eight inactive table headers use `accent`. The title or complete header group for the one zone activated through `Tab` uses `borderAccent` instead of `accent`. Data-row labels and numeric values keep the normal text color.
  - The selected agent row has no dot marker. Its complete clipped and padded row uses `selectedBg` while Agents has focus and `toolPendingBg` while another zone has focus. Unselected agent rows have no selected background.
  - Agents vertical scrolling and table vertical and horizontal scrolling use `muted` for track cells. A thumb uses `border` while its pane has focus and `borderMuted` while another zone has focus. When Range or Sessions has focus, both pane thumbs use `borderMuted`.
  - Origin: `source` — direct user approval of the final number, alignment, and color presentation.
  - Goal: Present historical usage with predictable compact numbers, aligned columns, and visible focus.
  - Goal achievement: Full. The table and focus zones use the complete approved display contract.

- **FRQ-17:** When the selected range has no consumption, the screen shows `No usage in selected range` and does not select another range automatically.
  - Origin: `formulated` — approved after Q21.
  - Goal: Present an unambiguous empty result.
  - Goal achievement: Full. Users understand the state and can select another range.

- **FRQ-18:** The screen has focus zones for the range selector, session selector, agent list, and model table. `Tab` and `Shift+Tab` change zones, arrow keys operate the focused zone, `PageUp` and `PageDown` scroll the table, and `Escape` performs the agreed navigation or closes the screen.
  - Origin: `source` — direct user requirements for session filtering and `/subagents` consistency.
  - Goal: Preserve interaction consistency with `/subagents`.
  - Goal achievement: Full. Every area is keyboard-accessible through a familiar interaction model.

- **FRQ-19:** A model request is persisted and included only when root-session identity, timestamp, `provider`, `model`, `input`, `output`, `cacheRead`, `cacheWrite`, and `usage.cost.total` are available, and when model pricing needed for `Saved` is available. A missing `agentId` uses the reserved no-agent identity. Other missing required data causes the complete request to be ignored.
  - Origin: `source` — direct user requirement for complete costs and the approved `No agent` group.
  - Goal: Include complete events without losing costs solely because no agent is selected.
  - Goal achievement: Full. Every included event supports the agreed session, model, token, and cost dimensions.

- **FRQ-20:** The feature does not import prior Pi session history, infer missing model or root-session data, or create unknown-model rows. Missing agent identity is represented only by the explicit `No agent` group.
  - Origin: `source` — direct user requirements for no history import and explicit no-agent costs.
  - Goal: Prevent incorrect historical attribution while retaining complete unattributed costs.
  - Goal achievement: Full. Only newly recorded complete events enter statistics.

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

- **FRQ-29:** The top selector displays `Sessions: [Current] All` when the screen opens. `Current` includes the active root Pi session, every direct or nested subagent session launched under that root session, and all included auxiliary requests initiated by that session family. `All` includes every recorded event.
  - Origin: `source` — direct user definition and approved default.
  - Goal: Separate current-work consumption from historical consumption.
  - Goal achievement: Full. Users can inspect one complete root session family or all sessions.

- **FRQ-30:** The complete source set is regular agent turns plus `consult-advisor`, `context-projection`, `convene-council`, `custom-compaction`, `subagent-query`, `ask-llm`, `vision`, `knowledge`, `native-compaction`, and `branch-summary`. Source boundaries record complete observable usage without adding attempt-tracking infrastructure. Native compaction and branch summary use the final aggregate usage exposed by Pi.
  - Origin: `source` — direct user requirement to include all identified incidental model costs without billing-system complexity.
  - Goal: Cover every available local model-consumption source.
  - Goal achievement: Full within the runtime data Pi exposes. Unobservable intermediate attempts are outside the feature boundary.

- **FRQ-31:** Each event stores the active root Pi session identity separately from its own Pi `sessionId`. Root events use the current main-session ID. Direct and nested subagent processes receive and preserve the same root-session identity.
  - Origin: `formulated` — required by the user's definition of `Current` across process-local sessions.
  - Goal: Group a main session, descendants, and auxiliary requests without scanning conversation sessions.
  - Goal achievement: Full. Session-family filtering uses persisted event attribution.

- **FRQ-32:** `Cost%` equals model-row `Cost / Total Cost × 100` for the visible range, session scope, and agent selection. A non-zero `Total` row displays `100.0`; a zero-cost total and its model rows display `0.0`.
  - Origin: `source` — direct user requirement and approved current-table denominator.
  - Goal: Show each model's share of visible cost.
  - Goal achievement: Full. The model breakdown explains the complete visible total.

- **FRQ-33:** The database schema is changed directly without migrations, schema compatibility branches, or application schema-version metadata. The user removes the old database before using the changed implementation.
  - Origin: `source` — direct user instruction to omit migration and compatibility machinery.
  - Goal: Apply the new event contract directly.
  - Goal achievement: Full. New databases use the required schema directly.

- **FRQ-34:** The main footer obtains API cost and processed tokens only from the usage store for the active root session family. Processed tokens equal `input + output + cacheRead + cacheWrite`. Auxiliary requests publish complete usage without creating cost-only session entries. One root-only timer refreshes both cached totals with one indexed aggregate every 10 seconds while the footer is active; footer rendering reads only the cached values. The footer shows cost as `$0.086` without a subscription marker. Footer configuration provides independent `showApiCost` and `showApiTokens` booleans that both default to `true`; tokens use the FRQ-16 format prefixed with `T`. When either field is enabled, the first unavailable usage read hides both enabled segments and emits one warning in the interactive root session. This applies during startup and later refreshes. The refresh timer continues after a later failure, and a later valid result restores the enabled segments. The warning is emitted even when the usage extension also reports its own startup error. No footer warning is emitted when the footer is disabled or both fields are disabled.
  - Origin: `source` — direct user decisions for complete footer usage, token visibility, and uniform cost presentation.
  - Goal: Give the footer and `/usage` one complete usage source without duplicate persistence.
  - Goal achievement: Full. Both views use the same regular, subagent, and auxiliary consumption for the current root session family, and unavailable complete usage is never presented as partial values.

- **FRQ-35:** The `/subagents` selected-session metadata row shows cumulative retained consumption for the selected child Pi `sessionId`. `Cost` is the sum of persisted `usage.cost.total`, and `Tokens` is the sum of `input + output + cacheRead + cacheWrite` across regular responses, continuations, and included auxiliary requests. The fields appear after `CH` when present and before context usage as `$2.12 · T1.2M`. Cost uses a dollar sign and two fractional digits. Tokens use the FRQ-16 compact token format prefixed with `T`. When the usage store is unavailable, both fields are omitted.
  - Origin: `source` — direct user request and approval of cumulative logical-session totals.
  - Goal: Show complete stored consumption for the selected subagent session without leaving `/subagents`.
  - Goal achievement: Full. The selected-session header exposes cumulative cost and processed tokens from the same store as `/usage`.

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
