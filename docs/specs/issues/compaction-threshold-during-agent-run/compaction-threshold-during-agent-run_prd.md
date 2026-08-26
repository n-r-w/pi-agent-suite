# Idea: Enforce Compaction Thresholds During Agent Runs

## Definitions

- native compaction threshold: `contextWindow - reserveTokens` when Pi's `compaction.enabled` is `true`.
- compaction threshold: `min(contextWindow, contextWindow - reserveTokens + contextWindow * thresholdDeltaPercent / 100)` when Pi compaction and `compaction-trigger` are enabled.
- threshold crossing: The calculated context for the next model request is at or above the compaction threshold.
- compaction initiation: Blocking the next model request and starting Pi's configured compaction mechanism.

## Context and Problem

Pi checks the compaction threshold after `agent_end`. One active agent run can contain multiple model requests and tool calls, so a later request can reach the threshold before Pi initiates compaction.

## Goal

Complete compaction before sending a model request whose calculated context reaches the compaction threshold, then continue the interrupted task without user input.

## Scenarios

- A main Pi session reaches the threshold during a tool-call sequence.
- A child Pi session reaches the threshold during a tool-call sequence.
- Compaction succeeds and the interrupted task continues.
- Compaction fails and the over-threshold request remains blocked.
- Automatic compaction is disabled in Pi settings.
- Threshold enforcement is disabled in `compaction-trigger` settings.
- A positive `thresholdDeltaPercent` moves enforcement beyond the native threshold without exceeding `contextWindow`.

## Scope and Non-Scope

In scope:

- Every active model with a positive `contextWindow`.
- Threshold checks before model requests during an active agent run.
- Optional `compaction-trigger/config.json` settings for threshold enforcement.
- Main and child Pi sessions.
- Automatic continuation after successful compaction.
- Explicit failure when compaction cannot complete.

Out of scope:

- Changes to Pi source code.
- Changes to how `custom-compaction` creates summaries.
- Moving compaction initiation into `context-projection`.
- Provider context limits and pricing rules.

## Requirements

- Before each model request, the calculated context must be compared with `min(contextWindow, contextWindow - reserveTokens + contextWindow * thresholdDeltaPercent / 100)` for the active model.
  Justification: A check after `agent_end` cannot prevent an over-threshold request inside the active run, and the cap prevents enforcement beyond the model's maximum context.
- When the calculated context reaches the threshold, compaction must complete before the original over-threshold request is sent.
  Justification: The configured threshold must constrain every model request, not only requests between agent runs.
- Threshold enforcement must apply to every active model with a positive `contextWindow`.
  Justification: The threshold belongs to model metadata and Pi settings rather than a model allowlist.
- After successful compaction, the interrupted task must continue with preserved tool results and without user input.
  Justification: Threshold enforcement must not turn normal long-running tasks into manual recovery flows.
- When compaction fails, the over-threshold request must remain blocked and the agent must stop with an explicit error.
  Justification: Sending the request after failure would violate the configured threshold.
- Main and child Pi sessions must use the same threshold behavior.
  Justification: Both session types run the same package extensions and can execute long tool-call sequences.
- Compaction initiation must use Pi's configured compaction pipeline, including `session_before_compact` handlers and standard fallback behavior.
  Justification: Initiation and summary generation are separate responsibilities.
- `custom-compaction` must retain its summary-generation responsibility and behavior.
  Justification: Threshold detection does not belong to the summary generator.
- Pi source code must not change.
  Justification: The deployed Pi package is outside the permitted implementation scope.
- When `compaction-trigger/config.json` is absent or omits a field, `enabled` must default to `true` and `thresholdDeltaPercent` must default to `0`.
  Justification: Default settings must preserve enforcement at Pi's native compaction threshold.
- When Pi's `compaction.enabled` is `false`, threshold enforcement must not initiate compaction or alter the model request.
  Justification: An explicit Pi setting must take precedence over automatic behavior.
- When `compaction-trigger` has `enabled: false`, the extension must not initiate compaction or alter the model request.
  Justification: Threshold enforcement must have an extension-local disable switch without changing Pi's native compaction behavior.

## Open Questions

No unresolved questions remain.

## References

- [Problem Statement](problem-statement.md)
- [Domain Glossary](domain-glossary.md)
- [Technical Solution](technical-solution.md)
