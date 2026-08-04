# consult-advisor

## Purpose

`consult-advisor` adds the `consult_advisor` tool. Use it to ask an independent advisor model a focused question during a Pi session.

The model with the highest "thinking" level and reasoning capabilities is recommended for best results. Each tool call uses a Pi-compatible UUIDv7 provider session ID separate from the main agent session. Retries for one tool call reuse that ID.

When the `knowledge` extension resolves applicable stored knowledge, `consult_advisor` appends the same `<knowledge>` block used by the calling agent to the advisor's explicit system context.

## Configuration file

Default path:

```text
~/.pi/agent/agent-suite/consult-advisor/config.json
```

If the config file is missing, the extension is enabled and uses the current session model, current thinking level, bundled advisor prompt, and retry defaults.

## Full configuration example

```json
{
  "enabled": true,
  "model": {
    "id": "analyst-complex",
    "thinking": "high"
  },
  "promptFile": "/Users/me/.pi/advisor-prompt.md",
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  },
  "debugPayloadFile": "./debug/consult-advisor-payload.json"
}
```

## Configuration parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables or disables the `consult_advisor` tool. Set to `false` to disable it. |
| `model` | No | Object with optional `id` and `thinking` fields | Current session model and current thinking level | Selects the advisor model settings. |
| `model.id` | No | Non-empty string | Current session model | Selects the model used by the advisor. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `model.thinking` | No | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Current thinking level | Selects the advisor thinking level. |
| `promptFile` | No | Non-empty absolute file path | Bundled advisor prompt | Uses a custom advisor prompt file. The file must be readable and non-empty. |
| `retry` | No | Object with optional `enabled`, `maxRetries`, and `baseDelayMs` fields | Retry defaults | Controls retry behavior for retryable advisor provider failures. |
| `retry.enabled` | No | Boolean | `true` | Enables or disables retries. |
| `retry.maxRetries` | No | Non-negative integer | `3` | Sets the maximum number of retry attempts. |
| `retry.baseDelayMs` | No | Non-negative integer | `2000` | Sets the base retry delay in milliseconds. |
| `debugPayloadFile` | No | Non-empty absolute or relative file path | Not set | Writes the advisor request payload to this file for troubleshooting. Relative paths are resolved from the directory that contains `config.json`. |
