# system-prompt

## Purpose

`system-prompt` replaces pi's base system prompt with a Markdown template and explicit runtime variables.

## Behavior

- Handles `session_start` and `before_agent_start`.
- Reads configuration from `~/.pi/agent/agent-suite/system-prompt/config.json`.
- Does not read legacy config paths.
- Is enabled by default when `config.json` is missing.
- Uses the bundled Markdown template when `templateFile` is missing.
- Bundled prompt file lives at `pi-package/extensions/system-prompt/prompts/system.md`.
- Requires `templateFile` to be an absolute path.
- Leaves pi's original system prompt unchanged when config or template loading fails.
- Warns during startup or reload when config or template loading fails.
- Removes unsupported `{{...}}` variables and warns with the variable names during startup or reload.
- Does not append runtime values unless the matching variable exists in the template.
- Keeps static prompt text in the Markdown template.
- Inserts dynamic pi runtime values only through variables.
- Runs before agent runtime prompt contributors from `main-agent-selection`, `run-subagent`, `consult-advisor`, and `convene-council` in this package.

## Configuration

File: `~/.pi/agent/agent-suite/system-prompt/config.json`.

```json
{
  "enabled": true,
  "templateFile": "/absolute/path/to/system.md"
}
```

Fields:

- `enabled`: optional. Default `true`. Set to `false` to leave pi's original system prompt unchanged.
- `templateFile`: optional absolute path to a Markdown template file.

## Variables

Supported variables:

- `{{date}}`: local date in `YYYY-MM-DD` format.
- `{{cwd}}`: current working directory with `/` path separators.
- `{{tools}}`: active tools that have prompt snippets, formatted as `- name: snippet`.
- `{{toolGuidelines}}`: dynamic `promptGuidelines` supplied by active tools or extensions.
- `{{appendSystemPrompt}}`: text from pi append-system-prompt inputs.
- `{{contextFiles}}`: loaded context files formatted as `## path` plus file content.
- `{{skills}}`: loaded skills formatted by pi when the `read` tool is active.

Unsupported variables are removed from rendered output.

## Example template

```md
You are an expert coding assistant.

Available tools:
{{tools}}

Guidelines:
- Be concise in your responses.
- Show file paths clearly when working with files.
{{toolGuidelines}}

{{appendSystemPrompt}}

# Project Context

{{contextFiles}}

{{skills}}

Current date: {{date}}
Current working directory: {{cwd}}
```

## Verification

Tests must verify:

- default template usage when config is missing;
- suite-only config reading without legacy fallback;
- absolute `templateFile` validation;
- startup and reload warnings for unsupported variables;
- removal of unsupported variables from rendered output;
- no automatic insertion when a supported variable is absent;
- fail-closed behavior for invalid config or unreadable templates;
- package loading order preserves later agent runtime prompt contributions.
