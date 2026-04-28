# Pi Agent Suite

## Purpose

Pi Agent Suite adds a configurable multi-agent layer to pi.

Use it to define main agents, delegate work to allowed subagents, and ask an advisor model for a second opinion. Context, Codex, and footer extensions support long-running agent sessions.

## Extensions

| Extension | Enabled by default | Why you need it |
|---|---:|---|
| `footer` | Yes | Keeps important session status visible without opening menus or logs. |
| `codex-verbosity` | No | Lets you control how detailed OpenAI Codex answers are. |
| `codex-quota` | No | Helps avoid unexpected Codex quota exhaustion during work. |
| `custom-compaction` | Yes | Keeps long conversations useful after compaction by using better summary prompts. |
| `context-projection` | No | Helps long sessions continue when old large tool outputs would otherwise fill the model context. |
| `context-overflow` | Yes | Runs compaction before the next provider request fails because the context is already too large. |
| `main-agent-selection` | Yes | Lets you switch between predefined working modes instead of repeating instructions manually. |
| `run-subagent` | Yes | Lets the main agent delegate focused tasks to subagents. |
| `consult-advisor` | Yes | Lets the main agent ask another model for an independent opinion before deciding. |

## Best practices

The most effective setup combines `main-agent-selection`, `run-subagent`, and `consult-advisor`.

Use `main-agent-selection` to choose a focused main agent for the current work. Use `run-subagent` to delegate narrow tasks to subagents. This keeps the main model focused and reduces context growth in large codebases, because investigation, extraction, review, and implementation tasks can run in separate subagent contexts.

Use `consult-advisor` when a cheaper model needs an audit from a stronger model. The main model can ask the advisor to check assumptions, risks, or decisions without paying for the stronger model on every turn.

Use `context-projection` for long tool-heavy sessions. With suitable thresholds and summary mode, it can make the usable context behave like a much larger window, often close to doubling the effective available context, without noticeable LLM quality loss when projected outputs are old or non-critical.

`consult-advisor` sends the advisor the active branch conversation messages, with recorded `context-projection` placeholders or summaries replayed instead of hidden full tool outputs. It removes the pending `consult_advisor` tool call, appends the advisor question, uses the advisor system prompt, and disables tools. If the advisor request is still too large for the advisor model context window, the tool returns a clear error instead of calling the provider.

## How to connect to pi

Install from npm:

```bash
pi install npm:pi-agent-suite
```

Or run from source:

```bash
git clone https://github.com/n-r-w/pi-agent-suite.git
cd pi-agent-suite
pi -e ./pi-package
```

To install from source for all pi sessions:

```bash
pi install ./pi-package
```

Manual settings entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-agent-suite"
  ]
}
```

Extension settings are stored in:

```text
~/.pi/agent/config/
```

## Agent files

Agent files define reusable work modes and subagents.

Location:

```text
~/.pi/agent/agents/
```

File rules:

- Each agent is one `.md` file.
- The agent ID is the file name without `.md`. Example: `CodeReview.md` becomes `CodeReview`.
- The settings block goes at the top between `---` lines.
- The Markdown text after the settings block is the agent prompt.
- Only the fields listed below are supported.
- List values must be unique non-empty strings.
- Files with unsupported keys or invalid values are ignored.

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
  - edit
agents:
  - Researcher
  - Reviewer
---
You are a code review agent. Check correctness, risks, and missing validation.
```

Fields:

- `description`: optional text shown in agent lists.
- `type`: optional. Default: `main`. Allowed values: `main`, `subagent`, `both`.
- `model.id`: optional model ID in `provider/model` form.
- `model.thinking`: optional thinking level. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `tools`: optional list of allowed tools or narrow wildcard patterns. Exact tool names such as `read` are allowed. Narrow wildcard patterns such as `yandex_tracker_*` are allowed. Full wildcard `*` is not allowed. Empty list means no tools.
- `agents`: optional list of subagent IDs that this main agent may call through `run_subagent`. Missing list means all callable subagents are available.

Agent type behavior:

- `main`: appears in `/agent` and can be selected as the main working mode.
- `subagent`: can be called by `run_subagent` but does not appear in `/agent`.
- `both`: appears in `/agent` and can also be called by `run_subagent`.

## Extension details

### `footer`

Why you need it:

- Shows the current session state in one compact line.
- Makes it easier to notice the selected agent, model, quota, context usage, and MCP errors while working.

Config file: `~/.pi/agent/config/footer.json`

Options:

- `enabled`: default `true`. Enables or disables the custom footer.
- `showProvider`: default `true`. Shows the provider name.
- `showModel`: default `true`. Shows the model name.
- `showThinkingLevel`: default `true`. Shows the thinking level.

