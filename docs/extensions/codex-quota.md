# codex-quota

## Purpose

`codex-quota` shows OpenAI Codex quota status in [custom pi footer](footer.md)

## Configuration

Default file: `~/.pi/agent/agent-suite/codex-quota/config.json`.

Full example:

```json
{
  "enabled": true,
  "refreshInterval": 60,
  "retryAttempts": 5,
  "retryInterval": 2
}
```

## Parameters

| Name | Required | Type or shape | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `false` | Enables quota polling when set to `true`. If the config file is missing or this value is omitted, the extension is disabled. |
| `refreshInterval` | No | Finite number greater than or equal to `10` | `60` | Seconds between quota refreshes. |
| `retryAttempts` | No | Integer greater than or equal to `1` | `5` | Maximum number of quota request attempts per refresh. |
| `retryInterval` | No | Finite number greater than or equal to `1` | `2` | Seconds between quota request attempts. |

## Usage notes

- The extension needs Codex authentication available through pi.
- Invalid JSON, unsupported keys, or invalid parameter values create a configuration issue in pi.
- If the config file exists but is invalid, the extension uses `refreshInterval: 60`, `retryAttempts: 5`, and `retryInterval: 2`.
