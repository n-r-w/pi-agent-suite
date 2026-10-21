# system-prompt

## Purpose

When Pi has no custom prompt, `system-prompt` replaces Pi's base system prompt with a Markdown template. The template can include runtime values such as the current date, working directory, tool guidelines, deferred-toolset triggers, and loaded project context. Tool names, descriptions, and parameter schemas reach the model through the provider tool payload instead of the template.

If Pi supplies a nonempty custom prompt, the extension preserves the prompt that Pi builds. This applies with both the bundled template and configured custom templates. Custom-prompt sources are CLI `--system-prompt` text or files, a trusted project's `.pi/SYSTEM.md`, and the Pi agent directory's `SYSTEM.md`. The extension also preserves council participant custom prompts. An empty custom-prompt string permits template rendering.

Before preserving a custom prompt, the ready-template handler still reconciles active tools. Runtime composition still appends the selected-agent prompt and eligible tool prompt contributions. Tool availability and these contributions remain subject to runtime policy.

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
| `templateFile` | Absolute or home-prefixed file path string | No | Bundled system prompt template | Markdown template file used as the system prompt. Plain relative paths are rejected. |

Home-prefixed paths accept `~`, `$HOME`, or `${HOME}`, either alone or followed by `/...`. Other environment variables are not expanded.

Only these parameters are accepted.

If the config file is missing, the extension uses the bundled system prompt template. If the config file is invalid or the template file cannot be read, pi keeps its original system prompt.

## Template variables

Use variables in the template as `{{variableName}}`. Whitespace inside braces is allowed, such as `{{ date }}`.

Supported variables:

| Variable | Inserts |
| --- | --- |
| `{{date}}` | Local date in `YYYY-MM-DD` format. |
| `{{cwd}}` | Current working directory with `/` path separators. |
| `{{toolsets}}` | Eligible deferred toolsets as `<toolsets>` XML, one `<toolset name="…" description="…"/>` per entry. It is empty when none are eligible. Attribute values XML-escape `&`, `<`, `>`, `"`, and `'`. |
| `{{toolGuidelines}}` | Shared guidance for active, visible tools, followed by global guidance. The formatter renders each nonempty normalized contribution once as a bullet. |
| `{{appendSystemPrompt}}` | Text passed through pi append-system-prompt inputs. |
| `{{contextFiles}}` | Loaded context files inside `<project_specific_instructions>` XML-style blocks. |
| `{{skills}}` | Loaded skills as `<available_skills>` XML when the `read` tool is active, one `<skill>` with `<name>`, `<description>`, and `<location>` per entry. Skills with `disable-model-invocation` are omitted. It is empty when no skill remains. Values XML-escape `&`, `<`, `>`, `"`, and `'`. |

Unsupported variables are removed from the rendered prompt. `{{toolsets}}` is expanded only where the template contains it: a custom template that omits it receives no trigger catalog. Before values are built, active tools are reconciled; the catalog contains only loaded, still-deferred toolsets with at least one tool allowed for the current agent. Registered tools activated by other extensions after startup remain available on later turns unless a current agent or toolset policy excludes them. Observed external deactivation is respected. Deactivation of a tool already hidden by policy cannot be observed through Pi's active-tool list; an explicit owner replacement can still retire that tool.

For `{{toolGuidelines}}`, the formatter reads each active tool's contributions from `options.toolGuidelines` in the order returned by `pi.getActiveTools()` after runtime policy reconciliation. It excludes names in `options.hiddenTools`, then appends global `options.promptGuidelines` independently of tool selection. It trims each contribution, removes empty results, and retains the first occurrence of each normalized value. Contributions from inactive or hidden tools are excluded even when Pi retains their metadata.

For example, if two active, visible tools contribute `" SHARED_MARKER "` and `"SHARED_MARKER"`, and the global guidelines contain `" GLOBAL_MARKER "`, `{{toolGuidelines}}` renders `- SHARED_MARKER` followed by `- GLOBAL_MARKER` on separate lines.

## Template example

```md
You are an expert coding assistant.

Available toolsets:
{{toolsets}}

Tool guidelines:
{{toolGuidelines}}

Additional instructions:
{{appendSystemPrompt}}

Project context:
{{contextFiles}}

{{skills}}

Current date: {{date}}
Current working directory: {{cwd}}
```
