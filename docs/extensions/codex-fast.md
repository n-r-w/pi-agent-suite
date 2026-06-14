# codex-fast

## Purpose

`codex-fast` toggles fast mode for selected OpenAI Codex models.

When fast mode is enabled, supported Codex requests receive `service_tier: "priority"` in the provider payload.

## Supported models

- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.5`

## Usage

Toggle fast mode with either option:

- `/fast`
- `Ctrl+Alt+F`

Fast mode is disabled by default.

## Footer marker

When fast mode is enabled, the footer appends `-F` to the model segment. The `F` uses the current Pi accent color.

Example:

```text
gpt-5.5/high-F
```

## State file

File: `~/.pi/agent/agent-suite/codex-fast/state.json`.

Example:

```json
{
  "enabled": true
}
```

Set the state through `/fast` or `Ctrl+Alt+F`. Do not edit the state file while Pi is running.
