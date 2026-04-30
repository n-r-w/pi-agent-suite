# context-projection

## Purpose

`context-projection` reduces provider context pressure during long agent runs by replacing old large non-critical successful text-only tool results with a short replacement before a model request. The replacement is a placeholder by default. It can be a generated summary when summary mode is enabled.

Projection is disabled by default. It becomes active only when `enabled` is `true` in `~/.pi/agent/agent-suite/context-projection/config.json`.

Projection changes only the provider context for the current request. It does not rewrite stored session entries. Content omitted from provider context is not visible to the model in that request.

## Behavior

- Handles `session_start`, `session_tree`, and `context`.
- Reads configuration from `~/.pi/agent/agent-suite/context-projection/config.json`.
- Is disabled by default.
- Leaves provider context unchanged when the config file is missing.
- Treats missing `~/.pi/agent/agent-suite/context-projection/config.json` as a normal disabled state, not as an error.
- Leaves provider context unchanged when configuration is invalid, except non-absolute summary prompt paths stop startup.
- Computes `remainingTokens = contextWindow - tokens` from projection-aware context usage.
- Runs projection only when projection-aware `remainingTokens <= projectionRemainingTokens`.
- Maps provider-context messages back to active branch entries before changing messages.
- Skips projection when provider-context messages do not exactly match active branch entries.
- Projects only messages with `role: "toolResult"`.
- Projects only successful tool results where `isError !== true`.
- Projects only text-only tool result content.
- Projects only non-critical tool results.
- Treats `read` tool results for loaded skill-owned files as critical.
- Projects only tool results whose combined token count is at least `minToolResultTokens`.
- Keeps recent tool-use turns unprojected by using `keepRecentTurns` and `keepRecentTurnsPercent`.
- Replaces only the `content` field of an eligible `toolResult`.
- Preserves `role`, `toolCallId`, `toolName`, `isError`, `timestamp`, and `details`.
- Stores projected entry IDs and their first replacement text in extension-owned custom session entries.
- Reuses the first replacement text for the same projected entry on the same branch, even if config changes later.
- Reconstructs projection state from the active branch on session start and session tree changes.
- Keeps projection state branch-local.
- Tracks pending projection savings while provider usage still reflects the pre-projection context.
- Keeps pending projection savings after provider errors and aborted assistant messages.
- Clears pending projection savings after a successful assistant message with valid context usage.
- Clears pending projection savings when projection is disabled or configuration is invalid.
- Rebuilds pending projection savings from active branch state when valid configuration returns before provider usage catches up.
- Recomputes pending projection savings after loaded skill roots change projection eligibility.
- Clears branch-owned live pending savings when `session_tree` switches to another branch.
- Invalidates failed projection payloads when projection state append fails, so replay and projection-aware usage do not use failed projection state.
- Publishes footer status through status key `context-projection` when UI is available.
- Shows UI-only chat status when a new projection operation starts and completes.
- Does not perform compaction.
- Summarizes newly projected tool results only when `summary.enabled` is `true`.
- Runs summary requests with bounded concurrency from `summary.maxConcurrency`.
- Retries failed summary requests using `summary.retryCount` and `summary.retryDelayMs`.
- Uses the current main model when `summary.model` is not set.
- Uses the current thinking level when `summary.thinking` is not set.
- Uses bundled summary prompts when `summary.systemPromptFile` and `summary.userPromptFile` are not set.
- Requires custom summary prompt paths to be absolute paths.
- Sends the matched tool-call context and tool-result text to the summary model.
- Escapes XML delimiter characters inside tool-call context, tool-result text, and generated summary text.
- Appends the summary user prompt after the tool-result text.
- Checks summary input size against the summary model context window before calling the provider.
- Uses a generated summary only when the wrapped summary is smaller than the original tool result by tokenizer count.
- Does not rewrite provider-specific request payloads.

## Provider context shape

Before projection:

```text
Assistant:
  Tool call: read(file A)

Tool result: read(file A)
  <large old successful text output>

Assistant:
  Tool call: bash(test)

Tool result: bash(test)
  <recent output>
```

After projection without summary:

```text
Assistant:
  Tool call: read(file A)

Tool result: read(file A)
  [Result omitted. Run tool again if you want to see it]

Assistant:
  Tool call: bash(test)

Tool result: bash(test)
  <recent output>
```

After projection with summary:

```text
Assistant:
  Tool call: read(file A)

Tool result: read(file A)
  <tool_result full_result="omitted" content="summary">
  <notice>[Result omitted. Run tool again if you want to see it]</notice>
  <summary>
  Summary of the old read output.
  </summary>
  </tool_result>

Assistant:
  Tool call: bash(test)

Tool result: bash(test)
  <recent output>
```

The `toolResult` message stays in place. Only its text content changes. Generated summaries are wrapped to show the model that the full tool result was omitted. The `<notice>` text uses the same configured placeholder as projection without summary.

## Recent tool-use turn protection

