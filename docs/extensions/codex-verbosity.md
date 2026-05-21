# codex-verbosity

## Purpose

`codex-verbosity` sets the verbosity level for OpenAI Codex responses.

## Configuration file

File: `~/.pi/agent/agent-suite/codex-verbosity/config.json`.

Full example:

```json
{
  "enabled": true,
  "verbosity": "medium"
}
```

## Parameters

| Parameter | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | Disabled when omitted or set to `false` | Enables verbosity control for OpenAI Codex responses. Set to `true` to enable the extension. |
| `verbosity` | No | String: `low`, `medium`, or `high` | `medium` when `enabled` is `true` and `verbosity` is omitted | Sets the response verbosity level. |

The configuration file must contain a JSON object. Only `enabled` and `verbosity` are supported. Unsupported keys or wrong value types make the configuration invalid.

## Usage notes

- The extension affects only OpenAI Codex responses.
- Missing configuration keeps the extension disabled.
