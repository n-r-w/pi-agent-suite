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

## Live widget

The widget is a passive status view. It does not accept focus or provide branch expansion controls.

The header counts every direct and nested run. Body rows follow these rules:

- A nested run is shown only with its complete visible ancestor path.
- Running root branches are selected before descendant details.
- Running descendants are selected before completed descendants.
- Failed and aborted paths retain their ancestors when the path fits. Aggregate `failed` counts include aborted runs.
- Completed descendants and root branches use spare lines but do not displace running or failed paths.
- A parent with only hidden descendants shows their aggregate on the parent row.
- A partially visible branch ends with a local omission summary.
- Completed root branches use individual spare rows while all remaining root overflow still fits in one root-level summary. Hidden active or failed work always keeps the summary.
- After every root branch has its own row, completed descendants under newly visible completed roots use the remaining lines.
- A fully successful tree collapses to the aggregate header. Failed or aborted work remains visible as a path when it fits, otherwise through the required omission aggregate. With `widgetLineBudget` set to `1`, only aggregate header counts fit.

Connectors are derived after the visible tree is selected. A visible descendant therefore cannot retain a connector to a hidden parent or sibling.

Each agent row uses one visual terminal line:

- Elapsed time uses milliseconds below one second, then seconds, `m:ss`, or `h:mm:ss`.
- Context usage shows rounded whole-thousand token counts such as `190k/372k`; unknown overflow usage uses `~/372k`.
- Projection savings remain first and use the same rounding, for example `~20k/190k/372k`. Context pressure colors still use the unrounded usage percentage.
- Tool activity shows the tool name followed by its serialized call arguments. Captured argument text is limited to 240 UTF-16 code units and 240 terminal columns, then clipped to the remaining row width with `…`. Tool result payloads are not shown; failures and empty searches use compact outcome labels. Terminal control sequences and standalone C0/C1 controls are removed. Terminal line whitespace is folded without rewriting other Unicode content.

When a mixed omission summary does not fit in verbose form, it uses the existing status icons while preserving every non-zero count. For example, `3 nested: 1 running · 1 failed · 1 done` becomes `3 nested: ⏳1 ✗1 ✓1`.

Rows are clipped by terminal display width after grapheme-aware plain-text selection and before theme colors are applied. This preserves composed Unicode characters and prevents ANSI reset sequences from leaking into the parent widget style.

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
| `prompt` | Yes | String | Task prompt for the selected subagent. |