How it works:

- Installs a custom footer when a pi session starts.
- Shows these footer parts: project, Codex quota, selected agent, model, context projection, MCP errors, context usage.
- Shortens long text so the footer fits the terminal width.

Example:

```text
workspace · 100%/5h 65%/5d · Coder · openai-codex/gpt-5.5/high · ~80k · 70k/262k/272k
```

| Segment | Example | Meaning |
| --- | --- | --- |
| Project | `workspace` | Current repository or directory. |
| Codex quota | `100%/5h 65%/5d` | Remaining quota and reset windows. |
| Agent | `Coder` | Selected main agent. |
| Model | `openai-codex/gpt-5.5/high` | Provider, model, and reasoning level. |
| Projection | `~80k` | Tokens saved by context projection. |
| Context | `70k/262k/272k` | Current context use, context-overflow threshold, and maximum context size. |

MCP error statuses may appear before the context segment when an MCP server reports a problem.

### `codex-verbosity`

Why you need it:

- Lets you choose whether Codex should answer briefly or with more detail.
- Helps match answer length to the task: quick checks, normal coding, or detailed reasoning.

Config file: `~/.pi/agent/config/codex-verbosity.json`

Options:

- `enabled`: default `false`. Must be `true` to change Codex requests.
- `verbosity`: default `medium`. Allowed values: `low`, `medium`, `high`.

How it works:

- Works only for OpenAI Codex requests.
- Adds the selected verbosity to the request.
- Leaves other models and invalid configs unchanged.

### `codex-quota`

Why you need it:

- Shows how much Codex usage remains before you hit a limit.
- Helps decide when to continue with Codex and when to switch model or reduce usage.

Config file: `~/.pi/agent/config/codex-quota.json`

Options:

- `enabled`: default `false`. Must be `true` to show quota.
- `refreshInterval`: default `60`. Minimum `10`. Unit: seconds.

How it works:

- Uses pi's OpenAI Codex login data.
- Requests quota from the Codex usage endpoint.
- Shows quota in the footer, for example `91%/4h 100%/6d`.
- Colors only the quota percentage; reset windows and compact non-data text stay plain.
- Shows `CX auth`, `CX err`, or `CX ?` when quota cannot be shown.

### `custom-compaction`

Why you need it:

- Keeps long conversations usable after old messages are summarized.
- Reduces the chance that important decisions, constraints, and current task state are lost during compaction.

Config file: `~/.pi/agent/config/custom-compaction.json`

Options:

- `enabled`: default `true`.
- `model`: optional. Uses the current model when missing.
- `reasoning`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `systemPromptFile`: optional custom prompt path.
- `historyPromptFile`: optional custom prompt path.
- `updatePromptFile`: optional custom prompt path.
- `turnPrefixPromptFile`: optional custom prompt path.

How it works:

- Replaces pi's default compaction flow.
- Uses bundled prompts when custom prompt files are not set.
- Sends the old conversation to the model as one conversation block to create or update the summary.
- Disables itself when the config or a custom prompt file is invalid.

### `context-projection`

Why you need it:

- Long sessions often contain huge old tool outputs, such as file reads, logs, or command output.
- These outputs can fill the model context even when they are no longer useful.
- This extension keeps the session moving by hiding old bulky successful tool outputs from the next model request.
- It does not delete saved conversation history.

Config file: `~/.pi/agent/config/context-projection.json`

Options:

- `enabled`: default `false`.
- `projectionRemainingTokens`: default `49152`. Projection starts at or below this remaining-token count.
- `keepRecentTurns`: default `10`. Keeps this many recent tool-use turns unchanged.
- `keepRecentTurnsPercent`: default `0.2`. Keeps this share of recent tool-use turns unchanged.
- `minToolResultTokens`: default `2000`. Only larger tool results can be hidden.
- `projectionIgnoredTools`: default `[]`. Tool names whose results stay visible. `consult_advisor` is always ignored.
- `placeholder`: default `[Result omitted. Run tool again if you want to see it]`.
- `summary.enabled`: default `false`. Generates a short replacement summary before projection.
- `summary.model`: optional. Uses the current model when missing or `null`.
- `summary.thinking`: optional. Uses the current thinking level when missing or `null`. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `summary.maxConcurrency`: default `1`. Limits parallel summary requests.
- `summary.retryCount`: default `1`. Retries failed summary requests after the first attempt.
- `summary.retryDelayMs`: default `5000`. Waits between summary retry attempts.
- `summary.systemPromptFile`: optional custom system prompt path.
- `summary.userPromptFile`: optional custom user prompt path appended after tool-result text.

