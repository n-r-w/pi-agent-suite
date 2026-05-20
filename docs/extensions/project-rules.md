# project-rules

## Purpose

`project-rules` appends Markdown rule files from a project-local directory to the final system prompt.

## Behavior

- Handles `before_agent_start`.
- Reads configuration from `~/.pi/agent/agent-suite/project-rules/config.json`.
- Is enabled by default when `config.json` is missing.
- Uses `.pi` as the default rules directory.
- Resolves `rulesDir` relative to pi's current working directory.
- Requires `rulesDir` to be a relative path.
- Rejects `rulesDir` values that contain parent directory traversal.
- Reads `*.md` files recursively under `rulesDir`.
- Matches `*.md` against the visible path under `rulesDir`.
- Follows symlinked `rulesDir` directories.
- Follows symlinked files and directories inside `rulesDir`.
- Allows symlink targets outside the current working directory.
- Skips repeated real directory paths during recursion to avoid symlink cycles.
- Sorts rules by visible path before rendering.
- Skips empty files and files that contain only whitespace.
- Does not append `<project_rules>` when no non-empty Markdown rules are found.
- Leaves the system prompt unchanged when config validation or rule loading fails.
- Warns when config validation or rule loading fails.
- Runs after `system-prompt`, so `system-prompt` template replacement does not overwrite project rules.
- Runs before `mcp-wrapper`, so MCP instructions are appended after project rules.

Symlink targets can point to any readable local file or directory. A matching symlink can therefore add content from outside the current working directory to the prompt.

## Configuration

File: `~/.pi/agent/agent-suite/project-rules/config.json`.

```json
{
  "enabled": true,
  "rulesDir": ".pi"
}
```

Fields:

- `enabled`: optional. Default `true`. Set to `false` to skip project rule loading.
- `rulesDir`: optional relative path to the rules directory. Default `.pi`.

## Prompt format

Example output:

```xml
<project_rules>
  <project_rule path=".pi/rules.md">
Project rule text.
  </project_rule>
  <project_rule path=".pi/nested/extra.md">
Nested project rule text.
  </project_rule>
</project_rules>
```

The `path` attribute uses the visible path under `rulesDir`. Rule file content is inserted unchanged.

## Verification

Tests must verify:

- default config values when config is missing;
- rejection of unsupported config keys;
- rejection of invalid `enabled` and `rulesDir` values;
- rejection of absolute `rulesDir` and parent directory traversal;
- recursive Markdown discovery;
- deterministic path ordering;
- skipping empty and whitespace-only files;
- symlinked rules directory support;
- symlinked file and directory support;
- directory cycle protection;
- no prompt change when disabled, missing, or empty;
- fail-closed behavior and warning on invalid config or rule loading failure;
- package composition order with `system-prompt` and `mcp-wrapper`.
