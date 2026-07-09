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
| `widgetLineBudget` | No | Integer greater than or equal to `1` | `7` | Sets how many progress lines the live subagent widget keeps. |
| `descriptionPromptFile` | No | Non-empty absolute file path string | Bundled tool description | Replaces the `run_subagent` tool description with the trimmed contents of the file. The file must be readable and must not be empty after trimming whitespace. |

The config object accepts only these keys: `enabled`, `maxDepth`, `widgetLineBudget`, and `descriptionPromptFile`.

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
