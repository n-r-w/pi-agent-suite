# context-projection

## Purpose

`context-projection` reduces provider context pressure during long agent runs by replacing old large non-critical successful text-only tool results with a short placeholder before a model request.

Projection is disabled by default. It becomes active only when `enabled` is `true` in `~/.pi/agent/config/context-projection.json`.

Projection changes only the provider context for the current request. It does not rewrite stored session entries. Content omitted from provider context is not visible to the model in that request.

## Behavior

- Handles `session_start`, `session_tree`, and `context`.
- Reads configuration from `~/.pi/agent/config/context-projection.json`.
- Is disabled by default.
- Leaves provider context unchanged when the config file is missing.
- Treats missing `~/.pi/agent/config/context-projection.json` as a normal disabled state, not as an error.
- Leaves provider context unchanged when configuration is invalid.
- Computes `remainingTokens = contextWindow - tokens` through `ctx.getContextUsage()`.
- Runs projection only when `remainingTokens <= projectionRemainingTokens`.
- Maps provider-context messages back to active branch entries before changing messages.
- Skips projection when provider-context messages do not exactly match active branch entries.
- Projects only messages with `role: "toolResult"`.
- Projects only successful tool results where `isError !== true`.
- Projects only text-only tool result content.
- Projects only non-critical tool results.
- Treats `read` tool results for loaded skill-owned files as critical.
- Projects only tool results whose combined text length is at least `minToolResultChars`.
- Keeps recent tool-use turns unprojected by using `keepRecentTurns` and `keepRecentTurnsPercent`.
- Replaces only the `content` field of an eligible `toolResult`.
- Preserves `role`, `toolCallId`, `toolName`, `isError`, `timestamp`, and `details`.
- Stores projected entry IDs and their first placeholder in extension-owned custom session entries.
- Reuses the first placeholder for the same projected entry on the same branch, even if config changes later.
- Reconstructs projection state from the active branch on session start and session tree changes.
- Keeps projection state branch-local.
- Publishes footer status through status key `context-projection` when UI is available.
- Does not perform compaction.
- Does not summarize omitted content.
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

After projection:

```text
Assistant:
  Tool call: read(file A)

Tool result: read(file A)
  [Old successful tool result omitted from current context]

Assistant:
  Tool call: bash(test)

Tool result: bash(test)
  <recent output>
```

The `toolResult` message stays in place. Only its text content changes.

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

## Critical tool result protection

Some tool results contain instructions that control later agent behavior. These results must stay visible in provider context because replacing them with a placeholder changes the model's active instruction set.

A `read` tool result is critical when the read path is inside the root directory of a loaded skill. The root directory is the skill `baseDir`: the directory that contains `SKILL.md` for directory-based skills, or the directory that contains the loaded `.md` file for single-file skills.

Critical skill-owned paths include:

- `SKILL.md`;
- files under `references/`;
- files under `assets/`;
- files under `scripts/`;
- any other file under the loaded skill root.

Critical skill-owned `read` tool results are not projected, even when they are old, successful, text-only, and longer than `minToolResultChars`.

A previously stored projection state entry does not override critical protection. If a tool result is now classified as critical, it remains unprojected for the current provider request.

Do not replace critical skill-owned `read` results with a placeholder that tells the model to reread the skill. Rereading changes the loaded-skill workflow and can conflict with rules that prohibit rereading a skill file already read in the conversation.

## Footer status

`context-projection` publishes status key `context-projection` for the custom footer.

States:

- Missing config file or `enabled: false`: no visible status.
- Invalid config: `CP!` in the theme `error` color.
- Valid enabled config with no projected tool results on the active branch: `CP~` in plain footer text.
- Valid enabled config with branch-local projected tool result state: `CPN` in the theme `warning` color, where `N` is the number of stored projected tool result entries on the active branch.

`N` counts branch-local projection state entries. It does not estimate saved tokens. Critical protection can keep a counted entry visible in the current provider request.

## Configuration

File: `~/.pi/agent/config/context-projection.json`.

```json
{
  "enabled": true,
  "projectionRemainingTokens": 49152,
  "keepRecentTurns": 5,
  "keepRecentTurnsPercent": 0.1,
  "minToolResultChars": 4000,
  "placeholder": "[Old successful tool result omitted from current context]"
}
```

All fields are optional.

Defaults:

- `enabled`: `false`
- `projectionRemainingTokens`: `49152`
- `keepRecentTurns`: `5`
- `keepRecentTurnsPercent`: `0.1`
- `minToolResultChars`: `4000`
- `placeholder`: `[Old successful tool result omitted from current context]`

Rules:

- `enabled` must be a boolean value when present.
- `projectionRemainingTokens` must be a non-negative integer when present.
- `keepRecentTurns` must be a non-negative integer when present.
- `keepRecentTurnsPercent` must be a number from `0` to `1` when present.
- `minToolResultChars` must be a non-negative integer when present.
- `placeholder` must be a string when present.
- Unsupported keys make the configuration invalid.
- Missing config file disables projection and is not an error.
- Invalid configuration disables projection.

## Tuning

Safer starting values:

```json
{
  "enabled": true,
  "projectionRemainingTokens": 49152,
  "keepRecentTurns": 5,
  "keepRecentTurnsPercent": 0.1,
  "minToolResultChars": 4000,
  "placeholder": "[Old successful tool result omitted from current context]"
}
```

Use larger `keepRecentTurns` when recent tool output remains important for several internal agent steps.

Use larger `keepRecentTurnsPercent` when long sessions need a wider recent context window.

Use larger `minToolResultChars` when projection removes too many medium-size outputs.

Use smaller `projectionRemainingTokens` when projection starts too early.

Use a short placeholder. Do not say that the model can read omitted content from session history. The model only sees the current provider context.

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
- the tool result is shorter than `minToolResultChars`;
- the tool result belongs to a protected recent tool-use turn;
- provider-context messages cannot be exactly mapped to active branch entries.

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
- hybrid recent-turn formula using the larger value from absolute count and percentage;
- absolute `keepRecentTurns` behavior when percentage is smaller;
- counting only assistant messages with tool calls as tool-use turns;
- projection of otherwise eligible unattached tool results;
- invalid `keepRecentTurnsPercent` values disabling projection;
- footer status for disabled, invalid, ready, and projected states.