A tool-use turn is an assistant message that contains at least one `toolCall` block, plus the following tool results attached to that turn.

`keepRecentTurns` is not a count of individual tool calls. One assistant tool-use turn can contain multiple tool calls, and all matching tool results for a protected turn stay unprojected.

The effective protection window is:

```text
effectiveKeepRecentTurns =
  max(keepRecentTurns, ceil(totalToolUseTurns * keepRecentTurnsPercent))
```

Examples with `keepRecentTurns = 5` and `keepRecentTurnsPercent = 0.1`:

```text
totalToolUseTurns = 8
ceil(8 * 0.1) = 1
effectiveKeepRecentTurns = 5
```

```text
totalToolUseTurns = 60
ceil(60 * 0.1) = 6
effectiveKeepRecentTurns = 6
```

```text
totalToolUseTurns = 200
ceil(200 * 0.1) = 20
effectiveKeepRecentTurns = 20
```

Text-only assistant messages do not count as tool-use turns.

Tool results that are not attached to a counted tool-use turn are outside the recent-turn protection window. They can be projected when they are otherwise eligible.

A tool result is attached to a tool-use turn only when its `toolCallId` matches one of the `toolCall` IDs from that assistant message. A `user`, `custom`, `branch_summary`, or non-tool assistant message between the tool call and tool result breaks the attachment.

## Critical tool result protection

Some tool results contain instructions that control later agent behavior. These results must stay visible in provider context because replacing them with a placeholder changes the model's active instruction set.

A `read` tool result is critical when the read path is inside the root directory of a loaded skill. The root directory is the skill `baseDir`: the directory that contains `SKILL.md` for directory-based skills, or the directory that contains the loaded `.md` file for single-file skills.

Critical skill-owned paths include:

- `SKILL.md`;
- files under `references/`;
- files under `assets/`;
- files under `scripts/`;
- any other file under the loaded skill root.

Critical skill-owned `read` tool results are not projected, even when they are old, successful, text-only, and at or above `minToolResultTokens`.

A previously stored projection state entry does not override critical protection. If a tool result is now classified as critical, it remains unprojected for the current provider request.

Do not replace critical skill-owned `read` results with a placeholder that tells the model to reread the skill. Rereading changes the loaded-skill workflow and can conflict with rules that prohibit rereading a skill file already read in the conversation.

## Footer status

`context-projection` publishes status key `context-projection` for the custom footer.

States:

- Missing config file or `enabled: false`: no visible status.
- Invalid config: `CP!` in the theme `error` color.
- Valid enabled config with no projected text removed from the current provider context: `~0` in plain footer text.
- Valid enabled config with projected text removed from the current active branch: `~N` in the theme `warning` color, where `N` is the approximate total token count saved by replacing old tool output with replacement text.

Footer `N` is calculated across all currently projected entries in the active branch. Critical protection can keep a stored projection state entry visible in the current provider request.

Footer context usage, context-overflow checks, and projection threshold checks use projection-aware context usage while provider usage is stale after projection. This prevents provider errors from temporarily showing or acting on the larger pre-projection context size.

When a new projection operation starts, the UI-only chat status shows progress as `Projecting context: X/Y tool results processed`. After completion, it shows `Context projected: ~N saved`, where `N` is the additional token count saved by the latest operation only. This completion value does not include entries projected earlier in the session.

## Configuration

File: `~/.pi/agent/agent-suite/context-projection/config.json`.

```json
{
  "enabled": true,
  "projectionRemainingTokens": 49152,
  "keepRecentTurns": 10,
  "keepRecentTurnsPercent": 0.2,
  "minToolResultTokens": 2000,
  "projectionIgnoredTools": [],
  "placeholder": "[Result omitted. Run tool again if you want to see it]",
  "summary": {
    "enabled": false,
    "model": null,
    "thinking": null,
    "maxConcurrency": 1,
    "retryCount": 1,
    "retryDelayMs": 5000,
    "systemPromptFile": null,
    "userPromptFile": null
  }
}
```

All fields are optional.

Rules:

