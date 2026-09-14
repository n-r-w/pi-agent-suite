# footer

## Purpose

`footer` installs this package's custom pi footer. It shows project, optional git branch, quota, API cost, processed tokens, active agent, model, the latest prompt cache hit rate, projection status, MCP errors, context usage, and statuses without a primary-line representation.

## Configuration file

Default file: `~/.pi/agent/agent-suite/footer/config.json`.

If this file is missing, the footer is enabled. The git branch is hidden, and the additional status line is enabled.

## Full configuration example

```json
{
  "enabled": true,
  "showProvider": true,
  "showModel": true,
  "showThinkingLevel": true,
  "showApiCost": true,
  "showApiTokens": true,
  "showCacheHitRate": true,
  "showGitBranch": false,
  "showAdditionalStatusLine": true
}
```

## Parameters

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | No | `true` | Enables this custom footer and its cache hit rate display on the subagent management screen. |
| `showProvider` | boolean | No | `true` | Shows the model provider in the model segment. When `showModel` and `showThinkingLevel` are both `true`, the provider is shown even if `showProvider` is `false`. |
| `showModel` | boolean | No | `true` | Shows the model name in the model segment. |
| `showThinkingLevel` | boolean | No | `true` | Shows the model thinking level in the model segment. |
| `showApiCost` | boolean | No | `true` | Shows the recorded API cost segment as `$0.086`. |
| `showApiTokens` | boolean | No | `true` | Shows cumulative processed tokens as `T10K`. |
| `showCacheHitRate` | boolean | No | `true` | Shows the latest prompt cache hit rate as an integer such as `CH87` in the main footer and selected subagent header. |
| `showGitBranch` | boolean | No | `false` | Shows the current git branch as `project(branch)` in the project segment. |
| `showAdditionalStatusLine` | boolean | No | `true` | Shows extension statuses that have no representation on the primary line. |

## Usage notes

- The config file must contain a JSON object.
- Only the parameters listed above are supported.
- Each parameter value must be a boolean.
- Invalid config prevents this custom footer from being installed and hides the cache hit rate on the subagent management screen.
- The additional status line is omitted when no unconsumed status has visible text.
- Quota, context projection, the selected agent, and MCP errors remain on the primary line and are not duplicated.
- Codex fast mode remains in the primary model segment when that segment is visible.
- Cache hit rate is calculated as `cacheRead / (input + cacheRead + cacheWrite) * 100` for the latest assistant response and remains hidden until the session reports cache activity.
- API cost and processed tokens come only from the usage store. Both totals include the active root Pi session, its direct and nested subagents, and every source listed in [usage](usage.md). Processed tokens equal `input + output + cacheRead + cacheWrite` and use the same compact format as `/usage` and the selected subagent header.
- The footer renders usage as `$0.086 · T10K`. Subscription authentication does not add a marker to the cost.
- When `showApiCost` or `showApiTokens` is enabled, the footer caches both totals and refreshes them every 10 seconds. A refresh requests a global TUI render only when cost, processed tokens, or usage availability changes. The first unavailable usage read hides both enabled segments and reports one warning in the interactive root session. This applies during startup and later refreshes. The refresh timer continues after a later failure, and a later valid result restores the enabled segments. Child sessions do not query usage or start the refresh timer.
- Primary-line segments never wrap or move to the additional line.
- Each rendered line is truncated independently to the terminal width.
- Context usage is shown as `used/threshold/window` when native pi compaction is enabled.
- `threshold` is calculated from native pi settings: `contextWindow - compaction.reserveTokens`.
- If native pi compaction is disabled or its settings are invalid, context usage is shown as `used/window`.
