# Pi Agent Suite

## Purpose

Pi Agent Suite adds a configurable multi-agent layer to pi.

Use it to define main agents, delegate work to allowed subagents, and ask an advisor model for a second opinion. Context, Codex, and footer extensions support long-running agent sessions.

## Extensions

| Extension | Enabled by default | Why you need it |
|---|---:|---|
| `enable-tools` | Yes | Enables built-in search tools that this package expects agents to use. |
| `footer` | Yes | Keeps important session status visible without opening menus or logs. |
| `codex-verbosity` | No | Lets you control how detailed OpenAI Codex answers are. |
| `codex-quota` | No | Helps avoid unexpected Codex quota exhaustion during work. |
| `custom-compaction` | Yes | Keeps long conversations useful after compaction by using better summary prompts. |
| `context-projection` | No | Helps long sessions continue when old large tool outputs would otherwise fill the model context. |
| `context-overflow` | Yes | Runs compaction before the next provider request fails because the context is already too large. |
| `completion-sound` | Yes | Plays a completion sound only when the top-level agent finishes. |
| `cmux` | Yes | Sends a cmux notification only when the top-level agent finishes. |
| `url-scheme` | No | Converts final assistant file references into editor links after verifying files exist. |
| `system-prompt` | Yes | Replaces pi's base system prompt from a Markdown template with explicit runtime variables. |
| `main-agent-selection` | Yes | Lets you switch between predefined working modes instead of repeating instructions manually. |
| `run-subagent` | Yes | Lets the main agent delegate focused tasks to subagents. |
| `ask-llm` | Yes | Lets you ask a one-off model question without writing it to the current session. |
| `consult-advisor` | Yes | Lets the main agent ask another model for an independent opinion before deciding. |
| `convene-council` | No | Lets two model participants discuss one question and return one bounded answer. |

## Best practices

The most effective setup combines `main-agent-selection`, `run-subagent`, `consult-advisor`, and `convene-council`.

Use `main-agent-selection` to choose a focused main agent for the current work. Use `run-subagent` to delegate narrow tasks to subagents. This keeps the main model focused and reduces context growth in large codebases, because investigation, extraction, review, and implementation tasks can run in separate subagent contexts.

Use `consult-advisor` when a cheaper model needs an audit from a stronger model. The main model can ask the advisor to check assumptions, risks, or decisions without paying for the stronger model on every turn.

Use `convene-council` when one answer benefits from two model participants challenging each other before the main model decides. It costs more and takes longer than `consult-advisor`, so reserve it for high-impact trade-offs, architecture choices, or risky interpretation questions.

Use `context-projection` for long tool-heavy sessions. With suitable thresholds and summary mode, it can make the usable context behave like a much larger window, often close to doubling the effective available context, without noticeable LLM quality loss when projected outputs are old or non-critical.

`consult-advisor` sends the advisor the active branch conversation messages, with recorded `context-projection` placeholders or summaries replayed instead of hidden full tool outputs. It removes the pending `consult_advisor` tool call, appends the advisor question, adds Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to the advisor system prompt, and disables tools. If the advisor request is still too large for the advisor model context window, the tool returns a clear error instead of calling the provider. Transient advisor provider failures are retried with `p-retry`.

`convene-council` renders the active branch as an external first-prompt `<context>` package instead of seeding participant sessions with the main-agent transcript. LLM1 and LLM2 receive the same question, the same `<context>`, Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md`, and only the tools configured for child participants. Independent first opinions and mutual missing-information calls run in parallel. Dependent review steps stay sequential when the next task uses the previous participant output. The participants exchange structured review responses until both report agreement after reviewing the opponent or until the iteration limit is reached. `context-projection` keeps council results visible because they carry decision-critical guidance.

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

Extension settings and artifacts are stored under the suite directory:

```text
~/.pi/agent/agent-suite/
```

Set `PI_AGENT_SUITE_DIR` to use another suite directory.

Compatibility with earlier storage paths is documented in the legacy storage guide: [docs/extensions/legacy-storage.md](docs/extensions/legacy-storage.md).

## Agent files

Agent files define reusable work modes and subagents.

Location:

```text
~/.pi/agent/agent-suite/agent-selection/agents/
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

### `enable-tools`

Why you need it:

- Makes `grep`, `find`, and `ls` available when pi starts a session.
- Gives agents fast project search and listing tools without enabling every built-in tool manually.