- `enabled` must be a boolean value when present.
- `projectionRemainingTokens` must be a non-negative integer when present.
- `keepRecentTurns` must be a non-negative integer when present.
- `keepRecentTurnsPercent` must be a number from `0` to `1` when present.
- `minToolResultTokens` must be a non-negative integer when present.
- `projectionIgnoredTools` must be a duplicate-free array of non-empty strings when present.
- `consult_advisor` and `convene_council` results always stay visible even when `projectionIgnoredTools` does not list them.
- `placeholder` must be a non-empty string after whitespace is ignored.
- `summary` must be an object when present.
- `summary.enabled` must be a boolean value when present.
- `summary.model` must be `null` or a `provider/model` string when present.
- `summary.thinking` must be `null`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` when present.
- `summary.maxConcurrency` must be a positive integer when present.
- `summary.retryCount` must be a non-negative integer when present.
- `summary.retryDelayMs` must be a non-negative integer when present.
- `summary.systemPromptFile` must be `null` or an absolute path when present.
- `summary.userPromptFile` must be `null` or an absolute path when present.
- Unsupported keys make the configuration invalid.
- Missing config file disables projection and is not an error.
- Invalid configuration disables projection, except non-absolute summary prompt paths stop startup.

## Tuning

Use larger `keepRecentTurns` when recent tool output remains important for several internal agent steps.

Use larger `keepRecentTurnsPercent` when long sessions need a wider recent context window.

Use larger `minToolResultTokens` when projection removes too many medium-size outputs.

Use smaller `projectionRemainingTokens` when projection starts too early.

Use a short placeholder. Do not say that the model can read omitted content from session history. The model only sees the current provider context.

Enable `summary` when blind placeholders remove information that the model still needs. With suitable thresholds, summary mode can often make the usable context behave close to twice the raw model context window without noticeable quality loss when projected outputs are old or non-critical.

Use a fast model for `summary.model`, such as `gpt-5.3-codex-spark` through the provider configured in your pi model registry, or a comparable fast summarization model.

Keep `summary.maxConcurrency` low unless the provider rate limit and cost impact are acceptable.

Custom `summary.systemPromptFile` and `summary.userPromptFile` paths must be absolute paths. Bundled prompts are:

- `pi-package/extensions/context-projection/prompts/tool-result-summary-system.md`
- `pi-package/extensions/context-projection/prompts/tool-result-summary-user.md`

## Troubleshooting

Projection may not happen when:

- the config file is missing, which is the default disabled state;
- `enabled` is `false`;
- configuration is invalid;
- context usage is unavailable;
- `tokens` is `null`;
- `remainingTokens > projectionRemainingTokens`;
- the tool result is failed;
- the tool result has non-text content;
- the tool result is a critical skill-owned `read` result;
- the tool result is shorter than `minToolResultTokens`;
- the tool result belongs to a protected recent tool-use turn;
- provider-context messages cannot be exactly mapped to active branch entries.

Context usage may appear lower than raw provider usage after projection if the provider has not yet returned a later successful assistant message with valid usage. This correction is cleared after valid usage, invalid configuration, disabled projection, or branch switch to a branch that does not own the live projection.

Summary may not happen when:

- summary mode is disabled;
- the summary prompt file cannot be read;
- the summary model or auth cannot be resolved;
- the summary input does not fit the summary model context window;
- the summary request is aborted;
- the summary model response does not contain text after all retry attempts.

When summary generation fails for one tool result, or when the wrapped summary is not smaller than the original tool result, that result still uses the configured placeholder if it is otherwise eligible for projection.

## Known limitation

If `pi.appendEntry` fails while writing projection state, pi may already have changed the in-memory session tree before the file write error is raised. `context-projection` invalidates the failed projection payload so replay and projection-aware usage do not use it. Full rollback of the in-memory session tree, including the active leaf, requires an atomic append or rollback capability in pi runtime.

## Verification

Tests must verify:

- no projection when the config file is missing;
- fail-closed behavior for invalid configuration;
- no projection when remaining tokens are above `projectionRemainingTokens`;
- projection of eligible old successful text-only non-critical tool results;
- no projection for loaded skill-owned `read` results;
- no projection from previously stored projection state when the result is now classified as critical;
- preservation of `toolResult` message shape and metadata;
- provider-context copies instead of session-owned message objects;
- stable first placeholder after config changes;
- branch-local state reconstruction;
- exact mapping failure causing no projection;
- summary replacement for eligible projected tool results;
- placeholder fallback when a generated summary replacement would not reduce token count;
- progress completion when summary runtime cannot be resolved;
- bounded summary request concurrency;
- retry after transient summary request failure;
- no retry for aborted summary requests;
- no provider call when summary input cannot fit the summary model context window;
- escaping of XML delimiters in summary input and replacement output;
- hybrid recent-turn formula using the larger value from absolute count and percentage;
- absolute `keepRecentTurns` behavior when percentage is smaller;
- counting only assistant messages with tool calls as tool-use turns;
- projection of otherwise eligible unattached tool results;
- invalid `keepRecentTurnsPercent` values disabling projection;
- footer status for disabled, invalid, ready, and projected states;
- UI-only chat status when a new projection operation starts and completes;
- footer total savings and latest-operation chat savings as separate metrics;
- pending projection savings after provider errors;
- pending projection savings after aborted assistant messages;
- pending projection savings clearing after valid assistant usage;
- pending projection savings clearing after disabled, invalid, and fatal invalid configuration;
- pending projection savings rebuild when valid configuration returns before provider usage catches up;
- projection-aware threshold decisions while provider usage is stale;
- loaded skill root changes recomputing pending projection savings;
- `session_tree` branch switch clearing live pending savings from the previous branch;
- failed projection state append invalidating projection payloads before replay or projection-aware usage can use them.
