# url-scheme

## Purpose

`url-scheme` converts existing file references in final assistant answers into Markdown links that open the file in your editor.

## Configuration file

Default file: `~/.pi/agent/agent-suite/url-scheme/config.json`.

If the file is missing, the extension stays disabled.

## Full configuration example

```json
{
  "enabled": true,
  "scheme": "vscode"
}
```

## Parameters

| Name | Required | Type or value shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `false` | Enables file-reference conversion when set to `true`. |
| `scheme` | No | String. One of `vscode`, `cursor`, `webstorm`, `idea`, `pycharm`, `phpstorm`, `txmt`, `bbedit`, `zed`. | `vscode` | Selects the editor URL scheme used in generated links. |

Only `enabled` and `scheme` are supported.

## Usage notes

- The extension rewrites references only when `enabled` is `true`.
- The target path must exist and must be a file.
- Relative paths are resolved against the active Pi working directory.
- Supported reference formats are `path`, `path:line`, `path:startLine-endLine`, and `path:line:column`.
- References inside Markdown code blocks and Markdown images are not converted.