Config file: `~/.pi/agent/agent-suite/enable-tools/config.json`

Options:

- `enabled`: default `true`. Enables or disables all behavior owned by this extension.
- `include`: default `["grep", "find", "ls"]`. Tool names to add to active tools.
- `exclude`: default `[]`. Tool names this extension must not add. `exclude` wins over `include`.

How it works:

- Runs when a pi session starts.
- Reads all registered tools and current active tools.
- Adds configured `include` tools only when those tools are registered by pi and absent from `exclude`.
- Keeps already active tools unchanged.
- Leaves active tools unchanged when config is invalid.

### `footer`

Why you need it:

- Shows the current session state in one compact line.
- Makes it easier to notice the selected agent, model, quota, API cost, context usage, and MCP errors while working.

Config file: `~/.pi/agent/agent-suite/footer/config.json`

Options:

- `enabled`: default `true`. Enables or disables the custom footer.
- `showProvider`: default `true`. Shows the provider name.
- `showModel`: default `true`. Shows the model name.
- `showThinkingLevel`: default `true`. Shows the thinking level.
- `showApiCost`: default `true`. Shows recorded cumulative API cost from the current session, including helper calls from `consult-advisor`, `context-projection`, `convene-council`, `custom-compaction`, and `run-subagent`.

How it works:

- Installs a custom footer when a pi session starts.
- Shows these footer parts: project, Codex quota, API cost, active main agent, model, context projection, MCP errors, context usage.
- Shows `No agent` when no main agent is active.
- Reads the agent label from the same runtime state that builds the system prompt.
- Shortens long text so the footer fits the terminal width.

Example:

```text
workspace · 100%/5h 65%/5d · $0.123 · Coder · openai-codex/gpt-5.5/high · ~80k · 70k/262k/272k
```

| Segment | Example | Meaning |
| --- | --- | --- |
| Project | `workspace` | Current repository or directory. |
| Codex quota | `100%/5h 65%/5d` | Remaining quota and reset windows. |
| API cost | `$0.123` | Recorded cumulative API cost from assistant usage and helper model calls in the current session. |
| Agent | `Coder` or `No agent` | Active main agent, or `No agent` when no main agent is active. |
| Model | `openai-codex/gpt-5.5/high` | Provider, model, and reasoning level. |
| Projection | `~80k` | Tokens saved by context projection. |
| Context | `70k/262k/272k` | Current context use, context-overflow threshold, and maximum context size. |

MCP error statuses may appear before the context segment when an MCP server reports a problem.

### `codex-verbosity`

Why you need it:

- Lets you choose whether Codex should answer briefly or with more detail.
- Helps match answer length to the task: quick checks, normal coding, or detailed reasoning.

Config file: `~/.pi/agent/agent-suite/codex-verbosity/config.json`

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

Config file: `~/.pi/agent/agent-suite/codex-quota/config.json`

Options:

- `enabled`: default `false`. Must be `true` to show quota.
- `refreshInterval`: default `60`. Minimum `10`. Unit: seconds.
- `retryAttempts`: default `5`. Minimum `1`. Unit: requests per refresh.
- `retryInterval`: default `2`. Minimum `1`. Unit: seconds.

How it works:

- Uses pi's OpenAI Codex login data.
- Requests quota from the Codex usage endpoint in the background during startup.
- Retries failed quota requests before showing `CX err`.
- Shows quota in the footer, for example `91%/4h 100%/6d`.
- Colors only the quota percentage; reset windows and compact non-data text stay plain.
- Shows `CX auth`, `CX err`, or `CX ?` when quota cannot be shown.

### `custom-compaction`

Why you need it:

- Keeps long conversations usable after old messages are summarized.
- Reduces the chance that important decisions, constraints, and current task state are lost during compaction.

Config file: `~/.pi/agent/agent-suite/custom-compaction/config.json`

Options:

- `enabled`: default `true`.
- `model`: optional. Uses the current model when missing.
- `reasoning`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `systemPromptFile`: optional absolute custom prompt path.
- `historyPromptFile`: optional absolute custom prompt path.
- `updatePromptFile`: optional absolute custom prompt path.
- `turnPrefixPromptFile`: optional absolute custom prompt path.
- `retry.enabled`: default `true`. Enables retry for transient compaction provider failures.
- `retry.maxRetries`: default `3`. Retries after the first failed compaction model call.
- `retry.baseDelayMs`: default `2000`. First retry delay in milliseconds. Later retries use exponential backoff with factor `2`.

