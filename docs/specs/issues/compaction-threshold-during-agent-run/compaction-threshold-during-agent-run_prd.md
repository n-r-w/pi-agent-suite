# Idea: Enforce Compaction Thresholds During Agent Runs

## Definitions

- native compaction threshold: `contextWindow - reserveTokens` when Pi's `compaction.enabled` is `true`.
- compaction threshold: `contextWindow - reserveTokens` when Pi compaction and `compaction-trigger` are enabled.
- projection-aware context usage: The token count shown in the footer after pending context-projection savings are subtracted.
- threshold crossing: Projection-aware context usage for the next model request is at or above the compaction threshold.
- compaction initiation: Blocking the next model request and starting Pi's configured compaction mechanism.

## Context and Problem

Pi checks the compaction threshold after `agent_end`. One active agent run can contain multiple model requests and tool calls, so a later request can reach the threshold before Pi initiates compaction. After an extension interrupts that request, Pi can complete native post-run compaction before `agent_settled`; starting manual compaction without recognizing that success produces a redundant failure.

## Goal

Complete compaction before sending a model request whose projection-aware context usage reaches the compaction threshold, then continue the interrupted task without user input.

## Scenarios

- A main Pi session reaches the threshold during a tool-call sequence.
- A child Pi session reaches the threshold during a tool-call sequence.
- Native post-run compaction succeeds before `agent_settled`, no second compaction starts, and the interrupted task continues.
- Native post-run compaction does not succeed, manual compaction completes, and the interrupted task continues.
- Compaction fails and the over-threshold request remains blocked.
- Automatic compaction is disabled in Pi settings.
- Context projection reduces the visible usage below the threshold during an active agent run.

## Scope and Non-Scope

In scope:

- Every active model with a positive `contextWindow`.
- Threshold checks before model requests during an active agent run.
- One projection-aware context usage source for the footer and threshold enforcement.
- Main and child Pi sessions.
- Coordination between native post-run compaction and manual compaction initiation.
- Automatic continuation after successful compaction.
- Explicit failure when compaction cannot complete.

Out of scope:

- Changes to Pi source code.
- Changes to how `custom-compaction` creates summaries.
- Moving compaction initiation into `context-projection`.
- Provider context limits and pricing rules.

## Requirements

- Before each model request, projection-aware context usage must be compared with `contextWindow - reserveTokens` for the active model.
  Justification: A check after `agent_end` cannot prevent an over-threshold request inside the active run.
- When projection-aware context usage reaches the threshold, compaction must complete before the original over-threshold request is sent.
  Justification: The compaction threshold must constrain every model request, not only requests between agent runs.
- Threshold enforcement must apply to every active model with a positive `contextWindow`.
  Justification: The threshold belongs to model metadata and Pi settings rather than a model allowlist.
- After successful compaction, the interrupted task must continue with preserved tool results and without user input.
  Justification: Threshold enforcement must not turn normal long-running tasks into manual recovery flows.
- When compaction fails, the over-threshold request must remain blocked and the agent must stop with an explicit error.
  Justification: Sending the request after failure would violate the configured threshold.
- A successful native post-run compaction must not be followed by a redundant manual compaction for the same threshold crossing.
  Justification: The session is already rebuilt, so a second attempt fails and incorrectly blocks continuation.
- When native post-run compaction does not succeed, threshold enforcement must initiate Pi's configured compaction pipeline after the interrupted run settles.
  Justification: Thresholds below Pi's native threshold still require extension-initiated compaction.
- Main and child Pi sessions must use the same threshold behavior.
  Justification: Both session types run the same package extensions and can execute long tool-call sequences.
- Compaction initiation must use Pi's configured compaction pipeline, including `session_before_compact` handlers and standard fallback behavior.
  Justification: Initiation and summary generation are separate responsibilities.
- `custom-compaction` must retain its summary-generation responsibility and behavior.
  Justification: Threshold detection does not belong to the summary generator.
- The footer and `compaction-trigger` must use the same projection-aware context usage value.
  Justification: The visible token count must predict whether threshold enforcement will allow or block the next request.
- Pi source code must not change.
  Justification: The deployed Pi package is outside the permitted implementation scope.
- When Pi's `compaction.enabled` is `false`, threshold enforcement must not initiate compaction or alter the model request.
  Justification: An explicit Pi setting must take precedence over automatic behavior.

## Open Questions

No unresolved questions remain.

## References

- [Problem Statement](problem-statement.md)
- [Domain Glossary](domain-glossary.md)
- [Technical Solution](technical-solution.md)
