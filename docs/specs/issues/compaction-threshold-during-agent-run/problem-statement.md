# Problem Statement

## Context

Pi models define a maximum context size through `contextWindow`. Pi derives the automatic compaction threshold as `contextWindow - reserveTokens`.

## Problem Statement

Pi checks the automatic compaction threshold only after `agent_end`. During one active agent run, the agent loop can send multiple model requests while processing tool calls and queued messages. A later request can therefore reach the compaction threshold before Pi starts compaction.

## Who is affected

Users of any model with a positive `contextWindow` are affected when one agent run contains enough model and tool activity to reach the compaction threshold.

## Evidence

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` calls `_checkCompaction` from `_handlePostAgentRun` after the low-level agent run ends.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` continues model and tool turns until no tool calls or queued messages remain, then emits `agent_end`.
- Local session history contains requests above the configured model context metadata followed by compaction only after the final assistant response.

## Impact

Pi does not enforce its configured compaction threshold during an active agent run. Requests can become larger than intended before history is summarized.

## Reproduction Steps

1. Select a model with a positive `contextWindow`.
2. Enable Pi compaction and configure `reserveTokens`.
3. Start an agent task that performs a long sequence of model requests and tool calls.
4. Observe that model requests continue after the accumulated context reaches `contextWindow - reserveTokens`.
5. Observe that compaction starts only after `agent_end`.

## Current State

Pi checks the threshold after the active agent run stops. `custom-compaction` receives `session_before_compact` only after Pi has initiated compaction. `context-projection` can reduce provider-visible tool results, but it does not own compaction initiation.

## Desired Outcome

Before Pi sends a model request whose calculated context reaches the compaction threshold, compaction completes and the interrupted task continues automatically with preserved tool results.

## Success Metrics

- No model request is sent with calculated context at or above `contextWindow - reserveTokens` while Pi compaction is enabled.
- The active task continues after successful compaction without user input.
- A compaction failure blocks the over-threshold request and produces an explicit error.

## Scope

- Any active model with a positive `contextWindow`.
- Main and child Pi sessions.
- Threshold checks during active agent runs.
- Automatic task continuation after successful compaction.

## Out of Scope / Non-Goals

- Changing how `custom-compaction` creates summaries.
- Moving compaction responsibility into `context-projection`.
- Changing provider context limits or pricing.

## Constraints

- Pi source code must not change.
- The solution must use the public Pi extension API.
- `custom-compaction` remains a summary-generation mechanism.
- `context-projection` remains a context-projection mechanism. Its internal reusable calculations may be shared without changing that responsibility.
- When `compaction.enabled` is `false`, no threshold-triggered compaction is initiated.

## Assumptions

- Pi-compatible providers honor the abort signal supplied by Pi when an active agent operation is stopped.

## Open Questions

No unresolved questions remain.