How it works:

- Replaces pi's default compaction flow.
- Uses bundled prompts when custom prompt files are not set.
- Sends the old conversation to the model as one conversation block to create or update the summary.
- Retries transient compaction provider failures with `p-retry`.
- Does not retry aborted compaction requests.
- Stops startup when a configured custom prompt file path is not absolute.
- Disables itself for other config or custom prompt file errors.

### `context-projection`

Why you need it:

- Long sessions often contain huge old tool outputs, such as file reads, logs, or command output.
- These outputs can fill the model context even when they are no longer useful.
- This extension keeps the session moving by hiding old bulky successful tool outputs from the next model request.
- It does not delete saved conversation history.

Config file: `~/.pi/agent/agent-suite/context-projection/config.json`

Options:

- `enabled`: default `false`.
- `projectionRemainingTokensL1`: default `70000`. Projection starts at or below this remaining-token count.
- `minToolResultTokensL1`: default `4000`. Only larger tool results can be hidden at L1.
- `projectionRemainingTokensL2`: default `50000`. L2 applies when remaining tokens reach this lower threshold.
- `minToolResultTokensL2`: default `2000`. Only larger tool results can be hidden at L2.
- `projectionRemainingTokensL3`: default `30000`. L3 applies when remaining tokens reach this lowest threshold.
- `minToolResultTokensL3`: default `1000`. Only larger tool results can be hidden at L3.
- `keepRecentTurns`: default `10`. Keeps this many recent tool-use turns unchanged.
- `keepRecentTurnsPercent`: default `0.2`. Keeps this share of recent tool-use turns unchanged.
- `projectionIgnoredTools`: default `[]`. Tool names whose results stay visible. `consult_advisor` and `convene_council` are always ignored.
- `placeholder`: default `[Result omitted. Run tool again if you want to see it]`.
- `summary.enabled`: default `false`. Generates a short replacement summary before projection.
- `summary.model`: optional. Uses the current model when missing or `null`.
- `summary.thinking`: optional. Uses the current thinking level when missing or `null`. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `summary.maxConcurrency`: default `1`. Limits parallel summary requests.
- `summary.retryCount`: default `1`. Retries failed summary requests after the first attempt.
- `summary.retryDelayMs`: default `5000`. Waits between summary retry attempts.
- `summary.systemPromptFile`: optional absolute custom system prompt path.
- `summary.userPromptFile`: optional absolute custom user prompt path appended after tool-result text.

Recommended setup:

- Use `context-projection` for long tool-heavy sessions where old large outputs fill context. With summary mode and suitable thresholds, it can often make the usable context behave close to twice the raw model context window without noticeable quality loss.
- Use a fast model for `summary.model`, such as `gpt-5.3-codex-spark` through the provider configured in your pi model registry, or a comparable fast summarization model.
- Keep `summary.maxConcurrency` low unless the provider rate limit and cost impact are acceptable.

How it works:

- Runs only when the remaining context is low enough.
- Replaces old large successful text-only tool results with the placeholder or an XML-wrapped generated summary that marks the full result as omitted. Summary is used only when it fits the summary model context window and reduces token count.
- Stops startup when a configured summary prompt path is not absolute.
- Keeps recent tool results visible.
- Keeps failed results, non-text results, loaded skill files, `consult_advisor` results, `convene_council` results, and configured ignored tool results visible.
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

Config file: `~/.pi/agent/agent-suite/context-overflow/config.json`

Options:

- `enabled`: default `true`.
- `compactRemainingTokens`: default `49152`. Compaction starts when this many tokens or fewer remain.

How it works:

- Checks context usage at `turn_end`, after each model turn when usage data is available.
- Starts standard pi compaction when remaining tokens are at or below `compactRemainingTokens`.
- Uses the normal compaction flow, so `custom-compaction` can still provide the summary prompt.
- Sends `System message: Context summarization complete, continue` after successful compaction.
- Prevents repeated or parallel compactions while usage stays below the limit.

### `completion-sound`

Why you need it:

- Plays a sound when the top-level pi agent successfully finishes a prompt.
- Suppresses completion sounds in child agent processes so delegated work does not create duplicate sounds.
- Suppresses sounds for provider errors, retries, and aborted runs.

