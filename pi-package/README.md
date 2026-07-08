# Pi Agent Suite

Pi Agent Suite adds pi extensions for agent profiles, subagents, advisor tools, context management, notifications, MCP tools, and prompt helpers.

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

Start with the default extensions. They provide agent selection, subagents, advisor calls, custom compaction, footer status, prompt helpers, and notifications.

Add optional extensions only when you need their specific behavior:

- Set most capable model with high thinking level for `consult-advisor`
- Enable `codex-quota` when you use OpenAI Codex and want quota status in the footer.
- Use `codex-fast` when you want to toggle Codex fast mode with `/fast` or `Ctrl+Alt+F`.
- Enable `codex-verbosity` when you want to control Codex answer detail.
- Configure `mcp-wrapper` when you want MCP server tools inside pi.
- Enable `url-scheme` when you want final answer file references to open in your editor.
- Enable `context-projection`. Use summary mode with a fast model in `summary.model` (e.g. `gpt-5.4-mini`, `gpt-5.3-codex-spark`).
- Enable `convene-council`. Do not rely on current session model defaults. Configure `llm1` and `llm2` with the most capable available models and set `model.thinking` to `high` or `xhigh`. Use two different models when possible.

Recommended MCP servers:

- `https://github.com/n-r-w/team-mcp` for collaboration desks between agents.
- `https://github.com/n-r-w/asteria` for symbolic code search.

## Extensions

