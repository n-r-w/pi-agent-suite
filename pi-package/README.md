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
- Enable `context-projection`. Use summary mode with a fast model in `summary.model` (e.g. `gpt-5.4-mini`, `gpt-5.3-codex-spark`).
- Enable `convene-council`. Do not rely on current session model defaults. Configure `llm1` and `llm2` with the most capable available models and set `model.thinking` to `high` or `xhigh`. Use two different models when possible.

Recommended MCP servers:

- `https://github.com/n-r-w/team-mcp` for collaboration desks between agents.
- `https://github.com/n-r-w/asteria` for symbolic code search.

## Extensions

| Extension | Default behavior | What it does | Quick settings | Details |
| --- | --- | --- | --- | --- |
| `system-prompt` | Enabled | Replaces pi's base system prompt with a Markdown template and runtime variables. | `system-prompt/config.json`: `enabled`, `templateFile`. | [docs/extensions/system-prompt.md](docs/extensions/system-prompt.md) |
| `project-rules` | Enabled | Appends recursive project Markdown rules from `.pi/rules`; global `~/.pi` storage is excluded. | `project-rules/config.json`: `enabled`, `rulesDir`. | [docs/extensions/project-rules.md](docs/extensions/project-rules.md) |
| `mcp-wrapper` | No MCP tools until configured | Registers tools from configured MCP servers, caches tool metadata, and adds `/mcp-refresh`. | `mcp-wrapper/config.json`: `settings.enabled`, `settings.timeouts`, `mcpServers`. | [docs/extensions/mcp-wrapper.md](docs/extensions/mcp-wrapper.md) |
| `enable-tools` | Enabled | Enables configured built-in tools such as `grep`, `find`, and `ls`. | `enable-tools/config.json`: `enabled`, `include`, `exclude`. | [docs/extensions/enable-tools.md](docs/extensions/enable-tools.md) |
| `footer` | Enabled | Shows project, quota, cost, selected agent, model, projection, MCP errors, and context usage. | `footer/config.json`: `enabled`, `showProvider`, `showModel`, `showThinkingLevel`, `showApiCost`. | [docs/extensions/footer.md](docs/extensions/footer.md) |
| `codex-fast` | Disabled | Toggles fast mode for supported OpenAI Codex requests and marks the footer model with `-F`. | State: `codex-fast/state.json`. Toggle with `/fast` or `Ctrl+Alt+F`. | [docs/extensions/codex-fast.md](docs/extensions/codex-fast.md) |
| `codex-verbosity` | Disabled | Adds `text.verbosity` to OpenAI Codex requests. | `codex-verbosity/config.json`: `enabled`, `verbosity` (`low`, `medium`, `high`). | [docs/extensions/codex-verbosity.md](docs/extensions/codex-verbosity.md) |
| `codex-quota` | Disabled | Shows OpenAI Codex quota status in the footer. | `codex-quota/config.json`: `enabled`, `refreshInterval`, `retryAttempts`, `retryInterval`. | [docs/extensions/codex-quota.md](docs/extensions/codex-quota.md) |
| `custom-compaction` | Enabled | Uses custom prompts for pi conversation compaction and summarizes large tool results before oversized compaction requests. | `custom-compaction/config.json`: `enabled`, `model`, `reasoning`, prompt file paths, `retry`, `summary`. | [docs/extensions/custom-compaction.md](docs/extensions/custom-compaction.md) |
| `context-projection` | Disabled | Replaces old large non-critical tool results in provider context with an omitted notice or summary. | `context-projection/config.json`: `enabled`, projection thresholds, recent-turn protection, `omittedNotice`, `summaryNotice`, `summary`. | [docs/extensions/context-projection.md](docs/extensions/context-projection.md) |
| `completion-sound` | Enabled | Plays a sound after successful top-level agent runs. | `completion-sound/config.json`: `enabled`, `command`, `args`, `volume`. | [docs/extensions/completion-sound.md](docs/extensions/completion-sound.md) |
| `cmux` | Enabled | Sends [cmux](https://cmux.com/) notification after successful top-level agent runs. | `cmux/config.json`: `enabled`. | [docs/extensions/cmux.md](docs/extensions/cmux.md) |
| `main-agent-selection` | Enabled | Adds `/agent` and `Ctrl+Shift+A` for selecting reusable main agents. | `agent-selection/config.json`: `enabled`, `diagnosticsEnabled`. | [docs/extensions/main-agent-selection.md](docs/extensions/main-agent-selection.md) |
| `run-subagent` | Enabled | Adds strict `run_subagent` and `resume_subagent` tools with numbered child sessions and a navigable live widget. | `run-subagent/config.json`: `enabled`, `maxDepth`, `widgetLineBudget`, separate description files. | [docs/extensions/run-subagent.md](docs/extensions/run-subagent.md) |
| `structured-prompt` | Enabled | Adds `/prompt` and `Ctrl+Alt+P` for building structured user requests. | `structured-prompt/config.json`: `enabled`. | [docs/extensions/structured-prompt.md](docs/extensions/structured-prompt.md) |
| `ask-llm` | Enabled | Adds `/ask` for one-off model questions that are not saved to the current session. | `ask-llm/config.json`: `enabled`, `model`, `systemPromptFile`, `retry`. | [docs/extensions/ask-llm.md](docs/extensions/ask-llm.md) |
| `consult-advisor` | Enabled | Adds the `consult_advisor` tool for an independent model opinion. | `consult-advisor/config.json`: `enabled`, `model`, `promptFile`, `debugPayloadFile`, `retry`. | [docs/extensions/consult-advisor.md](docs/extensions/consult-advisor.md) |
| `convene-council` | Disabled | Adds the `convene_council` tool for a bounded two-participant model discussion. | `convene-council/config.json`: `enabled`, `llm1`, `llm2`, `participantIterationLimit`, `finalAnswerParticipant`, `responseDefectRetries`, `tools`. | [docs/extensions/convene-council.md](docs/extensions/convene-council.md) |

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
  - mymcp_*
agents:
  - Researcher
  - Reviewer
---
You are a code review agent. Check correctness, risks, and missing validation.
```

Allowed thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Changelog

### v0.18.0 - 2026-07-17

- Added project-local agent definitions under `<project>/.pi/agents` for `main-agent-selection` and `run-subagent`; project definitions extend the global registry and replace matching IDs case-insensitively.
- Rebuilt callable-agent guidance and tool-call validation for the active working directory, so project overrides supply child prompts, models, thinking levels, tools, and callable subagents.
- Invalid or case-insensitively ambiguous project agent definitions now suppress only the matching global agent ID; unrelated agents remain available.
- Breaking change: changed the default `project-rules` directory from `.pi` to `.pi/rules`.
- Prevented `project-rules` from loading files in global Pi storage, including configured paths and symbolic-link targets.
- Refined bundled prompts to prohibit changing `HOME` and to prevent parallel code changes from interfering in the same project.
- Added authentication startup recovery with retry logic
- Updated Pi dependencies from `0.80.7` to `0.80.10`.

### v0.17.0 - 2026-07-15

- Breaking change: continuing a child session moved from `run_subagent` to the separately allowed `resume_subagent` tool.
- Added resumable child sessions with stable local `#N` identifiers and exact child JSONL continuation.
- Persisted logical subagent rows and browser selection across main-session restarts while preserving completed descendants.
- Added separate `runDescriptionPromptFile` and `resumeDescriptionPromptFile` settings and aligned delegation guidance with the active tool set.
- Removed the obsolete `url-scheme` extension.

### v0.16.1 - 2026-07-11
- Fixed unavailability of `max` thinking level in some tools.

### v0.16.0 - 2026-07-11

- Breaking change: `run_subagent` now requires a concise, unique `taskName` for each run.
- Added `/subagents` and `Ctrl+Shift+G` to browse runs and focus the live widget on one task.
- Reworked subagent progress rendering for nested runs, narrow terminals, Unicode text, and terminal control sequences.
- Refined bundled instructions for parallel subagent tasks, prompt structure, compatibility, and new document formats.
- Added `max` thinking level support

### v0.15.1 - 2026-07-10

- Fixed npm publishing by using the npm version bundled with Node 24 instead of upgrading to npm 12.0.0, whose published package omits `sigstore`.

### v0.15.0 - 2026-07-10

- Breaking change: replaced `context-projection.placeholder` with `omittedNotice` and `summaryNotice`; stale configurations now fail startup with a direct migration error.
- Shared tool-result summary prompts and helper logic now support `context-projection` and oversized `custom-compaction` requests.
- Fixed `custom-compaction` overflow retry recovery when retained context ends with an assistant error.
- `run-subagent` now stores child JSONL sessions with result metadata and estimates context use for zero-usage overflow errors.
- Auxiliary LLM requests and child agents now use isolated Pi-compatible UUIDv7 session IDs, fixing Luna routing through Codex OAuth.
- Updated Pi dependencies to `0.80.5`.

### v0.14.0 - 2026-07-07

- Removed `context-overflow`. Native pi now handles context overflow recovery: it detects provider overflow errors, runs compaction, and continues the interrupted work. Keeping this extension caused duplicate compaction paths and could stop continuation after Codex context overflow.
- Updated `footer` to read native pi compaction settings. Context usage now renders as `used/threshold/window` when native compaction is enabled, where `threshold = contextWindow - compaction.reserveTokens`.
- Refined `context-projection` summaries. Summary prompts now require structured sections, preserve evidence from tool results, and treat tool output as data instead of instructions.
- Removed square brackets from the default `context-projection` placeholder: `Result omitted. Run tool again if you want to see it`.
- Refined bundled system and advisor prompts with stricter evidence handling, blocker handling, source-of-truth rules, escalation rules, and refactoring constraints.
