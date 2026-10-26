# context-projection

## Purpose

- `context-projection` reduces provider context use in long sessions.
- It replaces old large, successful text tool results with a short omitted notice.
- It can include generated summaries for projected tool results when summary mode is enabled.

Projection is disabled until `enabled` is set to `true`.

## Configuration file

Primary file: `~/.pi/agent/agent-suite/context-projection/config.json`.

Compatibility file: `~/.pi/agent/config/context-projection.json`. This file is read only when the primary file is missing.

Full config example:

```json
{
  "enabled": true,
  "projectCompactionSource": true,
  "projectionRemainingTokensL1": 70000,
  "minToolResultTokensL1": 4000,
  "projectionRemainingTokensL2": 50000,
  "minToolResultTokensL2": 2000,
  "projectionRemainingTokensL3": 30000,
  "minToolResultTokensL3": 1000,
  "keepRecentTurns": 10,
  "keepRecentTurnsPercent": 0.2,
  "projectionIgnoredTools": [],
  "omittedNotice": "Result omitted. Run tool again for full result.",
  "summaryNotice": "Full result omitted. Summary below. Run tool again for full result.",
  "summary": {
    "enabled": true,
    "model": {
      "id": "summary",
      "thinking": "low"
    },
    "maxConcurrency": 1,
    "retryCount": 1,
    "retryDelayMs": 5000,
    "tasks": {
      "model": {
        "id": "summary",
        "thinking": "low"
      },
      "systemPromptFile": null,
      "userPromptFile": null
    },
    "systemPromptFile": null,
    "userPromptFile": null
  }
}
```

All parameters are optional. Unknown parameters make the configuration invalid.

Breaking change: `placeholder` is removed. If the config contains `placeholder`, startup fails with a message that names `omittedNotice` and `summaryNotice`.

Enabled projection requires `custom-compaction` to resolve to a valid configuration with `enabled` not set to `false`. Missing custom-compaction configuration satisfies this requirement because custom compaction is enabled by default. An explicitly disabled or invalid custom-compaction configuration stops projection with an exact configuration error. `context-projection` never edits or automatically enables custom compaction.

## Parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | Disabled when omitted or set to `false` | Enables projection. Set `true` to allow the extension to replace eligible old tool results. |
| `projectCompactionSource` | No | Boolean | `true` | Before custom compaction, generates missing summaries for eligible tool results in Pi's discarded range. `false` leaves results without existing summaries to Pi's standard 2,000-character truncation. |
| `projectionRemainingTokensL1` | No | Non-negative integer | `70000` | Defines the L1 threshold. When L1 is the deepest newly reached level, the extension applies one L1 batch. Must be greater than or equal to `projectionRemainingTokensL2`. |
| `minToolResultTokensL1` | No | Non-negative integer | `4000` | Minimum token count for a tool result to be projected at L1. |
| `projectionRemainingTokensL2` | No | Non-negative integer | `50000` | Defines the L2 threshold. When L2 is deeper than the applied level, the extension applies one L2 batch. Must be between L1 and L3. |
| `minToolResultTokensL2` | No | Non-negative integer | `2000` | Minimum token count for a tool result to be projected at L2. |
| `projectionRemainingTokensL3` | No | Non-negative integer | `30000` | Defines the L3 threshold. When L3 is deeper than the applied level, the extension applies one L3 batch. Must be less than or equal to `projectionRemainingTokensL2`. |
| `minToolResultTokensL3` | No | Non-negative integer | `1000` | Minimum token count for a tool result to be projected at L3. |
| `keepRecentTurns` | No | Non-negative integer | `10` | Minimum number of newest tool-use turns kept visible. A tool-use turn is an assistant tool call plus its matching tool results. |
| `keepRecentTurnsPercent` | No | Number from `0` to `1` | `0.2` | Fraction of newest tool-use turns kept visible in long sessions. The extension uses the larger value from `keepRecentTurns` and this percentage. |
| `projectionIgnoredTools` | No | Array of unique non-empty strings | `[]` | Tool names whose results stay visible. `consult_advisor`, `convene_council`, and tools whose names start with `workflow_` always stay visible during ordinary projection, even when omitted from this list. |
| `omittedNotice` | No | Non-empty string | `Result omitted. Run tool again for full result.` | Text that replaces projected tool results when summary mode is disabled or a summary cannot be used. |
| `summaryNotice` | No | Non-empty string | `Full result omitted. Summary below. Run tool again for full result.` | Text written in `<notice>` when a projected tool result includes a generated summary. |
| `summary` | No | Object | Summary disabled | Configures optional generated summaries for projected tool results. |

If multiple projection levels use the same remaining-token threshold, the extension activates the deepest matching level and uses the lowest matching `minToolResultTokens*` value.

## Threshold transitions

Before every provider request, the extension computes the active level from projection-aware remaining tokens. New projection discovery runs only when that level is deeper than the `appliedLevel` recorded after the latest successful compaction.

