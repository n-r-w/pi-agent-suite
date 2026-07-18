# footer

## Purpose

`footer` installs this package's custom pi footer. It shows project, optional git branch, quota, API cost, active agent, model, projection status, MCP errors, context usage, and statuses without a primary-line representation.

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
  "showGitBranch": false,
  "showAdditionalStatusLine": true
}
```

## Parameters

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | No | `true` | Enables this custom footer. Set to `false` to keep this footer from being installed. |
| `showProvider` | boolean | No | `true` | Shows the model provider in the model segment. |
| `showModel` | boolean | No | `true` | Shows the model name in the model segment. |
| `showThinkingLevel` | boolean | No | `true` | Shows the model thinking level in the model segment. |
| `showApiCost` | boolean | No | `true` | Shows the recorded API cost segment. |
| `showGitBranch` | boolean | No | `false` | Shows the current git branch as `project(branch)` in the project segment. |
| `showAdditionalStatusLine` | boolean | No | `true` | Shows extension statuses that have no representation on the primary line. |

## Usage notes

- The config file must contain a JSON object.
- Only the parameters listed above are supported.
- Each parameter value must be a boolean.
- Invalid config prevents this custom footer from being installed.
- The additional status line is omitted when no unconsumed status has visible text.
- Quota, context projection, the selected agent, and MCP errors remain on the primary line and are not duplicated.
- Codex fast mode remains in the primary model segment when that segment is visible.
- Primary-line segments never wrap or move to the additional line.
- Each rendered line is truncated independently to the terminal width.
- Context usage is shown as `used/threshold/window` when native pi compaction is enabled.
- `threshold` is calculated from native pi settings: `contextWindow - compaction.reserveTokens`.
- If native pi compaction is disabled or its settings are invalid, context usage is shown as `used/window`.
