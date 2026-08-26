# compaction-trigger

## Purpose

`compaction-trigger` enforces Pi's automatic compaction threshold during an active agent run. It blocks a model request when the final provider-visible context estimate reaches the threshold, runs Pi's configured compaction pipeline after the interrupted run settles, and continues the task after successful compaction.

The extension owns threshold detection and compaction initiation. `custom-compaction` remains responsible for summary generation through `session_before_compact`. `context-projection` remains responsible for provider-visible projection.

## Threshold source

The extension uses the active model's `contextWindow` and Pi's native `compaction.enabled` and `compaction.reserveTokens` settings. Project settings take precedence over agent settings through Pi's native settings rules. The threshold is:

```text
contextWindow - reserveTokens
```

The extension runs after `context-projection`. For each `context` event, it uses the same projection-aware `ctx.getContextUsage()` value as the footer. Pending projection savings reduce both the displayed usage and the trigger input. The extension blocks the request when the visible token count is equal to or greater than the threshold. When Pi reports unknown usage after compaction, the request proceeds until the next provider response establishes a known value.

The extension has no configuration file.

## Disabled behavior

The extension does not enforce the threshold when either condition applies:

- `compaction.enabled` is `false`.
- The active model has no positive `contextWindow`.

In these cases, the extension does not abort the run, replace messages, or initiate compaction.

## Lifecycle

1. An under-threshold request proceeds without changes.
2. When a request reaches the threshold, the extension aborts the active run and replaces that request's messages with an empty list. A compliant provider performs no outbound dispatch for the aborted request.
3. After Pi emits `agent_settled`, the extension calls `ctx.compact()` once.
4. Pi runs its configured compaction pipeline. This includes `session_before_compact`, custom summary generation or standard fallback, `CompactionEntry` persistence, and context rebuilding.
5. After compaction succeeds, the extension appends one hidden `compaction-trigger-continuation` message with `triggerTurn: true`.
6. The continuation tells the model to continue the interrupted task from the compacted context and preserved tool results. No user input is required.
7. The first resumed context estimate must be below the threshold. The extension then returns to its idle state and allows the rebuilt request to proceed.

## Failure behavior

The extension blocks the request, stops the cycle, and appends a visible non-triggering diagnostic when:

- native compaction settings are invalid;
- `ctx.compact()` throws or reports an error;
- the first context estimate after successful compaction still reaches the threshold.

A failed cycle sends no continuation and starts no second compaction. Further requests remain blocked until a session start resets the terminal failure state.

## Main and child sessions

Main Pi sessions and run-subagent child sessions load the same package registration for `compaction-trigger`. They use the same threshold calculation and lifecycle.

## Compaction reason

Pi reports extension-triggered compaction with `reason: "manual"`. The public `ctx.compact()` API has no reason parameter, so the extension cannot report `reason: "threshold"` without changing Pi.

## Related extensions

- [custom-compaction](custom-compaction.md) creates a custom summary when Pi emits `session_before_compact`. It does not decide when compaction starts.
- [context-projection](context-projection.md) projects eligible context before the request estimate. It does not initiate compaction or rewrite persisted session history.
