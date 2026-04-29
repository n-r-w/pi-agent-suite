# codex-quota

## Purpose

`codex-quota` owns the OpenAI Codex quota status shown in the pi footer.

## Behavior

- Uses status key `codex-quota`.
- Reads configuration from `~/.pi/agent/agent-suite/codex-quota/config.json`.
- Is disabled by default when `config.json` is missing.
- Requires `enabled: true` before polling starts.
- Uses `60` seconds as the default `refreshInterval` when enabled.
- Requires `refreshInterval` to be a finite number greater than or equal to `10`.
- Uses `60` seconds and creates an issue only for `codex-quota` when enabled configuration has invalid field values.
- Does not read configuration for other extensions.
- Reads the pi-managed `openai-codex` OAuth access token through `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`.
- Uses pi OAuth refresh instead of reading Codex CLI auth from `~/.codex/auth.json` or `~/.config/codex/auth.json`.
- Extracts `chatgpt-account-id` from the access token claim `https://api.openai.com/auth.chatgpt_account_id`.
- Sends both bearer token and `chatgpt-account-id` to the Codex usage endpoint.
- Shows quota in compact footer format: `91%/4h 100%/6d`.
- Colors only the remaining quota percentage: plain text from `70%` to `100%`, warning from `30%` to `69%`, and error from `0%` to `29%`.
- Leaves reset windows and compact non-data text plain.
- Shows compact non-data states: `CX auth`, `CX err`, or `CX ?`.
- Does not break the footer when Codex auth is unavailable.
- Stops background refresh on session shutdown.

## Configuration

File: `~/.pi/agent/agent-suite/codex-quota/config.json`.

```json
{
  "enabled": true,
  "refreshInterval": 60
}
```

`enabled` is optional and defaults to `false`. `refreshInterval` is optional and defaults to `60`.

Invalid configuration cases:

- invalid JSON;
- unsupported key;
- non-boolean `enabled` value;
- non-number `refreshInterval` value;
- `refreshInterval` lower than `10`;
- `refreshInterval` value that is not a finite number.

## Verification

Tests must verify:

- disabled default behavior when the config file is missing;
- default value `60` seconds when enabled;
- minimum accepted value `10` seconds;
- issue creation only for `codex-quota` on configuration error;
- behavior with fake pi-managed `openai-codex` OAuth;
- behavior with fake fetch;
- compact quota, auth, error, and unknown-data statuses;
- timer shutdown on session shutdown.
