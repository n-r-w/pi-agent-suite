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

## Role sections

Use `{{#mainAgent}}...{{/mainAgent}}` for main-agent text and `{{#childAgent}}...{{/childAgent}}` for child-agent text. The extension includes text outside sections for both process kinds. It includes the matching role's sections and omits the other role's sections. Sections may repeat and appear inline. Whitespace inside the braces is allowed, as with variables.

The extension chooses the process kind for each agent run, before it renders the template. The process is a child agent in either of these cases:

- `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` equals `1`. The extension reads the variable once when it loads, and both `run-subagent` and `convene-council` set this shared marker for their children.
- The process was started with `pi --subagent <id>`. `run-subagent` registers this flag and reports its value to the extension. A launched subagent has no Pi parent and no marker, so other extensions treat it as a root process, but it receives the child-agent sections.

In every other case, including an absent variable and an absent flag, the extension treats the process as a main agent. Custom prompts take precedence over role selection.

For example, the extension renders `C{{#mainAgent}}M{{/mainAgent}}{{#childAgent}}S{{/childAgent}}` as `CM` in a main process and `CS` in a child process.

If a line contains only one section marker and optional spaces or tabs, the extension removes the entire line, including its LF or CRLF line break. It also removes a final marker-only line without a line break. For example, `A\r\n {{#mainAgent}}\r\nM\r\n{{/mainAgent}}\r\nZ` renders as `A\r\nM\r\nZ` in a main process. The extension preserves inline surrounding text and the bytes of selected text.

The extension selects sections before substituting variables. Therefore, section markers in inserted runtime values remain literal text. For example, if `cwd` contains `/tmp/{{#childAgent}}x{{/childAgent}}`, the extension inserts that entire value for `{{cwd}}` in either process kind. Templates without section markers retain their variable-rendering behavior.

When loading the template, the extension validates all sections. If it finds an unmatched opening or closing marker, a mismatched closing marker, a nested section, or an unknown section kind, it rejects the template. For example, `{{#mainAgent}}M{{/childAgent}}` is invalid. The extension uses its startup warning path to report the issue and retains Pi's original prompt. For ordinary unsupported variables, it uses the warning path and removes those variables during rendering.

## Bundled rule groups

For sessions without a custom prompt, both process kinds receive the system, role, safety, execution-limit, skill, toolset, and tool-guideline blocks, plus append-system-prompt text and project context.

Main agents also receive the conversation rules: goal guard, scope control, formatting, and user communication, including the question template. Scope-control rule 3 requires a separate finding for every defect outside the task found by the main agent or another agent. This includes pre-existing defects and defects without an effect on the task.

The main agent reports each finding in the first message ending its turn. Each finding describes the initiating action, actual and expected behavior, file, triggering condition, proposed fix, and each unchecked fact. The main agent takes facts from the named code. Reproduction, fix design, and modification require user approval.

Child agents receive the `defects_outside_task` block at scope control's position. This block requires the child agent to report a separate finding with the file, triggering condition, and observed behavior for each defect outside the task. Reproduction, fix design, and modification require caller approval. The extension omits the conversation rules from child-agent prompts.

## Template example

```md
You are an expert coding assistant.

{{#mainAgent}}
Work with the user to clarify their goal and complete the agreed task.
{{/mainAgent}}

{{#childAgent}}
Complete the assigned task and report the result to the caller.
{{/childAgent}}

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
