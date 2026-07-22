# Pi Agent Suite

Pi Agent Suite helps you handle complex software tasks without turning one model conversation into a bottleneck. It lets you work through specialized agents, delegate focused tasks, request independent review, and keep long-running sessions useful as context grows.

## Core ideas

### Agent system

Choose a main agent that matches the job. It can complete the task directly, delegate focused work to specialized subagents, ask an independent advisor, or convene a two-model council. The main agent remains responsible for combining the results into one coherent answer.

Create reusable specialists for different kinds of work, then extend or replace them for a specific project. Delegated tasks can run independently, and saved subagent work can be continued later instead of started again.

Learn more: [main-agent-selection](docs/extensions/main-agent-selection.md), [run-subagent](docs/extensions/run-subagent.md), [consult-advisor](docs/extensions/consult-advisor.md), and [convene-council](docs/extensions/convene-council.md).

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

Learn more: [context-projection](docs/extensions/context-projection.md) and [custom-compaction](docs/extensions/custom-compaction.md).

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
- Enable `context-projection`. Use summary mode with a fast model in `summary.model` (e.g. `gpt-5.4-mini`, `gpt-5.3-codex-spark`). By default, missing L3 summaries are generated before custom compaction.
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
| `footer` | Enabled | Shows project, optional git branch, runtime details, and additional extension statuses. | `footer/config.json`: `enabled`, model display options, `showApiCost`, `showGitBranch`, `showAdditionalStatusLine`. | [docs/extensions/footer.md](docs/extensions/footer.md) |
| `codex-fast` | Disabled | Toggles fast mode for supported OpenAI Codex requests and marks the footer model with `-F`. | State: `codex-fast/state.json`. Toggle with `/fast` or `Ctrl+Alt+F`. | [docs/extensions/codex-fast.md](docs/extensions/codex-fast.md) |
| `codex-verbosity` | Disabled | Adds `text.verbosity` to OpenAI Codex requests. | `codex-verbosity/config.json`: `enabled`, `verbosity` (`low`, `medium`, `high`). | [docs/extensions/codex-verbosity.md](docs/extensions/codex-verbosity.md) |
| `codex-quota` | Disabled | Shows OpenAI Codex quota status in the footer. | `codex-quota/config.json`: `enabled`, `refreshInterval`, `retryAttempts`, `retryInterval`. | [docs/extensions/codex-quota.md](docs/extensions/codex-quota.md) |
| `custom-compaction` | Enabled | Replaces fixed-request pi compaction with bounded adaptive summarization that can reduce oversized history before the final summary. | `custom-compaction/config.json`: `enabled`, `model`, `reasoning`, prompt file paths, `retry`. | [docs/extensions/custom-compaction.md](docs/extensions/custom-compaction.md) |
| `context-projection` | Disabled | Replaces old large non-critical tool results in provider context with an omitted notice or summary; requires valid enabled custom compaction. | `context-projection/config.json`: `enabled`, `projectCompactionSource`, projection thresholds, recent-turn protection, `omittedNotice`, `summaryNotice`, `summary`. | [docs/extensions/context-projection.md](docs/extensions/context-projection.md) |
| `mermaid` | Enabled in TUI mode | Renders supported Mermaid blocks from assistant responses as durable ASCII previews. | Fixed safety limits; no configuration. | [docs/extensions/mermaid.md](docs/extensions/mermaid.md) |
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

### v1.0.0 - 2026-07-22

- Added separate configurable system and user prompts for intermediate compaction reduction.
- Added a configurable file-candidate prompt for selecting paths to include in `must_read_first`.
- Added goal-alignment instructions requiring clarification when goals are unclear or conflict with requirements.
- Separated intermediate reduction prompts from final summary prompts.
- Let the model select relevant files instead of appending raw file-operation lists to summaries.
- Updated compaction prompts and context rehydration instructions.
- Allowed automatic dependency retrieval and temporary-file operations without explicit approval.
- Updated `@earendil-works/pi-*` packages from `0.80.10` to `0.81.1`.
- Expanded custom-compaction tests and documentation.

### v0.20.1 - 2026-07-20

- Convene council: recover participant authentication startup races
- Context projection: fix replay projections after automatic retries

### v0.20.0 - 2026-07-19

- Replaced fixed-request custom compaction with fixed-boundary adaptive history summarization. Oversized history is reduced in bounded stages, Pi’s retained suffix stays unchanged, and both summarization and prospective main-model requests are checked against their budgets.
- Added projection-aware compaction sources. Existing semantic tool-result summaries are reused, missing L3 summaries are generated by default through `projectCompactionSource`, and individual projection failures fall back to Pi serialization.
- Added detailed progress for direct and adaptive compaction, including source projection, preliminary reduction, fragmentation, normalization, merging, retries, success, and standard-compaction fallback.
- Added persistent TUI-only compaction outcomes and configurable final-prompt file candidates so the summarizer selects relevant `must_read_first` paths while raw file lists remain in `CompactionResult.details`.
- Made enabled `context-projection` require a valid enabled `custom-compaction` configuration.
- Breaking change: removed the custom-compaction `summary` and `turnPrefixPromptFile` settings, the bundled turn-prefix prompt, and legacy custom-compaction config lookup.
- Split the adaptive compaction engine into focused source, budget, reduction, and orchestration modules.
- Strengthened the default system prompt with explicit KISS, YAGNI, and overspecification safeguards.

### v0.19.0 - 2026-07-18

- Add Mermaid ASCII rendering extension
- Add git branch and additional status line to footer
- Prevent false `openai-codex` authentication failures by serializing child Pi startup through prompt preflight while keeping agent execution parallel

### v0.18.1 - 2026-07-17

- Resolve child tool policies against their runtime catalog

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
