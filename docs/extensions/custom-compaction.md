# custom-compaction

## Purpose

`custom-compaction` replaces Pi's default compaction request with fixed-boundary adaptive history summarization. It preserves Pi's retained suffix, builds a durable summary from the original chronological summary range, and checks both the summarization-model request and the next main-model request before returning a custom result.

The extension uses the current session model and thinking level by default. A separate compaction model, reasoning level, prompt files, and retry policy are configurable.

## Configuration file

Primary file:

```text
~/.pi/agent/agent-suite/custom-compaction/config.json
```

Missing configuration keeps custom compaction enabled with defaults. The extension does not read older custom-compaction config locations.

## Full configuration example

```json
{
  "enabled": true,
  "systemPromptFile": "/absolute/path/to/compaction-system.md",
  "historyPromptFile": "/absolute/path/to/compaction.md",
  "updatePromptFile": "/absolute/path/to/compaction-update.md",
  "fileCandidatesPromptFile": "/absolute/path/to/compaction-file-candidates.md",
  "reductionSystemPromptFile": "/absolute/path/to/compaction-reduction-system.md",
  "reductionPromptFile": "/absolute/path/to/compaction-reduction.md",
  "model": "provider/model",
  "reasoning": "medium",
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

Unknown parameters make the configuration invalid.

Breaking change: `summary` and `turnPrefixPromptFile` are removed. Adaptive compaction handles oversized history at the conversation level and includes the turn prefix in the chronological final summary source.

## Parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables adaptive custom compaction. `false` lets Pi use standard compaction. |
| `systemPromptFile` | No | Non-empty absolute path | Bundled final system prompt | System prompt used for final summary requests. |
| `historyPromptFile` | No | Non-empty absolute path | Bundled history prompt | Final prompt used when no previous compaction summary exists. |
| `updatePromptFile` | No | Non-empty absolute path | Bundled update prompt | Final prompt used when a previous compaction summary exists. |
| `fileCandidatesPromptFile` | No | Non-empty absolute path | Bundled file-candidate prompt | Optional final-prompt fragment that asks the model to select relevant file-operation paths for `must_read_after_compaction`. |
| `reductionSystemPromptFile` | No | Non-empty absolute path | Bundled reduction system prompt | System prompt used for preliminary, fragment, normalization, and merge requests. |
| `reductionPromptFile` | No | Non-empty absolute path | Bundled reduction prompt | User prompt used for preliminary, fragment, normalization, and merge requests. |
| `model` | No | String in `provider/model` format | Current main model | Model used for direct, preliminary, fragment, normalization, merge, and final requests. Model IDs may contain additional slashes after the provider. |
| `reasoning` | No | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current thinking level | Reasoning level used for adaptive compaction requests. |
| `retry` | No | Object | `{ "enabled": true, "maxRetries": 3, "baseDelayMs": 2000 }` | Retry settings for provider failures and invalid summarization responses. |
| `retry.enabled` | No | Boolean | `true` | Enables retry. |
| `retry.maxRetries` | No | Non-negative integer | `3` | Number of retries after the first request. |
| `retry.baseDelayMs` | No | Non-negative integer | `2000` | Initial retry delay in milliseconds. Later retry delays use the shared exponential policy. |

## Summary source and retained suffix

The durable summary source always preserves this order:

```text
previousSummary
messagesToSummarize
turnPrefixMessages
```

The extension uses Pi's `serializeConversation` output for messages without projection summaries. Pi limits each such serialized `toolResult` to 2,000 characters. Existing and forced `context-projection` summaries replace eligible tool results in the discarded range and remain complete instead of passing through this character limit. Omission-only replacements never enter the durable summary source.

The extension does not summarize `turnPrefixMessages` separately. They remain at the end of the same chronological summary source.

Pi's `firstKeptEntryId` remains unchanged. The retained suffix is never moved into the summary source, and the extension returns Pi's original file-operation details.

Before the final summary request, the extension renders the configured file-candidate prompt with deterministic non-overlapping file lists. Modified files are excluded from the read-only list. `{{readFiles}}` and `{{modifiedFiles}}` expand to newline-separated paths inside the file-candidate prompt, then the rendered fragment replaces `{{fileCandidates}}` in the selected history or update prompt. When both lists are empty, `{{fileCandidates}}` becomes an empty string and no file-candidate fragment reaches the model. A final prompt without `{{fileCandidates}}` receives no file guidance.

The model decides which paths belong in `must_read_after_compaction`. The extension does not append raw file-operation lists to the generated summary.

## Request budgets

Before any model request, the extension calculates:

- the maximum final summary size allowed by the prospective next main-model request;
- one common intermediate summary_node limit that permits pairwise merges and the final summarization request.

The prospective main-model request includes the effective system prompt, active tools, candidate compaction summary, retained suffix, main-model response reserve, and safety margin. Existing `context-projection` replacements are replayed for retained-suffix sizing. Generated summary replacements are also reused in the discarded summary range.

The final main-model request must fit its model window and must not be larger than the projected request representation it replaces. When no positive final or intermediate budget exists, custom compaction fails before issuing a model request.

## Adaptive reduction

When the complete final summarization request fits, the extension sends one direct final request.

Otherwise it:

1. Summarizes the largest fitting contiguous original prefix from oldest to newest.
2. Splits one oversized serialized block at paragraph, line, smaller text, or token boundaries.
3. Normalizes an oversized `previousSummary` to the common node limit.
4. Merges adjacent summary nodes only while the final request still does not fit.
5. Sends one final request after the ordered reduced source fits.

Preliminary original ranges are independent: an earlier intermediate summary is not included when summarizing a later original range. Every preliminary, fragment, normalization, and merge result must be smaller than its source and respect the common node limit.

The bundled `compaction-reduction-system.md` and `compaction-reduction.md` define intermediate reduction behavior. `reductionSystemPromptFile` and `reductionPromptFile` replace them independently. Final requests use `systemPromptFile` with either `historyPromptFile` or `updatePromptFile`. `fileCandidatesPromptFile` independently replaces the file-candidate fragment used by those final prompts.

## Progress messages

Interactive Pi sessions receive informational messages for:

- forced compaction-source projection progress and retries;
- adaptive compaction start;
- the number of original blocks in each preliminary range;
- oversized-block fragment count and each fragment position;
- previous_summary normalization;
- adjacent summary merges;
- final summary generation;
- retry attempt numbers;
- successful outcome details.

The successful outcome states whether the direct or adaptive path ran and reports applicable counts for projected tool results, reduced blocks, preliminary ranges, oversized blocks, fragments, normalizations, merges, logical model requests, and retries.

A logical model request is counted once even when it is retried. Retries are reported separately. Start and outcome notifications yield one event-loop turn so Pi can repaint them before synchronous planning or lifecycle completion continues. Non-interactive runs emit no progress notifications.

The terminal success or standard-compaction fallback is also stored as a `custom-compaction-outcome` custom entry with a dedicated TUI renderer. This TUI-only entry survives transcript redraw and session reload but does not participate in LLM context. Intermediate progress remains transient and is not persisted.

## Response handling

Each logical request uses a Pi-compatible UUIDv7 provider session ID. Retries for that request reuse the ID; separate operations use separate IDs.

The extension rejects:

- provider error responses;
- aborted or unsupported stop reasons;
- output-limit truncation;
- empty text;
- non-reducing intermediate results;
- fragment sets that are not smaller than their source block;
- summaries that exceed their node or final budget;
- final summaries that make the prospective main-model request too large.

Rejected responses use the configured retry policy. No partial summary is persisted.

After retries are exhausted, the extension shows the completed-work counts, exact reason, and `using standard compaction` through Pi UI when UI is available. It then returns no custom result, so Pi runs standard compaction. Failures before model requests use the same explicit fallback message without operation counts. Non-interactive runs have no separate custom-compaction warning.

## Relationship to context projection

`context-projection` reduces ordinary provider requests but does not rewrite persisted history. Adaptive compaction reuses generated projection summaries for tool results in Pi's discarded range. When `projectCompactionSource` is enabled, it first generates missing summaries for results that reach `minToolResultTokensL3`. Results without a usable summary retain Pi's standard serialization.

Forced source projection is best effort and ephemeral. A failed candidate falls back independently, and successful compaction removes the summarized source entries. The fixed retained suffix continues to use replayed provider-visible projection only for request budgeting.

Enabled `context-projection` requires a valid custom-compaction configuration that is not explicitly disabled. It never enables custom compaction automatically. See `docs/extensions/context-projection.md`.
