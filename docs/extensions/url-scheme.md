# url-scheme

## Purpose

`url-scheme` converts existing file references in final assistant answers into Markdown links that open the file in a configured editor.

## Behavior

- Reads configuration from `~/.pi/agent/agent-suite/url-scheme/config.json`.
- Is disabled by default when `config.json` is missing.
- Requires `enabled: true` before rewriting assistant messages.
- Uses `vscode` as the default `scheme` when enabled config omits `scheme`.
- Rewrites only final assistant messages with `stop` or `length` stop reasons.
- Skips intermediate tool-use, error, and aborted assistant messages.
- Skips `url-scheme` processing in marked child Pi processes, including invalid config warnings.
- Removes `textSignature` from text blocks whose text is changed.
- Keeps `textSignature` when a text block is not changed.
- Removes single backticks only when the whole inline code span is a file reference or one Markdown link to a file.
- Leaves inline code spans unchanged when they contain commands, images, or other text.
- Rewrites existing Markdown links when their target is a file reference.
- Preserves the label of rewritten Markdown links.
- Skips fenced code blocks and Markdown images.
- Rewrites relative and absolute file references only when the target file exists and is a regular file.
- Resolves relative references against the active pi working directory.
- Supports `path`, `path:line`, `path:startLine-endLine`, and `path:line:column` references.
- Opens `path:startLine-endLine` references at `startLine` because the supported editor URL schemes do not share a documented line-range format.
- Omits line and column URL parts when the source reference does not include them.
- Percent-encodes URL path and query values, including spaces, `#`, `?`, `&`, Unicode, and Windows paths.
- Normalizes Windows path separators to URL path separators in generated editor URLs.
- Leaves the assistant message unchanged and creates an issue only for `url-scheme` when configuration is invalid.

## Configuration

File: `~/.pi/agent/agent-suite/url-scheme/config.json`.

```json
{
  "enabled": true,
  "scheme": "vscode"
}
```

`enabled` is optional and defaults to `false`. `scheme` is optional and defaults to `vscode`.

Allowed `scheme` values:

- `vscode`
- `cursor`
- `webstorm`
- `idea`
- `pycharm`
- `phpstorm`
- `txmt`
- `bbedit`

Invalid configuration cases:

- invalid JSON;
- unsupported key;
- non-boolean `enabled` value;
- `scheme` outside the allowed value set;
- non-string `scheme` value.

## URL formats

- VS Code: `vscode://file/{absPath}:{line}:{column}`
- Cursor: `cursor://file/{absPath}:{line}:{column}`
- WebStorm: `webstorm://open?file={absPath}&line={line}&column={column}`
- IntelliJ: `idea://open?file={absPath}&line={line}&column={column}`
- PyCharm: `pycharm://open?file={absPath}&line={line}&column={column}`
- PhpStorm: `phpstorm://open?file={absPath}&line={line}&column={column}`
- TextMate: `txmt://open?url=file://{absPath}&line={line}&column={column}`
- BBEdit: `x-bbedit://open?url=file://{absPath}&line={line}&column={column}`

When `line` or `column` is missing from the source reference, the matching URL part is omitted.

## Verification

Tests must verify:

- no assistant message change when the config file is missing;
- no assistant message change when `enabled` is `false`;
- default `vscode` links when enabled config omits `scheme`;
- all supported editor schemes;
- final-only rewriting for `stop` and `length` assistant messages;
- no rewriting for `toolUse`, `error`, and `aborted` assistant messages;
- marked child Pi processes leave assistant messages unchanged and do not report `url-scheme` config warnings;
- no rewriting for missing files;
- relative and absolute path rewriting;
- `path:line`, `path:startLine-endLine`, and `path:line:column` rewriting;
- percent-encoding of path and query values;
- Windows path formatting without host OS assumptions;
- `textSignature` removal from changed signed text blocks;
- no `textSignature` removal from unchanged signed text blocks;
- single-backtick removal around converted file references and link-only inline code;
- Markdown file-link target rewriting while preserving labels;
- no rewriting inside inline code spans, fenced code blocks, and Markdown images;
- configuration error isolation from other extensions.