Recommended setup:

- Use `context-projection` for long tool-heavy sessions where old large outputs fill context. With summary mode and suitable thresholds, it can often make the usable context behave close to twice the raw model context window without noticeable quality loss.
- Use a fast model for `summary.model`, such as `gpt-5.3-codex-spark` through the provider configured in your pi model registry, or a comparable fast summarization model.
- Keep `summary.maxConcurrency` low unless the provider rate limit and cost impact are acceptable.

How it works:

- Runs only when the remaining context is low enough.
- Replaces old large successful text-only tool results with the placeholder or an XML-wrapped generated summary that marks the full result as omitted. Summary is used only when it fits the summary model context window and reduces token count.
- Keeps recent tool results visible.
- Keeps failed results, non-text results, loaded skill files, `consult_advisor` results, and configured ignored tool results visible.
- Changes only what is sent to the model for the next request. It does not edit saved conversation history.
- Shows UI-only chat progress while a new projection operation processes tool results.
- Completion chat status shows only the additional savings from the latest projection operation.
- Footer status shows total active-branch context savings as `~0` or `~20k`, using tokenizer counts for the original and replacement text.

### `context-overflow`

Why you need it:

- Pi's built-in automatic compaction runs after an assistant response or before the next user prompt.
- In long autonomous runs, the next provider request can exceed the context limit before pi gets a useful assistant response.
- When that happens, compaction is triggered by a provider error instead of by a safe pi-side threshold.
- This extension starts compaction earlier, after a successful turn, while the session still has a configured token reserve.

Config file: `~/.pi/agent/config/context-overflow.json`

Options:

- `enabled`: default `true`.
- `compactRemainingTokens`: default `49152`. Compaction starts when this many tokens or fewer remain.

How it works:

- Checks context usage at `turn_end`, after each model turn when usage data is available.
- Starts standard pi compaction when remaining tokens are at or below `compactRemainingTokens`.
- Uses the normal compaction flow, so `custom-compaction` can still provide the summary prompt.
- Sends `System message: Context summarization complete, continue` after successful compaction.
- Prevents repeated or parallel compactions while usage stays below the limit.

### `main-agent-selection`

Why you need it:

- Lets you keep reusable agent modes for different kinds of work.
- Avoids repeating the same long instructions, model choice, thinking level, tool rules, and allowed subagents.

Config file: `~/.pi/agent/config/main-agent-selection.json`

Options:

- `enabled`: default `true`. Enables `/agent` and `Ctrl+Shift+A`.

Agent files are described in [Agent files](#agent-files).

How it works:

- Opens an agent selector with `/agent` or `Ctrl+Shift+A`.
- Supports `No agent` through the selector or `/agent none`.
- Saves the selected agent for the current working directory.
- Applies the selected agent's prompt, model, thinking level, tools, and allowed subagents.

### `run-subagent`

Why you need it:

- Lets the main agent split work into focused subagent tasks.
- Keeps specialized investigation, review, extraction, or coding work separate from the main conversation.

Config file: `~/.pi/agent/config/run-subagent.json`

Options:

- `enabled`: default `true`. Enables the `run_subagent` tool.
- `maxDepth`: default `1`. Limits nested subagent runs.
- `widgetLineBudget`: default `7`. Limits live widget height.

Tool input:

- `agentId`: subagent to run.
- `prompt`: task for the subagent.

How it works:

- Shows callable subagents to the main model.
- Allows only subagents permitted by the selected main agent.
- Starts a separate pi process for the selected subagent.
- Applies the subagent's model, thinking level, and tools.
- Shows live progress and returns the subagent's final answer.

### `consult-advisor`

Why you need it:

- Gives the main agent a second opinion before important decisions.
- Helps catch mistakes, missing options, or weak assumptions without changing the main agent.

Config file: `~/.pi/agent/config/consult-advisor.json`

Options:

- `enabled`: default `true`. Enables the `consult_advisor` tool.
- `model.id`: optional. Uses the current model when missing.
- `model.thinking`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `promptFile`: optional custom advisor prompt path.
- `debugPayloadFile`: optional file path for saving the advisor request.

Tool input:

- `question`: question for the advisor.

How it works:

- Builds an advisor request from the active conversation branch.
- Replays recorded `context-projection` placeholders or summaries when projection is active.
- Removes the pending `consult_advisor` tool call from that request.
- Appends the advisor question as a user message.
- Uses the advisor system prompt and disables tools.
- Calls the configured advisor model only when the request fits the advisor model context window.
- Returns a clear error when the advisor request is too large.
- Returns the advisor's visible answer.
- Saves very large answers to a temporary file and returns a short result with the file path.
