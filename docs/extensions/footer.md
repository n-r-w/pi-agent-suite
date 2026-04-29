# footer

## Purpose

`footer` owns the custom pi footer for this package.

## Behavior

- Is enabled by default when `config.json` is missing.
- Installs one custom footer for the active pi session.
- Shows footer segments in this order: project, Codex quota, selected agent, model display, context projection, MCP errors, and context usage.
- Shows the model display as `provider/model/thinking-level` by default.
- Does not show the git branch.
- Shows context usage as `current/context-overflow-limit/full-window` when `context-overflow` is enabled.
- Shows context usage as `current/full-window` when `context-overflow` is disabled or its config is invalid.
- Computes `context-overflow-limit` as `contextWindow - compactRemainingTokens` from `~/.pi/agent/agent-suite/context-overflow/config.json`.
- Colors context usage by used context percentage: plain text below `50%`, warning from `50%` to below `80%`, and error from `80%`.
- Colors reasoning levels: `xhigh` uses error, `low`, `minimal`, and `off` use warning, and `high` and `medium` use plain text.
- Shows the selected agent status from status key `agent`.
- Shows the context projection status from status key `context-projection`.
- Shows the Codex quota status from status key `codex-quota`.
- Shows MCP errors only for status keys `mcp` and `mcp-*` when the status text means an error.
- Keeps footer lines within the terminal width.
- Reserves width for quota, agent, model display, projection, MCP error, and context segments before rendering the project segment.
- Shortens long project labels from the middle when footer space is limited.
- Does not own agent selection, context projection calculation, Codex quota calculation, model selection, context-overflow compaction behavior, or context calculation.

## Configuration

File: `~/.pi/agent/agent-suite/footer/config.json`.

```json
{
  "enabled": true,
  "showProvider": true,
  "showModel": true,
  "showThinkingLevel": true
}
```

All fields are optional. Missing config enables the custom footer and shows provider, model, and thinking level.

Defaults:

- `enabled`: `true`
- `showProvider`: `true`
- `showModel`: `true`
- `showThinkingLevel`: `true`

`enabled: false` leaves pi without this package's custom footer while other extensions may still publish status values through `ctx.ui.setStatus`.

## Verification

Tests must verify:

- footer installation on session start;
- no footer installation when `enabled` is `false`;
- redraw request after model selection;
- provider, model, and thinking-level display defaults;
- independent provider, model, and thinking-level display config;
- context usage with the default context-overflow limit;
- context usage when context-overflow is disabled;
- context usage with a configured context-overflow limit;
- context usage when context-overflow config is invalid;
- context usage coloring at `50%` and `80%` boundaries;
- reasoning coloring for `xhigh`, `high`, `medium`, `low`, `minimal`, and `off`;
- rendering order for `codex-quota`, `agent`, `context-projection`, and context usage;
- MCP status filtering;
- footer width staying within terminal width;
- compact context projection statuses staying within terminal width;
- long project labels not hiding quota, agent, reasoning, projection, MCP error, or context segments.
