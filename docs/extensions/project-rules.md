# project-rules

## Purpose

`project-rules` adds project-local Markdown rules to the system prompt.

Use it to keep project instructions in files inside the working directory instead of copying them into every prompt.

## Configuration file

Default file:

```text
~/.pi/agent/agent-suite/project-rules/config.json
```

If `PI_AGENT_SUITE_DIR` is set, use:

```text
$PI_AGENT_SUITE_DIR/project-rules/config.json
```

## Full configuration example

```json
{
  "enabled": true,
  "rulesDir": ".pi/rules"
}
```

## Parameters

- `enabled`
  - Required: no.
  - Type: boolean.
  - Default: `true`.
  - Meaning: controls whether the extension loads project rule files.
  - Set to `false` to disable rule loading.
- `rulesDir`
  - Required: no.
  - Type: string.
  - Default: `.pi/rules`.
  - Meaning: path to the directory that contains project rule files.
  - The path is resolved relative to pi's current working directory.
  - The value must be a non-empty relative path.
  - The value must not contain parent directory traversal with `..`.

Only `enabled` and `rulesDir` are allowed in the config file.

## Rule files

- The extension reads `*.md` candidates under `rulesDir` recursively, follows symlinks, prevents real-directory cycles, and uses deterministic visible-path order.
- Files that are empty or contain only whitespace are counted against the limits but are not rendered.
- A missing `rulesDir` directory adds no project rules.
- Invalid configuration or rule loading failure leaves the system prompt unchanged and reports a warning.

The fixed safety limits are:

- At most 64 KiB (65,536 UTF-8 bytes) per Markdown candidate.
- At most 64 Markdown candidates, including empty and whitespace-only files.
- At most 256 KiB (262,144 UTF-8 bytes) of aggregate candidate content, including empty and whitespace-only files.
- At most 320 KiB (327,680 JavaScript string characters) in the rendered `<project_rules>` section.

Values exactly at each limit are accepted. If any limit is exceeded, the extension rejects the complete `<project_rules>` section, leaves the prompt unchanged, and emits one warning. It does not truncate files or the rendered section.
