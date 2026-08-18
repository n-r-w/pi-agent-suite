# system-prompt

## Purpose

`system-prompt` replaces pi's base system prompt with a Markdown template. The template can include runtime values such as the current date, working directory, active tool text, deferred-toolset triggers, and loaded project context.

## Configuration

Default config file: `~/.pi/agent/agent-suite/system-prompt/config.json`.

Full config example:

```json
{
  "enabled": true,
  "templateFile": "/absolute/path/to/system.md"
}
```

Parameters:

| Name | Type or shape | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | Boolean | No | `true` | Enables this extension. Set to `false` to keep pi's original system prompt. |
| `templateFile` | Absolute file path string | No | Bundled system prompt template | Markdown template file used as the system prompt. Relative paths are rejected. |

Only these parameters are accepted.

If the config file is missing, the extension uses the bundled system prompt template. If the config file is invalid or the template file cannot be read, pi keeps its original system prompt.

## Template variables

Use variables in the template as `{{variableName}}`. Whitespace inside braces is allowed, such as `{{ date }}`.

Supported variables:

| Variable | Inserts |
| --- | --- |
| `{{date}}` | Local date in `YYYY-MM-DD` format. |
| `{{cwd}}` | Current working directory with `/` path separators. |
| `{{tools}}` | Active tools that have prompt text, formatted as `- name: text`. If no matching tools are available, inserts `(none)`. |
| `{{toolsets}}` | Eligible deferred toolsets as `<toolsets>` XML, one `<toolset name="…" description="…"/>` per entry. It is empty when none are eligible. Attribute values XML-escape `&`, `<`, `>`, `"`, and `'`. |
| `{{toolGuidelines}}` | Prompt guidelines supplied by active tools or extensions, one bullet per guideline. |
| `{{appendSystemPrompt}}` | Text passed through pi append-system-prompt inputs. |
| `{{contextFiles}}` | Loaded context files inside `<project_specific_instructions>` XML-style blocks. |
| `{{skills}}` | Loaded skills formatted by pi when the `read` tool is active. |

Unsupported variables are removed from the rendered prompt. `{{toolsets}}` is expanded only where the template contains it: a custom template that omits it receives no trigger catalog. Before values are built, active tools are reconciled; the catalog contains only loaded, still-deferred toolsets with at least one tool allowed for the current agent.

## Template example

```md
You are an expert coding assistant.

Available toolsets:
{{toolsets}}

Available tools:
{{tools}}

Guidelines:
{{toolGuidelines}}

Additional instructions:
{{appendSystemPrompt}}

Project context:
{{contextFiles}}

{{skills}}

Current date: {{date}}
Current working directory: {{cwd}}
```
