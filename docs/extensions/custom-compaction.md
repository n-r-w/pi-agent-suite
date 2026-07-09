# custom-compaction

## Purpose

`custom-compaction` replaces pi's default conversation compaction with a configurable summary step. It can use the current session model or a configured model, the current thinking level or a configured reasoning level, and optional custom prompt files.

## Configuration file

Default config file:

```text
~/.pi/agent/agent-suite/custom-compaction/config.json
```

If the config file is missing, the extension stays enabled and uses its defaults.

## Full configuration example

```json
{
  "enabled": true,
  "systemPromptFile": "/absolute/path/to/compaction-system.md",
  "historyPromptFile": "/absolute/path/to/compaction.md",
  "updatePromptFile": "/absolute/path/to/compaction-update.md",
  "turnPrefixPromptFile": "/absolute/path/to/compaction-turn-prefix.md",
  "model": "provider/model",
  "reasoning": "medium",
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  },
  "summary": {
    "enabled": true,
    "model": null,
    "thinking": null,
    "maxConcurrency": 1,
    "retryCount": 1,
    "retryDelayMs": 5000,
    "systemPromptFile": null,
    "userPromptFile": null
  }
}
```

## Parameters

| Parameter | Required | Type or shape | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables custom compaction. Set to `false` to disable this extension. |
| `systemPromptFile` | No | Non-empty absolute path string | Built-in system prompt | Prompt file used as the system prompt for compaction. |
| `historyPromptFile` | No | Non-empty absolute path string | Built-in history prompt | Prompt file used when there is no previous summary. |
| `updatePromptFile` | No | Non-empty absolute path string | Built-in update prompt | Prompt file used when a previous summary exists. |
| `turnPrefixPromptFile` | No | Non-empty absolute path string | Built-in turn-prefix prompt | Prompt file used when compaction needs a summary for the start of a turn. |
| `model` | No | String in `provider/model` format | Current session model | Model used for compaction. Both `provider` and `model` must be present. |
| `reasoning` | No | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Current thinking level when it uses one of the allowed values | Reasoning level used for compaction model calls. |
| `retry` | No | Object | `{ "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }` | Retry settings for transient compaction model failures. |
| `retry.enabled` | No | Boolean | `true` | Enables retry for transient compaction model failures. |
| `retry.maxRetries` | No | Non-negative integer | `3` | Maximum number of retry attempts. |
| `retry.baseDelayMs` | No | Non-negative integer | `2000` | Base delay between retry attempts in milliseconds. |
| `summary` | No | Object | Enabled | Configures helper summaries for large `toolResult` messages when the compaction request does not fit the selected compaction model. |

## Tool result summary parameters

`custom-compaction` uses the same `summary` object shape as `context-projection`.

Helper summaries run only when the normal compaction summary input is too large. A large `toolResult` is a successful text tool result with at least 4,000 estimated tokens.

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `summary.enabled` | No | Boolean | `true` | Enables helper summaries for large tool results before final compaction. |
| `summary.model` | No | `null` or string in `provider/model` format | Selected compaction model | Model used for helper summaries. `null` has the same effect as omitting the parameter. |
| `summary.thinking` | No | `null`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Selected compaction reasoning | Thinking level used for helper summary requests. `null` has the same effect as omitting the parameter. |
| `summary.maxConcurrency` | No | Positive integer | `1` | Maximum number of helper summary requests that can run at the same time. |
| `summary.retryCount` | No | Non-negative integer | `1` | Number of retry attempts after the first helper summary request fails. |
| `summary.retryDelayMs` | No | Non-negative integer | `5000` | Delay between helper summary retry attempts, in milliseconds. |
| `summary.systemPromptFile` | No | `null` or absolute file path | Shared tool-result summary system prompt | Custom system prompt file for helper summary generation. |
| `summary.userPromptFile` | No | `null` or absolute file path | Shared tool-result summary user prompt | Custom user prompt file appended after the tool result text. |

## Helper summary diagnostics

Each failed helper summary attempt appends the shared `tool-result-summary-diagnostic` custom entry with `source` set to `custom-compaction`. See [context-projection summary diagnostics](context-projection.md#summary-diagnostics) for the entry fields and data-exclusion rules.
