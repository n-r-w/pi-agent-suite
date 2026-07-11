# run-subagent

## Purpose

`run-subagent` adds the `run_subagent` tool. The tool lets the active agent delegate a task to a configured callable agent.

## Configuration file

Default file: `~/.pi/agent/agent-suite/run-subagent/config.json`.

If the file is missing, the extension is enabled with default settings.

## Full configuration example

```json
{
  "enabled": true,
  "maxDepth": 1,
  "widgetLineBudget": 7,
  "descriptionPromptFile": "/absolute/path/to/run-subagent-description.md"
}
```

## Parameters

| Name | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables or disables `run_subagent`. Set to `false` to prevent tool registration. |
| `maxDepth` | No | Integer greater than or equal to `0` | `1` | Limits nested subagent calls. `0` prevents this extension from exposing `run_subagent` in the active tool list. |
| `widgetLineBudget` | No | Integer greater than or equal to `1` | `7` | Limits the live widget to this many content lines, including its header, agent rows, and omission summaries. The separator above the widget is not counted. |
| `descriptionPromptFile` | No | Non-empty absolute file path string | Bundled tool description | Replaces the `run_subagent` tool description with the trimmed contents of the file. The file must be readable and must not be empty after trimming whitespace. |

The config object accepts only these keys: `enabled`, `maxDepth`, `widgetLineBudget`, and `descriptionPromptFile`.

## Live progress

Interactive TUI mode sends one initial partial update to populate the historical call with the resolved model and thinking level. Later live progress appears only in the widget and focused browser. RPC and other non-TUI modes keep every intermediate tool update for nested progress propagation.

The header counts every direct and nested run. It also shows the number of concrete displayed runs, total recorded runs, and the `Ctrl+Shift+G` browser shortcut.

### Automatic view

The automatic body follows these rules:

- Failed and aborted work is selected before running work.
- Running work is selected before completed work.
- Runs within one status class are ordered by their latest update time.
- A nested run is shown only with its complete visible ancestor path.
- A parent with only hidden descendants shows their aggregate on the parent row.
- A partially visible branch ends with a local omission summary.
- Hidden root branches keep a root-level summary when the line budget permits it or attention-bearing work is hidden.
- Completed runs use remaining rows after failed, aborted, and running work.
- With `widgetLineBudget` set to `1`, only the aggregate header fits.

Connectors are derived after the visible tree is selected. A visible descendant therefore cannot retain a connector to a hidden parent or sibling.

### Selected-run view

Selecting a run in the browser switches the widget from the aggregate overview to that run. Selection uses the internal `runId` and remains stable while other runs start or finish.

A root run uses one header row:

```text
Root: YandexExtractor · Delegate identity checks · openai-codex/gpt-5.6-luna/low · 18k/372k · 85.3s
```

When the line budget permits a second row, a nested run shows its direct parent and root-relative depth:

```text
Child: YandexExtractor · Delegate identity checks · openai-codex/gpt-5.6-luna/low · 18k/372k · 85.3s
Parent: SubAgentExtractor · Delegate catalog checks · Depth 1
```

The remaining `widgetLineBudget` rows show the latest retained tool events in chronological order. `tool_call`, `tool_result`, and tool execution `error` events each use one row. Assistant output and assistant failures are excluded. Rows do not wrap and are clipped to terminal width. The selected-run view does not scroll.

Select `Automatic view` in the browser to resume aggregate selection. Starting a new Pi session clears the selected run and instance numbering.

### Browser

Open the complete run list with either:

- `/subagents`
- `Ctrl+Shift+G`

The browser uses Pi `SelectList` behavior:

- `Up` and `Down` navigate and scroll through every recorded root and nested run.
- `Enter` shows the selected run in the widget or applies `Automatic view`.
- `Escape` or `Ctrl+C` closes the browser without changing the current mode.

Browser labels append `Root` for root runs or root-relative `Depth N` for nested runs. Nested descriptions also name the direct parent. The browser preserves selection by `runId` while live status, elapsed time, context usage, and activity descriptions change.

### Run identity and row content

Each run receives a stable instance number per agent type in the current session. The visible identity combines the shortened agent type, instance number, and required `taskName`, for example `Sage #2 · Review widget navigation`. `runId` remains internal.

Each overview agent row uses one visual terminal line:

- Elapsed time uses milliseconds below one second, then seconds, `m:ss`, or `h:mm:ss`.
- Context usage shows rounded whole-thousand token counts such as `190k/372k`; unknown overflow usage uses `~/372k`.
- Projection savings remain first and use the same rounding, for example `~20k/190k/372k`. Context pressure colors still use the unrounded usage percentage.
- Tool activity shows the most recent tool name followed by its serialized call arguments, even when a later assistant event completes the run. Captured argument text is limited to 240 UTF-16 code units and 240 terminal columns, then clipped to the remaining row width with `…`. Tool result payloads are not shown in overview rows; failures and empty searches use compact outcome labels. Terminal control sequences and standalone C0/C1 controls are removed. Terminal line whitespace is folded without rewriting other Unicode content.

When a mixed omission summary does not fit in verbose form, it uses status icons while preserving every non-zero count. For example, `3 nested: 1 running · 1 failed · 1 done` becomes `3 nested: ⏳1 ✗1 ✓1`.

Rows are clipped by terminal display width after grapheme-aware plain-text selection and before theme colors are applied. This preserves composed Unicode characters and prevents ANSI reset sequences from leaking into the parent widget style.

## Historical tool rendering

The collapsed `run_subagent` call shows `Name` from `taskName` and a wrapped `Task` preview from `prompt`, without progress rows. After execution resolves the child runtime, one partial update adds the model and thinking level to the header. The header then remains static until the final result adds context usage and elapsed time. Expanding an active call shows the complete task prompt. Expanding a completed call also shows only the final answer, failure, or abort result; it does not show the intermediate event timeline or a separate stderr section.

## Child session logs

Each `run_subagent` call starts child `pi` with a saved JSONL session.

Child sessions are stored outside the normal project session list:

```text
~/.pi/agent/agent-suite/run-subagent/sessions/
```

If `PI_AGENT_SUITE_DIR` is set, the same `run-subagent/sessions/` path is created under that suite directory.

The tool result `details` includes:

| Field | Meaning |
| --- | --- |
| `childSessionId` | Pi-compatible UUIDv7 assigned to the child session. |
| `childSessionDir` | Directory passed to child `pi` through `--session-dir`. |
| `childSessionPath` | JSONL session file path when the file is found after child exit. |

## Tool input

When the tool is available, a model calls `run_subagent` with:

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `agentId` | Yes | String | Callable agent ID to run. |
| `taskName` | Yes | String with 3–60 characters | Unique 2–6 word action-and-object name for this task. Concurrent calls use distinct names based on task focus. |
| `prompt` | Yes | String | Full task prompt for the selected subagent. |
