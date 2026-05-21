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

Agent files are Markdown files in `~/.pi/agent/agent-suite/agent-selection/agents/*.md`.

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
| `description` | String | No | Empty string | Short text shown in the selector. |
| `type` | `main`, `subagent`, or `both` | No | `main` | Controls where the agent can be used. `main` and `both` agents are available in `/agent`. |
| `model` | Object with optional `id` and `thinking` fields | No | Not set | Sets the model options applied when this main agent is selected. |
| `model.id` | String in `provider/model` form | No | Not set | Selects the model for this main agent. |
| `model.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | No | Not set | Sets the thinking level for this main agent. |
| `tools` | Array of unique non-empty strings | No | Not set | Allows exact tool names or wildcard tool patterns for this main agent. The full wildcard `*` is not allowed. |
| `agents` | Array of unique non-empty strings | No | Not set | Allows the listed subagents when this main agent is selected. |
| Markdown body | Markdown text after frontmatter | No | Empty after trimming | Becomes the main-agent prompt. |

Only `main` and `both` agent definitions appear in the main-agent selector. `subagent` is used together with the [run-subagent](run-subagent.md) extension.

## Usage

- Run `/agent` to open the selector.
- Run `/agent <agent-id>` to select an agent by file name without the `.md` extension.
- Run `/agent none` to clear the selected main agent for the current working directory.
- Press `Ctrl+Shift+A` to open the selector.
- Agent ID matching is case-insensitive.