Config file: `~/.pi/agent/agent-suite/completion-sound/config.json`

Options:

- `enabled`: default `true`. Enables or disables all behavior owned by this extension.
- `command`: optional non-empty string. Overrides the platform default playback executable.
- `args`: optional array of strings. Arguments passed to `command`. `command` is required when `args` is set.
- `volume`: optional number from `0` to `150`. Controls only built-in macOS and Linux playback.

How it works:

- Runs on `agent_end`.
- Skips playback when `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`.
- Skips playback when the latest assistant message ends with `error` or `aborted`.
- Uses `afplay /System/Library/Sounds/Glass.aiff` on macOS when config is missing.
- Uses `afplay -v <volume / 100> /System/Library/Sounds/Glass.aiff` on macOS when `volume` is configured and `command` is omitted.
- Uses `paplay /usr/share/sounds/freedesktop/stereo/complete.oga` on Linux when config is missing.
- Uses `paplay --volume=<round(65536 * volume / 100)> /usr/share/sounds/freedesktop/stereo/complete.oga` on Linux when `volume` is configured and `command` is omitted.
- Uses `powershell.exe` with `[console]::beep(880,180)` on Windows when config is missing. The default Windows beep ignores `volume`.
- Keeps custom `command` and `args` unchanged when `volume` is configured.
- Ignores playback process failures so sound issues do not interrupt the agent.

### `cmux`

Why you need it:

- Sends a cmux notification when the top-level pi agent successfully finishes a prompt.
- Suppresses cmux notifications in child agent processes so delegated work does not create duplicate notifications.
- Suppresses notifications for provider errors, aborted runs, and runs without a completed assistant message.
- Keeps pi working in normal terminals by ignoring `cmux notify` failures and timeouts.

Config file: `~/.pi/agent/agent-suite/cmux/config.json`

Options:

- `enabled`: default `true`. Enables or disables all behavior owned by this extension.

How it works:

- Runs on `agent_end`.
- Skips notification when `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`.
- Skips notification when the latest assistant message ends with `error` or `aborted`.
- Sends `cmux notify --title Pi --subtitle "Task Complete" --body <summary>`.
- Builds the body from changed files, read files, search activity, shell activity, or elapsed duration.
- Appends elapsed duration to non-fallback bodies when the run takes at least 15 seconds.
- Uses a 5 second timeout for `cmux notify`.
- Ignores cmux command failures so cmux issues do not interrupt the agent.
- Does not register commands, tools, prompts, skills, split commands, zoxide commands, review commands, continue commands, or open commands.

### `url-scheme`

Why you need it:

- Converts final assistant file references into Markdown links that open the file in your editor.
- Keeps intermediate tool-use messages unchanged.
- Avoids broken links by checking that the referenced file exists before rewriting text.

Config file: `~/.pi/agent/agent-suite/url-scheme/config.json`

Options:

- `enabled`: default `false`. Must be `true` to rewrite final assistant messages.
- `scheme`: default `vscode`. Allowed values: `vscode`, `cursor`, `webstorm`, `idea`, `pycharm`, `phpstorm`, `txmt`, `bbedit`.

How it works:

- Runs on final assistant `message_end` events with `stop` or `length` stop reasons.
- Skips tool-use, error, and aborted assistant messages.
- Removes `textSignature` from text blocks whose text is changed.
- Skips inline code, fenced code blocks, existing Markdown links, and Markdown images.
- Supports relative paths, absolute paths, `path:line`, and `path:line:column`.
- Percent-encodes URL path and query values, including spaces, `#`, `?`, `&`, Unicode, and Windows paths.
- Leaves the assistant message unchanged when config is invalid or the file does not exist.

More details: [docs/extensions/url-scheme.md](docs/extensions/url-scheme.md)

### `system-prompt`

Why you need it:

- Lets you own the base system prompt as a Markdown file.
- Keeps all static prompt text in the template.
- Inserts dynamic pi data only where the template has a variable.

Config file: `~/.pi/agent/agent-suite/system-prompt/config.json`

Options:

- `enabled`: default `true`. Set to `false` to leave pi's original system prompt unchanged.
- `templateFile`: optional absolute path to a Markdown template file. Missing value uses the bundled template.

Supported variables:

