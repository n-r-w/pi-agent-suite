# model-aliases

## Purpose

`model-aliases` defines shared shortcuts for model selection.

A shortcut maps one alias to:
- a real `provider/model` identifier;
- an optional default `thinking` level.

Any extension field that accepts `model.id` can use either:
- a real `provider/model` ID;
- an alias from this file.

If both alias and caller config define `thinking`, caller config has priority. When the caller config does not define `thinking`, the alias default `thinking` applies. The caller's current thinking level is used only when neither the config nor the alias provides one.

## Configuration

Default file: `~/.pi/agent/agent-suite/model-aliases/config.json`.

If `PI_AGENT_SUITE_DIR` is set, file path is `$PI_AGENT_SUITE_DIR/model-aliases/config.json`.

The file is optional. If it is missing, alias resolution is disabled and only direct `provider/model` IDs work.

## File format

Top-level keys are alias names. Value is an object with `id` and optional `thinking`.

```json
{
  "analyst-complex": {
    "id": "openai-codex/gpt-5.6-sol",
    "thinking": "medium"
  },
  "fast-coder": {
    "id": "openai-codex/gpt-5.4"
  }
}
```

## Validation

- Alias key must be a non-empty string.
- `<alias>.id` must be a valid `provider/model` string.
- `<alias>.thinking` is optional and must be one of:
  - `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Unknown fields are rejected.

Invalid config fails closed for alias resolution.
