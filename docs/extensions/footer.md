# footer

## Purpose

`footer` installs this package's custom pi footer. It shows project, optional git branch, quota, API cost, active agent, model, projection status, MCP errors, context usage, and an optional extension status line.

## Configuration file

Default file: `~/.pi/agent/agent-suite/footer/config.json`.

If this file is missing, the footer is enabled. Provider, model, thinking level, and API cost are shown. Git branch and the separate extension status line are hidden.

## Full configuration example

```json
{
  "enabled": true,
  "showProvider": true,
  "showModel": true,
  "showThinkingLevel": true,
  "showApiCost": true,
  "showGitBranch": false,
  "showExtensionStatusLine": false
}
```

## Parameters

| Name                      | Type    | Required | Default | Meaning                                                                      |
|---------------------------|---------|----------|---------|------------------------------------------------------------------------------|
| `enabled`                 | boolean | No       | `true`  | Enables this custom footer. Set to `false` to keep this footer uninstalled.  |
| `showProvider`            | boolean | No       | `true`  | Shows the model provider in the model segment.                               |
| `showModel`               | boolean | No       | `true`  | Shows the model name in the model segment.                                   |
| `showThinkingLevel`       | boolean | No       | `true`  | Shows the model thinking level in the model segment.                         |
| `showApiCost`             | boolean | No       | `true`  | Shows the recorded API cost segment.                                         |
| `showGitBranch`           | boolean | No       | `false` | Shows the current git branch as `project (branch)` in the project segment.   |
| `showExtensionStatusLine` | boolean | No       | `false` | Shows all `ctx.ui.setStatus` extension statuses on a separate sorted line.   |

## Usage notes

- The config file must contain a JSON object.
- Only the parameters listed above are supported.
- Each parameter value must be a boolean.
- Invalid config prevents this custom footer from being installed.
- Context usage is shown as `used/threshold/window` when native pi compaction is enabled.
- `threshold` is calculated from native pi settings: `contextWindow - compaction.reserveTokens`.
- If native pi compaction is disabled or its settings are invalid, context usage is shown as `used/window`.
