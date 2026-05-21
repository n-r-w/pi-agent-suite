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