- The first L1, L2, or L3 transition creates one projection batch with that level's `minToolResultTokens*` value.
- A direct jump across multiple thresholds creates one batch at the deepest reached level.
- Usage moving above and below an applied threshold does not repeat that level.
- A crossed level is recorded even when no tool result is eligible.
- Existing replacements are replayed on every request without discovering new entries inside the applied level.
- Successful compaction resets the applied level. Session startup and tree navigation restore the selected branch's level from `context-projection` session entries.

This limits old provider-context changes to at most three batches between successful compactions. The checkpoint entry itself is extension state and is not sent in provider context.

## Effective context and replacement ordering

Provider requests use Pi's effective context: compaction-aware messages after Pi applies `context_edit` omission or replacement records. The extension maps each effective message to its raw source entry through Pi's public session projection, then applies repository projection replacements without rewriting stored history.

Replacement validity follows active-branch append order for each source entry:

1. A `context-projection` state record makes its replacement effective.
2. A later Pi `context_edit` for that source entry invalidates the repository replacement and restores Pi's effective omission or replacement.
3. A later `context-projection` state record can project that source entry again.

Runtime replacements that are not branch-visible yet follow the same ordering. A later branch edit or projection record controls the target, and switching to a branch without the runtime replacement's anchor discards that runtime state.

## Projection-aware usage

The footer, projection thresholds, and compaction trigger use one branch-aware usage calculation. It has two modes:

- **Response-based mode:** When the latest canonically visible usable assistant response is after the latest raw `context_edit` or compaction entry, native usage already reflects earlier effective projection. The calculation subtracts only effective projection savings recorded after that response.
- **Canonical-estimate mode:** When no canonically visible usable response follows the latest raw `context_edit` or compaction entry, Pi's native estimate can include content that effective projection removes. The calculation subtracts all effective active projection savings.

A usable response is a visible assistant response with positive usage that is neither an error nor aborted. Omitted assistant responses, zero usage, errors, and aborted responses do not select response-based mode. Unknown native token usage remains unknown, and numeric adjusted usage is clamped at zero.

## Summary parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `summary.enabled` | No | Boolean | `false` | Enables generated summaries for newly projected tool results. |
| `summary.model` | No | Object | Current main model and thinking level | Configures the model used to generate summaries. |
| `summary.model.id` | No | Non-empty string | Current main model | Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `summary.model.thinking` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | Current thinking level | Thinking level used for summary requests. |
| `summary.tasks` | No | Object | Bundled task request settings | Configures the current-task request that feeds summaries. |
| `summary.tasks.model` | No | Object | `summary.model` | Replaces `summary.model` as a whole for the task request. Omitted fields fall back to the current main model and thinking level. |
| `summary.tasks.model.id` | No | Non-empty string | Current main model | Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `summary.tasks.model.thinking` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | Current thinking level | Thinking level used for the task request. |
| `summary.tasks.systemPromptFile` | No | `null`, absolute path, or home-prefixed path | Bundled task system prompt | Custom system prompt file for the task request. `null` has the same effect as omitting the parameter. |
| `summary.tasks.userPromptFile` | No | `null`, absolute path, or home-prefixed path | Bundled task user prompt | Custom user prompt file appended after the session messages. `null` has the same effect as omitting the parameter. |
| `summary.maxConcurrency` | No | Positive integer | `1` | Maximum number of summary requests that can run at the same time. |
| `summary.retryCount` | No | Non-negative integer | `1` | Number of retry attempts after the first summary request fails. |
| `summary.retryDelayMs` | No | Non-negative integer | `5000` | Delay between summary retry attempts, in milliseconds. |
| `summary.systemPromptFile` | No | `null`, absolute path, or home-prefixed path | Bundled system prompt | Custom system prompt file for summary generation. `null` has the same effect as omitting the parameter. |
| `summary.userPromptFile` | No | `null`, absolute path, or home-prefixed path | Bundled user prompt | Custom user prompt file appended after the tool result text. `null` has the same effect as omitting the parameter. |

Home-prefixed paths accept `~`, `$HOME`, or `${HOME}`, either alone or followed by `/...`. Other environment variables are not expanded.

When `summary.enabled` is omitted or set to `false`, other summary values are ignored except unsupported summary keys.

Each tool-result summary candidate uses a Pi-compatible UUIDv7 provider session ID separate from the main agent session and other candidates. Retries for one candidate reuse that ID.

### Current tasks in summaries

When projection at L1, L2, or L3 has at least one summary candidate and the summary runtime resolves, the extension first sends one task request to a model. The request carries the session as the main agent sees it: tool results that earlier projections replaced appear with their replacement text, and tool results of the current batch are still full. It carries no tools, no system prompt of the main agent, no project context, and no knowledge. The model returns the goal and the current unfinished tasks of the agent. The UI shows a message when the task request starts.

The extension inserts this text as a separate `<agent_tasks>` block into the user message of each summary request of the batch. The bundled summary system prompt asks the summary model to keep the facts of the tool result that these tasks need. The text is not persisted and not reused by later batches. Batches without summary candidates, and runs with `summary.enabled` set to `false`, send no task request.

