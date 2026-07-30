# Pi Agent Suite

Pi Agent Suite helps you handle complex software tasks without turning one model conversation into a bottleneck. It lets you work through specialized agents, delegate focused tasks, request independent review, and keep long-running sessions useful as context grows.

**Compact subagents TUI:**

![Compact subagents TUI](https://raw.githubusercontent.com/n-r-w/pi-agent-suite/main/docs/images/subagents-tui-compact.png)

**Full subagents TUI (activated via `/subagents` or `Ctrl+Shift+G`):**

![Full subagents TUI](https://raw.githubusercontent.com/n-r-w/pi-agent-suite/main/docs/images/subagents-tui.png)

## Core ideas

### Agent system

Choose a main agent that matches the job. It can complete the task directly, delegate focused work to specialized subagents, ask an independent advisor, or convene a two-model council. The main agent remains responsible for combining the results into one coherent answer.

Create reusable specialists for different kinds of work, then extend or replace them for a specific project. Delegated tasks can run independently, and saved subagent work can be continued later instead of started again.

Learn more: [main-agent-selection](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/main-agent-selection.md), [run-subagent](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/run-subagent.md), [consult-advisor](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/consult-advisor.md), and [convene-council](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/convene-council.md).

### Long-context management

Long software tasks accumulate tool output, decisions, and intermediate work. Pi Agent Suite uses two complementary mechanisms to keep the model focused and let the same session continue for longer.

| Mechanism | When it helps | What you get |
| --- | --- | --- |
| Context projection | While a session is growing | Bulky old tool results become concise summaries, leaving more room for current work. |
| Custom compaction | Near the context limit or after overflow | Earlier work is condensed while recent task context is retained, so the session can continue. |

Projection reduces noise and postpones compaction. Compaction restores working space when the context limit is reached. Together they reduce overflow interruptions and the need to restart work in a new session.

#### Why custom compaction instead of pi's standard compaction?

Standard pi compaction prepares a fixed summarization request and reduces each large tool result to its first 2,000 characters. If the remaining history is still too large for the summarization model, compaction itself can fail or lose useful information from later parts of those results.

Custom compaction keeps pi's selected recent context, but changes how older history is processed:

- semantic projection summaries replace arbitrary tool-result prefixes when available;
- oversized history is reduced in bounded stages until the summarization request fits;
- the resulting summary is checked against the next main-model request and its response reserve.

The result is the same automatic compaction workflow, but it can recover from histories that standard compaction cannot summarize safely.

Learn more: [context-projection](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/context-projection.md) and [custom-compaction](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/custom-compaction.md).

## Quick start

Install from npm:

```bash
pi install npm:pi-agent-suite
```

Run from source:

```bash
git clone https://github.com/n-r-w/pi-agent-suite.git
cd pi-agent-suite
pi -e ./pi-package
```

Install from source for all pi sessions:

```bash
pi install ./pi-package
```

Manual package entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-agent-suite"]
}
```

Extension settings are stored under:

```text
~/.pi/agent/agent-suite/
```

Set `PI_AGENT_SUITE_DIR` to use another suite directory.

## Recommended setup

1. Start with the default extensions. They provide agent selection, subagents, advisor calls, custom compaction, footer status, prompt helpers, and notifications.
2. Create [subagent definitions](#agent-files) for your common work modes and specialized tasks.
3. Add optional extensions only when you need their specific behavior:
  - Set most capable model with high thinking level for `consult-advisor`
  - Enable `codex-quota` when you use OpenAI Codex and want quota status in the footer.
  - Use `codex-fast` when you want to toggle Codex fast mode with `/fast` or `Ctrl+Alt+F`.
  - Enable `codex-verbosity` when you want to control Codex answer detail.
  - Configure `mcp-wrapper` when you want MCP server tools inside pi.
  - Enable `context-projection`. Use summary mode with a fast model in `summary.model` (e.g. `gpt-5.4-mini`, `gpt-5.3-codex-spark`). By default, missing L3 summaries are generated before custom compaction.
  - Enable `convene-council`. Do not rely on current session model defaults. Configure `llm1` and `llm2` with the most capable available models and set `model.thinking` to `high` or `xhigh`. Use two different models when possible.
4. Recommended MCP servers:
  - `https://github.com/n-r-w/team-mcp` for collaboration desks between agents.
  - `https://github.com/n-r-w/asteria` for symbolic code search.

## Extensions

| Extension | Default behavior | What it does | Quick settings | Details |
| --- | --- | --- | --- | --- |
| `system-prompt` | Enabled | Replaces pi's base system prompt with a Markdown template and runtime variables. | `system-prompt/config.json`: `enabled`, `templateFile`. | [docs/extensions/system-prompt.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/system-prompt.md) |
| `project-rules` | Enabled | Appends recursive project Markdown rules from `.pi/rules`; global `~/.pi` storage is excluded. | `project-rules/config.json`: `enabled`, `rulesDir`. | [docs/extensions/project-rules.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/project-rules.md) |
| `mcp-wrapper` | No MCP tools until configured | Registers tools from configured MCP servers, caches tool metadata, and adds `/mcp-refresh`. | `mcp-wrapper/config.json`: `settings.enabled`, `settings.timeouts`, `mcpServers`. | [docs/extensions/mcp-wrapper.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/mcp-wrapper.md) |
| `enable-tools` | Enabled | Enables configured built-in tools such as `grep`, `find`, and `ls`. | `enable-tools/config.json`: `enabled`, `include`, `exclude`. | [docs/extensions/enable-tools.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/enable-tools.md) |
| `footer` | Enabled | Shows project, optional git branch, runtime details, and additional extension statuses. | `footer/config.json`: `enabled`, model display options, `showApiCost`, `showGitBranch`, `showAdditionalStatusLine`. | [docs/extensions/footer.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/footer.md) |
| `codex-fast` | Disabled | Toggles fast mode for supported OpenAI Codex requests and marks the footer model with `-F`. | State: `codex-fast/state.json`. Toggle with `/fast` or `Ctrl+Alt+F`. | [docs/extensions/codex-fast.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/codex-fast.md) |
| `codex-verbosity` | Disabled | Adds `text.verbosity` to OpenAI Codex requests. | `codex-verbosity/config.json`: `enabled`, `verbosity` (`low`, `medium`, `high`). | [docs/extensions/codex-verbosity.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/codex-verbosity.md) |
| `codex-quota` | Disabled | Shows OpenAI Codex quota status in the footer. | `codex-quota/config.json`: `enabled`, `refreshInterval`, `retryAttempts`, `retryInterval`. | [docs/extensions/codex-quota.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/codex-quota.md) |
| `custom-compaction` | Enabled | Replaces fixed-request pi compaction with bounded adaptive summarization that can reduce oversized history before the final summary. | `custom-compaction/config.json`: `enabled`, `model`, `reasoning`, prompt file paths, `retry`. | [docs/extensions/custom-compaction.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/custom-compaction.md) |
| `context-projection` | Disabled | Replaces old large non-critical tool results in provider context with an omitted notice or summary; requires valid enabled custom compaction. | `context-projection/config.json`: `enabled`, `projectCompactionSource`, projection thresholds, recent-turn protection, `omittedNotice`, `summaryNotice`, `summary`. | [docs/extensions/context-projection.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/context-projection.md) |
| `mermaid` | Enabled in TUI mode | Renders supported Mermaid blocks from assistant responses as durable ASCII previews. | Fixed safety limits; no configuration. | [docs/extensions/mermaid.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/mermaid.md) |
| `completion-sound` | Enabled | Plays a sound after successful top-level agent runs. | `completion-sound/config.json`: `enabled`, `command`, `args`, `volume`. | [docs/extensions/completion-sound.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/completion-sound.md) |
| `cmux` | Enabled | Sends [cmux](https://cmux.com/) notification after successful top-level agent runs. | `cmux/config.json`: `enabled`. | [docs/extensions/cmux.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/cmux.md) |
| `main-agent-selection` | Enabled | Adds `/agent` and `Ctrl+Shift+A` for selecting reusable main agents. | `agent-selection/config.json`: `enabled`, `diagnosticsEnabled`. | [docs/extensions/main-agent-selection.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/main-agent-selection.md) |
| `run-subagent` | Enabled | Adds `subagent_start`, `subagent_steer`, `subagent_wait`, and saved-session `subagent_query` tools plus the `/subagents` (`Ctrl+Shift+G`) management screen; normal mode has no widget. | `run-subagent/config.json`: `enabled`, `maxDepth`, descriptions, and query model/system prompt. | [docs/extensions/run-subagent.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/run-subagent.md) |
| `structured-prompt` | Enabled | Adds `/prompt` and `Ctrl+Alt+P` for building structured user requests. | `structured-prompt/config.json`: `enabled`. | [docs/extensions/structured-prompt.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/structured-prompt.md) |
| `ask-llm` | Enabled | Adds `/ask` for one-off model questions that are not saved to the current session. | `ask-llm/config.json`: `enabled`, `model`, `systemPromptFile`, `retry`. | [docs/extensions/ask-llm.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/ask-llm.md) |
| `consult-advisor` | Enabled | Adds the `consult_advisor` tool for an independent model opinion. | `consult-advisor/config.json`: `enabled`, `model`, `promptFile`, `debugPayloadFile`, `retry`. | [docs/extensions/consult-advisor.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/consult-advisor.md) |
| `convene-council` | Disabled | Adds the `convene_council` tool for a bounded two-participant model discussion. | `convene-council/config.json`: `enabled`, `llm1`, `llm2`, `participantIterationLimit`, `finalAnswerParticipant`, `responseDefectRetries`, `tools`. | [docs/extensions/convene-council.md](https://github.com/n-r-w/pi-agent-suite/blob/main/docs/extensions/convene-council.md) |

## Agent files

Agent files define reusable work modes and subagents for `main-agent-selection` and `run-subagent`.

Global location:

```text
~/.pi/agent/agent-suite/agent-selection/agents/
```

Project extension and overrides:

```text
<project>/.pi/agents/
```

Project agent IDs replace matching global IDs case-insensitively. Invalid or ambiguous project definitions make only the matching ID unavailable.

Basic rules:

- Each agent is one `.md` file.
- The agent ID is the file name without `.md`.
- The settings block goes at the top between `---` lines.
- The Markdown text after the settings block is the agent prompt.
- `type` can be `main`, `subagent`, or `both`.
- `tools` can list exact tool names or narrow wildcard patterns. Full wildcard `*` is not allowed.
- Each child resolves `tools` against its own runtime catalog, independently of its caller's tools.
- `agents` limits which subagents agent may call.

Example:

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
  - grep
  - subagent_*
  - mymcp_*
agents:
  - Researcher
  - Reviewer
---
You are a code review agent. Check correctness, risks, and missing validation.
```

Allowed thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Changelog

[See changelog.md](https://github.com/n-r-w/pi-agent-suite/blob/main/changelog.md)