# main-agent-selection

## Purpose

`main-agent-selection` allows you to create and select agents with a preconfigured prompt, model, thinking level, allowed tools list, and allowed callable subagents list.

## Configuration

Preferred file: `~/.pi/agent/agent-suite/agent-selection/config.json`.

Legacy fallback file: `~/.pi/agent/config/main-agent-selection.json`.

Full example:

```json
{
  "enabled": true
}
```

## Config parameters

| Name | Type or shape | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | Boolean | No | `true` | Enables `/agent` and `Ctrl+Shift+A`. Set to `false` to disable this extension. |

## Agent definitions

Global agent files are Markdown files in `~/.pi/agent/agent-suite/agent-selection/agents/*.md`. A project can add or replace agents with `<cwd>/.pi/agents/*.md`.

The registry follows these rules:

- Both directories use the same file format and support `main`, `subagent`, and `both`.
- Agent IDs are NFC-normalized and matched exactly, including case.
- IDs may use any Unicode language, internal spaces, and punctuation. They must be non-empty, trimmed, and single-line.
- A project file replaces the exact matching global file before its contents are parsed.
- An invalid project file makes only that exact agent identity unavailable instead of exposing the global definition.
- Multiple project files with the same NFC-normalized ID make only that ID unavailable.
- Agent directories are flat. Nested files are not loaded.
- A missing project agent directory leaves the global registry unchanged.

Full example:

```md
---
description: Reviews code and checks implementation risks.
type: both
model:
  id: openai-codex/gpt-5-codex
  thinking: high
tools:
  - read
  - bash
  - mymcp_*
agents:
  - Researcher
  - Reviewer
---
You are a code review agent. Check correctness, risks, and missing validation.
```

## Agent definition fields

| Name | Type or shape | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `description` | Single-line string | No | Empty string | Short text shown in the selector. |
| `type` | `main`, `subagent`, or `both` | No | `main` | Controls where the agent can be used. `main` and `both` agents are available in `/agent`. |
| `model` | Object with optional `id` and `thinking` fields | No | Not set | Sets the model options applied when this main agent is selected. |
| `model.id` | Non-empty string | No | Not set | Selects the model for this main agent. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `model.thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | No | Not set | Sets the thinking level for this main agent. The selected model must support the requested level. |
| `tools` | Array of unique non-empty strings | No | Not set | Allows exact tool names or wildcard tool patterns for this main agent. The full wildcard `*` is not allowed. |
| `workflows` | Array of unique single-line workflow IDs | No | Not set | Allows activation of exact NFC-normalized catalog workflows; `[]` allows no new activation, while omission allows all catalog workflows. This field does not block the current active workflow; `tools` still controls workflow operations. |
| `agents` | Array of unique single-line agent IDs | No | Not set | Allows the listed exact NFC-normalized subagents when this main agent is selected. |
| Markdown body | Markdown text after frontmatter | No | Empty after trimming | Becomes the main-agent prompt. |

Only `main` and `both` agent definitions appear in the main-agent selector. `subagent` is used together with the [run-subagent](run-subagent.md) extension.

## Usage

- Run `/agent` to open the selector.
- Run `/agent <agent-id>` to select an agent by file name without the `.md` extension.
- Run `/agent none` to clear the selected main agent for the current working directory.
- Press `Ctrl+Shift+A` to open the selector.
- Agent ID matching is exact and case-sensitive after NFC normalization. Selector text search remains case-insensitive.

## CLI flags

| Flag | Type | Description |
| --- | --- | --- |
| `--agent <id>` | String | Applies the agent with the matching ID for the current session only, without persisting to disk. Takes priority over any previously selected agent. |
| `--agent none` | String | Clears the main agent contribution for the current session without writing to disk. |

When `--agent` is set, disk-based agent restoration at session start is skipped. Invalid agent IDs produce an error visible in all modes, including `-p` (print) mode via stderr. The flag is ignored in child subagent processes.
