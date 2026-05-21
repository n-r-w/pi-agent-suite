# context-overflow

## Purpose

`context-overflow` starts preventive pi context compaction before the active model runs out of context tokens.

## Configuration file

File: `~/.pi/agent/agent-suite/context-overflow/config.json`.

Full example:

```json
{
  "enabled": true,
  "compactRemainingTokens": 49152
}
```

## Parameters

| Parameter | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables preventive context compaction. Set to `false` to disable the extension. |
| `compactRemainingTokens` | No | Non-negative integer | `49152` | Sets the remaining-token threshold that starts compaction. Compaction starts when remaining tokens are less than or equal to this value. |

The configuration file must contain a JSON object. Only `enabled` and `compactRemainingTokens` are supported. Unsupported keys or wrong value types make the configuration invalid.

## Usage notes

- Missing configuration uses the defaults and keeps the extension enabled.
- Invalid configuration disables preventive compaction.
- The extension starts compaction only when context usage is available.
