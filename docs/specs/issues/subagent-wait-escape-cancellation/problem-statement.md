# Problem Statement

## Context

The `run-subagent` extension keeps accepted child agents active while the main agent waits for feedback. Pressing `Escape` cancels the active main-agent run and its `subagent_wait` call.

## Problem Statement

When Pi represents that cancellation as a final assistant `stopReason` of `"error"`, the extension does not stop active child agents even though the active `ExtensionContext.signal` is aborted.

## Who is affected

Users who press `Escape` while the main agent is blocked in `subagent_wait` with one or more active child agents.

## Evidence

A session observed on August 23, 2026 accepted one child at `09:52:58`, cancelled `subagent_wait` at `09:53:02`, and recorded the final main-agent assistant message with `stopReason: "error"` and `errorMessage: "This operation was aborted"`. The child continued and completed after 78 seconds.

The lifecycle handler in `pi-package/extensions/run-subagent/index.ts` checks only `isAbortedAgentRun(event)`. That classifier returns true only for final assistant `stopReason: "aborted"`.

## Impact

The child continues model calls, tools, and repository work after the user has cancelled the owning main-agent run. The footer continues to report an active agent and later delivers feedback from work the user expected to stop.

## Reproduction Steps

1. Start a child through `subagent_start`.
2. Call `subagent_wait` for the active child.
3. Press `Escape` while the wait is pending.
4. Observe an aborted `ExtensionContext.signal` and a final assistant message with `stopReason: "error"`.
5. Observe that the child remains active and later completes normally.

## Current State

Root recovery starts only when the final assistant message has `stopReason: "aborted"`. An aborted active context signal does not affect the lifecycle decision.

## Desired Outcome

Cancelling the main-agent run stops every active child in its ownership hierarchy regardless of whether Pi reports the final assistant outcome as `"aborted"` or `"error"`.

## Success Metrics

- The regression scenario starts root recovery exactly once.
- A final `"error"` outcome with a non-aborted context signal does not start recovery.
- Existing final `"aborted"` behavior remains unchanged.

## Scope

Main-agent `agent_end` cancellation detection and the existing root subagent recovery path.

## Out of Scope / Non-Goals

- Changing Pi's assistant `stopReason` classification.
- Changing `subagent_wait` timeout or feedback selection.
- Adding a new process termination mechanism.

## Constraints

The extension must use Pi's public `ExtensionContext.signal` API and the existing `recoverRootShutdown` path.

## Assumptions

None.

## Open Questions

None.
