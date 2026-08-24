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
| `projectionRemainingTokensL1` | No | Non-negative integer | `70000` | Starts L1 projection when remaining context tokens are at or below this value. Must be greater than or equal to `projectionRemainingTokensL2`. |
| `minToolResultTokensL1` | No | Non-negative integer | `4000` | Minimum token count for a tool result to be projected at L1. |
| `projectionRemainingTokensL2` | No | Non-negative integer | `50000` | Starts L2 projection when remaining context tokens are at or below this value. Must be between L1 and L3. |
| `minToolResultTokensL2` | No | Non-negative integer | `2000` | Minimum token count for a tool result to be projected at L2. |
| `projectionRemainingTokensL3` | No | Non-negative integer | `30000` | Starts L3 projection when remaining context tokens are at or below this value. Must be less than or equal to `projectionRemainingTokensL2`. |
| `minToolResultTokensL3` | No | Non-negative integer | `1000` | Minimum token count for a tool result to be projected at L3. |
| `keepRecentTurns` | No | Non-negative integer | `10` | Minimum number of newest tool-use turns kept visible. A tool-use turn is an assistant tool call plus its matching tool results. |
| `keepRecentTurnsPercent` | No | Number from `0` to `1` | `0.2` | Fraction of newest tool-use turns kept visible in long sessions. The extension uses the larger value from `keepRecentTurns` and this percentage. |
| `projectionIgnoredTools` | No | Array of unique non-empty strings | `[]` | Tool names whose results stay visible. `consult_advisor`, `convene_council`, and tools whose names start with `workflow_` always stay visible during ordinary projection, even when omitted from this list. |
| `omittedNotice` | No | Non-empty string | `Result omitted. Run tool again for full result.` | Text that replaces projected tool results when summary mode is disabled or a summary cannot be used. |
| `summaryNotice` | No | Non-empty string | `Full result omitted. Summary below. Run tool again for full result.` | Text written in `<notice>` when a projected tool result includes a generated summary. |
| `summary` | No | Object | Summary disabled | Configures optional generated summaries for projected tool results. |

If multiple projection levels use the same remaining-token threshold, the extension uses the lowest matching `minToolResultTokens*` value for those levels.

## Summary parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `summary.enabled` | No | Boolean | `false` | Enables generated summaries for newly projected tool results. |
| `summary.model` | No | Object | Current main model and thinking level | Configures the model used to generate summaries. |
| `summary.model.id` | No | Non-empty string | Current main model | Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `summary.model.thinking` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | Current thinking level | Thinking level used for summary requests. |
| `summary.maxConcurrency` | No | Positive integer | `1` | Maximum number of summary requests that can run at the same time. |
| `summary.retryCount` | No | Non-negative integer | `1` | Number of retry attempts after the first summary request fails. |
| `summary.retryDelayMs` | No | Non-negative integer | `5000` | Delay between summary retry attempts, in milliseconds. |
| `summary.systemPromptFile` | No | `null` or absolute file path | Bundled system prompt | Custom system prompt file for summary generation. `null` has the same effect as omitting the parameter. |
| `summary.userPromptFile` | No | `null` or absolute file path | Bundled user prompt | Custom user prompt file appended after the tool result text. `null` has the same effect as omitting the parameter. |

When `summary.enabled` is omitted or set to `false`, other summary values are ignored except unsupported summary keys.

Each tool-result summary candidate uses a Pi-compatible UUIDv7 provider session ID separate from the main agent session and other candidates. Retries for one candidate reuse that ID.

## Compaction source projection

When `projectCompactionSource` and `summary.enabled` are both `true`, custom compaction reuses existing projection summaries and generates missing summaries for every successful text tool result in `messagesToSummarize` and `turnPrefixMessages` whose size reaches `minToolResultTokensL3`.

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
- Adaptive compaction reuses recorded summary replacements in its discarded range and can generate missing L3 summaries before building the durable summary source. Omission-only replacements are never used as durable summary input.
- Only successful text tool results can be projected.
- Failed tool results, non-text tool results, ignored tools, tool results protected by `keepRecentTurns` or `keepRecentTurnsPercent`, and `read` results for files under loaded skill directories stay visible.
- Keep `omittedNotice` and `summaryNotice` short because the model sees them in provider context.
- Enable `summary` when omitted results remove information that the model still needs.