| Extension | Default behavior | What it does | Quick settings | Details |
| --- | --- | --- | --- | --- |
| `system-prompt` | Enabled | Replaces pi's base system prompt with a Markdown template and runtime variables. | `system-prompt/config.json`: `enabled`, `templateFile`. | [docs/extensions/system-prompt.md](docs/extensions/system-prompt.md) |
| `project-rules` | Enabled | Appends recursive project Markdown rules from `.pi` to the final system prompt. | `project-rules/config.json`: `enabled`, `rulesDir`. | [docs/extensions/project-rules.md](docs/extensions/project-rules.md) |
| `mcp-wrapper` | No MCP tools until configured | Registers tools from configured MCP servers, caches tool metadata, and adds `/mcp-refresh`. | `mcp-wrapper/config.json`: `settings.enabled`, `settings.timeouts`, `mcpServers`. | [docs/extensions/mcp-wrapper.md](docs/extensions/mcp-wrapper.md) |
| `enable-tools` | Enabled | Enables configured built-in tools such as `grep`, `find`, and `ls`. | `enable-tools/config.json`: `enabled`, `include`, `exclude`. | [docs/extensions/enable-tools.md](docs/extensions/enable-tools.md) |
| `footer` | Enabled | Shows project, quota, cost, selected agent, model, projection, MCP errors, and context usage. | `footer/config.json`: `enabled`, `showProvider`, `showModel`, `showThinkingLevel`, `showApiCost`. | [docs/extensions/footer.md](docs/extensions/footer.md) |
| `codex-fast` | Disabled | Toggles fast mode for supported OpenAI Codex requests and marks the footer model with `-F`. | State: `codex-fast/state.json`. Toggle with `/fast` or `Ctrl+Alt+F`. | [docs/extensions/codex-fast.md](docs/extensions/codex-fast.md) |
| `codex-verbosity` | Disabled | Adds `text.verbosity` to OpenAI Codex requests. | `codex-verbosity/config.json`: `enabled`, `verbosity` (`low`, `medium`, `high`). | [docs/extensions/codex-verbosity.md](docs/extensions/codex-verbosity.md) |
| `codex-quota` | Disabled | Shows OpenAI Codex quota status in the footer. | `codex-quota/config.json`: `enabled`, `refreshInterval`, `retryAttempts`, `retryInterval`. | [docs/extensions/codex-quota.md](docs/extensions/codex-quota.md) |
| `custom-compaction` | Enabled | Uses custom prompts for pi conversation compaction. | `custom-compaction/config.json`: `enabled`, `model`, `reasoning`, prompt file paths, `retry`. | [docs/extensions/custom-compaction.md](docs/extensions/custom-compaction.md) |
| `context-projection` | Disabled | Replaces old large non-critical tool results in provider context with an omitted notice or summary. | `context-projection/config.json`: `enabled`, projection thresholds, recent-turn protection, `omittedNotice`, `summaryNotice`, `summary`. | [docs/extensions/context-projection.md](docs/extensions/context-projection.md) |
| `completion-sound` | Enabled | Plays a sound after successful top-level agent runs. | `completion-sound/config.json`: `enabled`, `command`, `args`, `volume`. | [docs/extensions/completion-sound.md](docs/extensions/completion-sound.md) |
| `cmux` | Enabled | Sends [cmux](https://cmux.com/) notification after successful top-level agent runs. | `cmux/config.json`: `enabled`. | [docs/extensions/cmux.md](docs/extensions/cmux.md) |
| `url-scheme` | Disabled | Converts final answer file references into editor links. | `url-scheme/config.json`: `enabled`, `scheme` (`vscode`, `cursor`, `webstorm`, `idea`, `pycharm`, `phpstorm`, `txmt`, `bbedit`, `zed`). | [docs/extensions/url-scheme.md](docs/extensions/url-scheme.md) |
| `main-agent-selection` | Enabled | Adds `/agent` and `Ctrl+Shift+A` for selecting reusable main agents. | `agent-selection/config.json`: `enabled`, `diagnosticsEnabled`. | [docs/extensions/main-agent-selection.md](docs/extensions/main-agent-selection.md) |
| `run-subagent` | Enabled | Adds the `run_subagent` tool for running subagents in child pi processes. | `run-subagent/config.json`: `enabled`, `maxDepth`, `widgetLineBudget`. | [docs/extensions/run-subagent.md](docs/extensions/run-subagent.md) |
| `structured-prompt` | Enabled | Adds `/prompt` and `Ctrl+Alt+P` for building structured user requests. | `structured-prompt/config.json`: `enabled`. | [docs/extensions/structured-prompt.md](docs/extensions/structured-prompt.md) |
| `ask-llm` | Enabled | Adds `/ask` for one-off model questions that are not saved to the current session. | `ask-llm/config.json`: `enabled`, `model`, `systemPromptFile`, `retry`. | [docs/extensions/ask-llm.md](docs/extensions/ask-llm.md) |
| `consult-advisor` | Enabled | Adds the `consult_advisor` tool for an independent model opinion. | `consult-advisor/config.json`: `enabled`, `model`, `promptFile`, `debugPayloadFile`, `retry`. | [docs/extensions/consult-advisor.md](docs/extensions/consult-advisor.md) |
| `convene-council` | Disabled | Adds the `convene_council` tool for a bounded two-participant model discussion. | `convene-council/config.json`: `enabled`, `llm1`, `llm2`, `participantIterationLimit`, `finalAnswerParticipant`, `responseDefectRetries`, `tools`. | [docs/extensions/convene-council.md](docs/extensions/convene-council.md) |

## Agent files

Agent files define reusable work modes and subagents for `main-agent-selection` and `run-subagent`.

Default location:

```text
~/.pi/agent/agent-suite/agent-selection/agents/
```

Basic rules:

- Each agent is one `.md` file.
- The agent ID is the file name without `.md`.
- The settings block goes at the top between `---` lines.
- The Markdown text after the settings block is the agent prompt.
- `type` can be `main`, `subagent`, or `both`.
- `tools` can list exact tool names or narrow wildcard patterns. Full wildcard `*` is not allowed.
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
  - mymcp_*
agents:
  - Researcher
  - Reviewer
---
You are a code review agent. Check correctness, risks, and missing validation.
```

Allowed thinking values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

## Changelog

### 1.15.0 - 2026-07-08

- Breaking change: removed `context-projection.placeholder`. Use `omittedNotice` for projected results without summaries and `summaryNotice` for summary blocks.
- `context-projection` now fails startup when `placeholder` remains in config, so stale configs show a direct migration error instead of only `CP!` in the footer.
- Updated default projection notices to distinguish fully omitted results from results that include summaries.
- Fixed `custom-compaction` overflow retry recovery when retained context ends with an assistant error. It now summarizes the retained tail and keeps the retry boundary at a non-message entry so pi can continue.

### 0.14.0 - 2026-07-07

- Removed `context-overflow`. Native pi now handles context overflow recovery: it detects provider overflow errors, runs compaction, and continues the interrupted work. Keeping this extension caused duplicate compaction paths and could stop continuation after Codex context overflow.
- Updated `footer` to read native pi compaction settings. Context usage now renders as `used/threshold/window` when native compaction is enabled, where `threshold = contextWindow - compaction.reserveTokens`.
- Refined `context-projection` summaries. Summary prompts now require structured sections, preserve evidence from tool results, and treat tool output as data instead of instructions.
- Removed square brackets from the default `context-projection` placeholder: `Result omitted. Run tool again if you want to see it`.
- Refined bundled system and advisor prompts with stricter evidence handling, blocker handling, source-of-truth rules, escalation rules, and refactoring constraints.

Use native pi `compaction.reserveTokens` to configure the displayed compaction threshold. `custom-compaction` remains enabled and still replaces pi's compaction summary with this package's custom prompt.
