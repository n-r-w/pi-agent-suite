# codex-verbosity

## Purpose

`codex-verbosity` owns `text.verbosity` injection for OpenAI Codex provider requests.

## Behavior

- Handles only OpenAI Codex provider requests.
- Reads configuration from `~/.pi/agent/agent-suite/codex-verbosity/config.json`.
- Is disabled by default when `config.json` is missing.
- Requires `enabled: true` before injecting `text.verbosity`.
- Uses `medium` as the default `verbosity` when enabled config omits `verbosity`.
- Leaves the provider request unchanged and creates an issue only for `codex-verbosity` when configuration is invalid.
- Preserves all other provider payload fields.

## Configuration

File: `~/.pi/agent/agent-suite/codex-verbosity/config.json`.

```json
{
  "enabled": true,
  "verbosity": "medium"
}
```

`enabled` is optional and defaults to `false`. `verbosity` is optional and defaults to `medium`.

Allowed `verbosity` values:

- `low`
- `medium`
- `high`

Invalid configuration cases:

- invalid JSON;
- unsupported key;
- non-boolean `enabled` value;
- `verbosity` outside the allowed value set;
- non-string `verbosity` value.

## Verification

Tests must verify:

- no provider request change when the config file is missing;
- default `medium` injection when enabled config omits `verbosity`;
- `text.verbosity` injection for `low`, `medium`, and `high`;
- configuration error isolation from other extensions;
- no provider request change for non-OpenAI Codex providers.
