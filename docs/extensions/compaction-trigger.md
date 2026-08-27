# compaction-trigger

## Purpose

`compaction-trigger` enforces a configurable compaction threshold during an active agent run. It blocks a model request when the final provider-visible context estimate reaches the threshold, runs Pi's configured compaction pipeline after the interrupted run settles, and continues the task after successful compaction.

The extension owns threshold detection and compaction initiation. `custom-compaction` remains responsible for summary generation through `session_before_compact`. `context-projection` remains responsible for provider-visible projection.

## Threshold source

The extension uses the active model's `contextWindow`, Pi's native `compaction.reserveTokens`, and its own `tolerancePercent`. Project settings take precedence over agent settings for `reserveTokens` through Pi's native settings rules. The threshold is:

```text
contextWindow - reserveTokens + contextWindow * tolerancePercent / 100
```

`tolerancePercent` has no upper limit and the result is not capped at `contextWindow`. The declared window can therefore represent a billing boundary below the provider's real capacity. For example, `contextWindow: 275000`, `reserveTokens: 16384`, and `tolerancePercent: 250` produce a threshold of 946116 tokens. The user is responsible for keeping the threshold within the provider's real capacity and intended pricing range.

The extension runs after `context-projection`. For each `context` event, it uses the same projection-aware `ctx.getContextUsage()` value as the footer. Pending projection savings reduce both the displayed usage and the trigger input. The extension blocks the request when the visible token count is equal to or greater than the threshold. When Pi reports unknown usage after compaction, the request proceeds until the next provider response establishes a known value.

## Configuration

The optional configuration file is `~/.pi/agent/agent-suite/compaction-trigger/config.json`. `PI_AGENT_SUITE_DIR` replaces the `~/.pi/agent/agent-suite` directory when set.

```json
{
  "enabled": true,
  "tolerancePercent": 0
}
```

- `enabled` defaults to `true` and must be a boolean.
- `tolerancePercent` defaults to `0` and must be a finite non-negative number. Values greater than `100` and fractional values are valid.
- Unknown fields, malformed JSON, and invalid field values make the configuration invalid. An invalid configuration blocks model requests and appends one visible non-triggering diagnostic instead of selecting defaults.
- Configuration is read once when the extension loads. Restart Pi after changing the file.

## Disabled behavior

When `enabled` is `false`, the extension registers no lifecycle handlers. It does not abort runs, replace messages, initiate compaction, or append service messages. Pi's native compaction behavior remains controlled by `compaction.enabled`.

`compaction-trigger` remains active when `compaction.enabled` is `false`. It continues to use `compaction.reserveTokens` and calls the public `ctx.compact()` API when its own threshold is reached. Disable native automatic compaction when `tolerancePercent` must postpone compaction beyond Pi's declared `contextWindow`; otherwise Pi can compact first at its native threshold. Disabling native automatic compaction also disables Pi's automatic overflow recovery, so a provider rejection beyond its real capacity remains a failed run.

The extension also passes requests through when the active model has no positive `contextWindow`.

## Lifecycle

1. An under-threshold request proceeds without changes.
2. When a request reaches the threshold, the extension appends one empty hidden `compaction-trigger-interruption` message with `triggerTurn: false`. The marker tells `run-subagent` that the child invocation remains active through the interruption and continuation.
3. The extension aborts the active run and replaces that request's messages with an empty list. A compliant provider performs no outbound dispatch for the aborted request.
4. After Pi emits `agent_settled`, the extension calls `ctx.compact()` once.
5. Pi runs its configured compaction pipeline. This includes `session_before_compact`, custom summary generation or standard fallback, `CompactionEntry` persistence, and context rebuilding.
6. After compaction succeeds, the extension appends one hidden `compaction-trigger-continuation` message with `triggerTurn: true`.
7. The continuation tells the model to continue the interrupted task from the compacted context and preserved tool results. No user input is required.
8. The first resumed context estimate must be below the threshold. The extension then returns to its idle state and allows the rebuilt request to proceed.

## Failure behavior

The extension blocks the request, stops the cycle, and appends a visible non-triggering diagnostic when:

- its configuration is invalid;
- native compaction settings are invalid;
- `ctx.compact()` throws or reports an error;
- the first context estimate after successful compaction still reaches the threshold.

A failed cycle sends no continuation and starts no second compaction. Further requests remain blocked until a session start resets the terminal failure state.

## Main and child sessions

Main Pi sessions and `run-subagent` child sessions load the same package registration for `compaction-trigger`. They use the same threshold calculation and compaction lifecycle. In a child session, `run-subagent` keeps the invocation active after the first `agent_settled` that follows `compaction-trigger-interruption`. The first assistant result from the continued run restores normal terminal handling. A failed manual compaction terminates the child with its compaction error.

## Compaction reason

Pi reports extension-triggered compaction with `reason: "manual"`. The public `ctx.compact()` API has no reason parameter, so the extension cannot report `reason: "threshold"` without changing Pi.

## Related extensions

- [custom-compaction](custom-compaction.md) creates a custom summary when Pi emits `session_before_compact`. It does not decide when compaction starts.
- [context-projection](context-projection.md) projects eligible context before the request estimate. It does not initiate compaction or rewrite persisted session history.
