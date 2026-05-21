# footer

## Purpose

`footer` installs this package's custom pi footer. It shows project, quota, API cost, active agent, model and context.

## Configuration file

Default file: `~/.pi/agent/agent-suite/footer/config.json`.

If this file is missing, the footer is enabled with all display options turned on.

## Full configuration example

```json
{
  "enabled": true,
  "showProvider": true,
  "showModel": true,
  "showThinkingLevel": true,
  "showApiCost": true
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

## Usage notes

- The config file must contain a JSON object.
- Only the parameters listed above are supported.
- Each parameter value must be a boolean.
- Invalid config prevents this custom footer from being installed.
