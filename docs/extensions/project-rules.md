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

Place default project rules under `<cwd>/.pi/rules`.

- The extension reads non-empty `*.md` files under `rulesDir` recursively.
- Files that are empty or contain only whitespace are ignored.
- A missing `rulesDir` directory adds no project rules.
- Paths inside `~/.pi`, the active pi agent directory, or the active agent-suite directory are never loaded.
- The global-storage exclusion also applies to configured `rulesDir` values and symbolic-link targets.
- Invalid configuration or rule loading failure leaves the system prompt unchanged and reports a warning.