- `{{date}}`
- `{{cwd}}`
- `{{tools}}`
- `{{toolGuidelines}}`
- `{{appendSystemPrompt}}`
- `{{contextFiles}}`
- `{{skills}}`

`{{contextFiles}}` renders loaded context files as `<project_specific_instruction path="...">` blocks inside `<project_specific_instructions>`.

How it works:

- Loads the template during startup and reload.
- Replaces only pi's base prompt layer.
- Appends package-owned agent prompt additions after the rendered template.
- Removes unsupported `{{...}}` variables and warns with their names.
- Leaves pi's original prompt unchanged when config or template loading fails.

More details: [docs/extensions/system-prompt.md](docs/extensions/system-prompt.md)

### `main-agent-selection`

Why you need it:

- Lets you keep reusable agent modes for different kinds of work.
- Avoids repeating the same long instructions, model choice, thinking level, tool rules, and allowed subagents.

Config file: `~/.pi/agent/agent-suite/agent-selection/config.json`

Options:

- `enabled`: default `true`. Enables `/agent` and `Ctrl+Shift+A`.
- `diagnosticsEnabled`: default `false`. Writes runtime diagnostics to `~/.pi/agent/agent-suite/agent-selection/runtime-diagnostics.jsonl`.

Agent files are described in [Agent files](#agent-files).

How it works:

- Opens an agent selector with `/agent` or `Ctrl+Shift+A`.
- Supports `No agent` through the selector or `/agent none`.
- Saves the selected agent for the current working directory.
- Applies the selected agent's prompt, model, thinking level, tools, and allowed subagents.
- Reads the saved selection on session start and `/reload`.
- Keeps the active agent unchanged when selected-agent state files change during a running session.

### `run-subagent`

Why you need it:

- Lets the main agent split work into focused subagent tasks.
- Keeps specialized investigation, review, extraction, or coding work separate from the main conversation.

Config file: `~/.pi/agent/agent-suite/run-subagent/config.json`

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
- Reads oversized child RPC progress.
- Shows live progress and returns the subagent's final answer.

### `ask-llm`

Why you need it:

- Lets you ask a model a one-off question from the pi interface.
- Keeps the question and answer out of the current session.
- Uses the projected active branch and Pi-loaded context files when available.
- Uses a dedicated system prompt to mark the `/ask` question as the current task.

Config file: `~/.pi/agent/agent-suite/ask-llm/config.json`

Options:

- `enabled`: default `true`. Enables or disables `/ask`.
- `model.id`: optional. Uses the current model when missing.
- `model.thinking`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `systemPromptFile`: optional absolute custom system prompt path.
- `retry.enabled`: optional. Defaults to `true`.
- `retry.maxRetries`: optional non-negative integer. Defaults to `3`.
- `retry.baseDelayMs`: optional non-negative integer. Defaults to `2000`.

Command input:

- `/ask {question}` asks the configured model a one-off question.
- `/ask` opens an editor for the question.

How it works:

- Reads the bundled system prompt from `pi-package/extensions/ask-llm/prompts/system.md` unless `systemPromptFile` is configured.
- Rejects the request before the provider call when the exact provider input exceeds the selected model context window.
- Sends the active branch conversation to the selected model with `tools: []`.
- Replays recorded `context-projection` placeholders or summaries before calling the model.
- Adds Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to the system prompt.
- Retries retryable provider failures through bounded shared retry config.
- Does not write the `/ask` question or answer to the current session.
- Appends the `/ask` question as the final provider-only user message.
- Wraps the question in `<user_question>...</user_question>`.
- Shows a cancellable loading UI while the model request runs.
- Shows the answer as Markdown in a focused UI.
- Copies the answer to the clipboard from the focused UI with `Ctrl+Y`.

### `consult-advisor`

Why you need it:

- Gives the main agent a second opinion before important decisions.
- Helps catch mistakes, missing options, or weak assumptions without changing the main agent.

Config file: `~/.pi/agent/agent-suite/consult-advisor/config.json`

Options:

- `enabled`: default `true`. Enables the `consult_advisor` tool.
- `model.id`: optional. Uses the current model when missing.
- `model.thinking`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `promptFile`: optional absolute custom advisor prompt path.
- `debugPayloadFile`: optional file path for saving the advisor request.
- `retry.enabled`: default `true`. Enables retry for transient advisor provider failures.
- `retry.maxRetries`: default `3`. Retries after the first failed provider call.
- `retry.baseDelayMs`: default `2000`. First retry delay in milliseconds. Later retries use exponential backoff with factor `2`.

Tool input:

- `question`: question for the advisor.

How it works:

- Builds an advisor request from the active conversation branch.
- Replays recorded `context-projection` placeholders or summaries when projection is active.
- Removes the pending `consult_advisor` tool call from that request.
- Appends the advisor question as a user message.
- Adds Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to the advisor system prompt.
- Uses the advisor system prompt and disables tools.
- Calls the configured advisor model only when the request fits the advisor model context window.
- Retries transient advisor provider failures with `p-retry`.
- Does not retry aborted advisor requests.
- Returns a clear error when the advisor request is too large.
- Returns the advisor's visible answer.
- Saves very large answers to a temporary file and returns a short result with the file path.

### `convene-council`

Why you need it:

- Lets two model participants challenge each other before returning one answer.
- Helps expose disagreement, missing information, and weak alternatives on high-impact questions.

Config file: `~/.pi/agent/agent-suite/convene-council/config.json`

Options:

- `enabled`: default `false`. Set to `true` to enable the `convene_council` tool.
- `llm1.model.id`: optional. Uses the current model when missing.
- `llm1.model.thinking`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `llm2.model.id`: optional. Uses the current model when missing.
- `llm2.model.thinking`: optional. Uses the current thinking level when missing. Allowed values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `participantIterationLimit`: default `3`. Maximum completed LLM1 and LLM2 discussion pairs.
- `finalAnswerParticipant`: default `llm2`. Allowed values: `llm1`, `llm2`.
- `responseDefectRetries`: default `1`. Retries malformed participant responses and defective final answers.
- `tools`: optional array of non-empty tool-name patterns for additional participant tools. Participants always receive `read`. Missing or empty means participants receive only `read`. Exact tool names and constrained wildcard patterns are allowed. Full wildcard `*` is rejected.

Tool input:

- `question`: question for both council participants.

How it works:

- Builds one temporary context file from decision-relevant raw active-branch entries returned by `ctx.sessionManager.getBranch()`.
- Treats the context file as external evidence, not participant session memory, tool availability, or instructions.
- Does not replay recorded `context-projection` placeholders, compaction summaries, or branch summaries for council participant context.
- Removes only the current pending `convene_council` tool call and matching result from the context file.
- Keeps previous completed `convene_council` results in the context file as prior evidence.
- Sends the same first-prompt context file path, Pi-loaded context files, and question task to LLM1 and LLM2.
- Requires participants to read the context file with `read` before giving an opinion and to continue with `offset` when needed.
- Deletes the temporary context file after success, failure, abort, participant startup failure, or participant prompt failure.
- Runs participant prompts in isolated child `pi --mode rpc` sessions without seeding them with the main-agent transcript.
- Always shares `read` with each participant and shares configured `tools` as additional tools.
- Adds the selected participant tool names to each participant system prompt.
- Instructs participants that current runtime tool access overrides historical tool-access claims inside Project Context and the context file.
- Does not summarize or budget inline council context before child startup.
- Starts independent first-turn participant calls in parallel.
- Accepts first-turn participant opinions as non-empty text.
- Runs mutual missing-information answers and their clarification reviews in parallel.
- Keeps dependent review steps sequential when the next task uses the previous participant output.
- Requires later participant discussion responses in `<status>...</status><opinion>...</opinion>` format.
- Stops when both participants report `AGREE` after reviewing the opponent or when the iteration limit is reached.
- Requests the final answer from the configured final answer participant after agreement.
- Returns a no-consensus result with `<result>`, `<answer1>`, and `<answer2>` blocks when the iteration limit is reached without agreement.
- Shows stable participant rows during and after execution instead of a scrolling event stream.
- Selects and persists one English philosopher or sage name for each participant row, while internal IDs remain `llm1` and `llm2`.
- Shows each participant status icon, elapsed time, context usage when child usage is available, and latest operation.
- Uses the same status icon colors as `run_subagent`: `⏳` accent, `✓` success, `■` error, and `✗` error.
- Shows a short final-answer or error preview below participant rows after completion.
- Keeps raw transcripts, provider payloads, token deltas, and unbounded intermediate answers out of progress rows.
- Saves very large answers to a temporary file and returns a short result with the file path.
