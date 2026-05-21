# ask-llm

## Purpose

`ask-llm` adds the `/ask` command for one-off model questions. The question and answer are not saved to the current session.

## Usage

Run `/ask <question>` to ask a question directly. Run `/ask` without text to open the question dialog.

The extension uses the current session model and thinking level unless you configure another model or thinking level.

## Configuration

Default configuration file: `~/.pi/agent/agent-suite/ask-llm/config.json`.

Full configuration example:

```json
{
  "enabled": true,
  "model": {
    "id": "provider/model",
    "thinking": "medium"
  },
  "systemPromptFile": "/absolute/path/to/system.md",
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

All configuration parameters are optional. If the configuration file is missing, `/ask` is enabled and uses the current session model, current thinking level, bundled system prompt, and default retry settings.

| Parameter | Type or shape | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | No | `true` | Enables or disables the `/ask` command. Set to `false` to disable the command. |
| `model` | object | No | Current session model and thinking level | Groups model selection options. |
| `model.id` | string in `provider/model` format | No | Current session model | Selects the model used by `/ask`. |
| `model.thinking` | string enum | No | Current thinking level | Selects the thinking level used by `/ask`. |
| `systemPromptFile` | non-empty absolute path string | No | Bundled system prompt | Uses a custom system prompt file. The file must be readable and non-empty. |
| `retry` | object | No | Default retry settings | Groups retry options for retryable provider failures. |
| `retry.enabled` | boolean | No | `true` | Enables or disables retries. |
| `retry.maxRetries` | non-negative integer | No | `3` | Sets the maximum number of retry attempts. |
| `retry.baseDelayMs` | non-negative integer | No | `2000` | Sets the base retry delay in milliseconds. |

Allowed `model.thinking` values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

The configuration file must be a JSON object. Unsupported keys make the configuration invalid.
