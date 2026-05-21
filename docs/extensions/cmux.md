# cmux

## Purpose

`cmux` sends a [cmux](https://cmux.com/) notification when a top-level pi agent run finishes successfully.

## Configuration file

Default file: `~/.pi/agent/agent-suite/cmux/config.json`.

If `config.json` is missing, the extension uses the default configuration.

## Full configuration example

```json
{
  "enabled": true
}
```

## Parameters

- `enabled`
  - Type: boolean.
  - Required: no.
  - Default: `true`.
  - Meaning: enables or disables cmux notifications from this extension.

Unsupported keys make the configuration invalid. Invalid configuration disables cmux notifications and reports a warning.

## Behavior

- Sends notifications only for completed top-level pi agent runs.
- Does not send notifications for child agent runs.
- Does not interrupt the agent if `cmux` is unavailable.
