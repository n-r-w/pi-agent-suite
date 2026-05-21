# enable-tools

## Purpose

`enable-tools` enables additional tools that are disabled in pi by default. By default, it enables `grep`, `find`, and `ls`.

## Configuration

Default config file: `~/.pi/agent/agent-suite/enable-tools/config.json`.

If `PI_AGENT_SUITE_DIR` is set, the config file is `$PI_AGENT_SUITE_DIR/enable-tools/config.json`.

Older `~/.pi/agent/config/enable-tools.json` is read only when the suite config file is absent.

Missing config enables `grep`, `find`, and `ls`.

### Full config example

```json
{
  "enabled": true,
  "include": ["grep", "find", "ls"],
  "exclude": []
}
```

### Parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables this extension when set to `true`. Set to `false` to disable it. |
| `include` | No | Array of non-empty tool-name strings | `["grep", "find", "ls"]` | Tool names to add to the active tool list when those tools are registered in pi. |
| `exclude` | No | Array of non-empty tool-name strings | `[]` | Tool names this extension must not add. `exclude` wins when the same tool name appears in `include` and `exclude`. |

No other config keys are allowed. Invalid config is not applied.
