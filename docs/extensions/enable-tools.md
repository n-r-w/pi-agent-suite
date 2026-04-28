# enable-tools

## Purpose

`enable-tools` enables built-in search tools that this package expects agents to use.

## Behavior

- Is enabled by default.
- Runs when a pi session starts.
- Adds configured tools to the active tool list when pi has registered them.
- Uses `grep`, `find`, and `ls` when config is missing or `include` is omitted.
- Keeps active tools that were already enabled.
- Does not register new tools.
- Does not enable tools that pi has not registered.
- Applies `exclude` after `include`, so `exclude` wins when a tool appears in both lists.
- Fails closed on invalid config and leaves active tools unchanged.
- Does not own main-agent tool selection, subagent tool selection, or advisor tool disabling.

## Configuration

File: `~/.pi/agent/config/enable-tools.json`.

```json
{
  "enabled": true,
  "include": ["grep", "find", "ls"],
  "exclude": []
}
```

All fields are optional. Missing config enables `grep`, `find`, and `ls`.

Defaults:

- `enabled`: `true`
- `include`: `["grep", "find", "ls"]`
- `exclude`: `[]`

`enabled: false` disables all behavior owned by this extension.

`include` lists tool names to add to active tools. `exclude` lists tool names that must not be added by this extension. If the same tool name appears in both lists, `exclude` wins.

## Verification

Tests must verify:

- `grep`, `find`, and `ls` are enabled on session start when config is missing and tools are registered;
- configured `include` and `exclude` lists are applied;
- `exclude` wins over `include`;
- disabled config leaves active tools unchanged;
- invalid config fails closed and reports an extension warning;
- already active tools are preserved.