The task request uses `summary.tasks.model` when it is set. It replaces `summary.model` as a whole, and its omitted fields fall back to the current main model and thinking level. When `summary.tasks.model` is not set, the task request uses `summary.model`, then the current main model and thinking level. For example, with `summary.model` set to `{"id": "openai/gpt-mini", "thinking": "low"}` and `summary.tasks.model` set to `{"thinking": "high"}`, the task request uses the current main model with `high` thinking, and summary requests keep `openai/gpt-mini`. It uses a provider session ID separate from the main agent session, and the `projection-tasks` usage source records its cost. The request reads the whole session, so it can be as large as the context of the main agent and adds its latency to each projection batch, because Pi waits for the `context` handler. The user can abort it with Esc, as with summary requests.

When the task request fails, the extension shows one error per batch and writes the summaries of the batch without the `<agent_tasks>` block. Projection and the agent continue. These failures count:

- the task model, its alias, or its authentication does not resolve;
- the session does not fit into the context window of the task model;
- the provider returns an error after all retries;
- the answer has no text after all retries;
- the request throws after all retries.

The error names the failure and says that summaries are written without current tasks. With a UI it appears as an `error` notification. Without a UI, for example in `pi -p`, it goes to stderr. A user abort, for example with Esc, stops the task request and shows no error.

The task request retries a provider error, an empty answer, and a thrown error with `summary.retryCount` and `summary.retryDelayMs`. An unresolved model and a session that does not fit are not retried. A task model whose context window is smaller than the session fails every batch with this error. Select a task model with a larger window through `summary.tasks.model`. The extension writes no session diagnostic entry for task request failures.

A task prompt file in `summary.tasks.systemPromptFile` or `summary.tasks.userPromptFile` replaces the bundled task prompt. A configured file that cannot be read or is empty fails the task request with the error above. Relative prompt paths stop startup, as for `summary.systemPromptFile`. The values inside `summary.tasks` are ignored while `summary.enabled` is `false`.

A custom `summary.systemPromptFile` does not describe the `<agent_tasks>` block. Add this description to the custom prompt: the optional block holds the goal and the unfinished tasks of the agent, and the summary keeps the facts of the tool result that these tasks depend on. Without it, the summary model can ignore the block.

## Compaction source projection

When `projectCompactionSource` and `summary.enabled` are both `true`, custom compaction reuses existing projection summaries and generates missing summaries for every successful text tool result in `messagesToSummarize` and `turnPrefixMessages` whose size reaches `minToolResultTokensL3`.

Forced summaries also get the current tasks: `custom-compaction` sends one task request before generating them and passes the answer as the `<agent_tasks>` block, with the settings described in "Current tasks in summaries". See `docs/extensions/custom-compaction.md`.

This forced pass does not apply ordinary remaining-token triggers, recent-turn protection, loaded-skill protection, or ignored-tool protection. Pi has already selected these entries for removal, so the alternative is Pi's 2,000-character summary serialization rather than continued full visibility.

Generated summaries remain complete in the compaction source and are not passed through Pi's tool-result character limit. A failed, unavailable, non-reducing, or disabled projection summary falls back to Pi serialization for that result. Forced summaries are not persisted as projection state because successful compaction removes their source entries from the active context.

## Summary diagnostics

Each failed tool-result summary attempt appends a `tool-result-summary-diagnostic` custom entry to the JSONL session. Custom entries do not participate in model context.

| Field | Meaning |
| --- | --- |
| `source` | Extension that requested the summary: `context-projection` or `custom-compaction`. |
| `provider` | Summary model provider. |
| `model` | Summary model ID. |
| `candidateId` | Stable identifier of the tool result being summarized. |
| `toolName` | Tool that produced the result. |
| `attempt` | Failed attempt number, starting at `1`. |
| `totalAttempts` | Initial attempt plus configured retries. |
| `failureKind` | `context-too-large`, `aborted`, `provider-error`, `empty-response`, or `exception`. |
| `errorName` | Exception name when the provider call threw. |
| `errorCode` | String or numeric exception code when available. |
| `errorMessage` | Single-line failure message, limited to 2,000 characters. |

Diagnostic entries never contain prompts, tool-result text, authentication data, request headers, or exception stacks. A diagnostic persistence failure does not change summary retry or fallback behavior.

## Usage notes

- Missing configuration keeps projection disabled.
- Most invalid projection settings disable projection. Non-absolute summary prompt paths, invalid projection level ordering, removed `placeholder`, and an invalid or disabled `custom-compaction` dependency stop startup.
- Projection only changes the provider context for the current request. It does not rewrite stored session messages.
- Live custom messages can map to persisted `custom_message` entries when only their timestamps differ. Differences in role, custom type, content, display, or details make mapping fail safe without projection.
- Adaptive compaction reuses recorded summary replacements in its discarded range and can generate missing L3 summaries before building the durable summary source. Omission-only replacements are never used as durable summary input.
- Only successful text tool results can be projected.
- Failed tool results, non-text tool results, ignored tools, tool results protected by `keepRecentTurns` or `keepRecentTurnsPercent`, and `read` results for files under loaded skill directories stay visible.
- Keep `omittedNotice` and `summaryNotice` short because the model sees them in provider context.
- Enable `summary` when omitted results remove information that the model still needs.
