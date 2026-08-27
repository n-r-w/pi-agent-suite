# Problem Statement

## Context

The `context-projection` extension maps provider-context messages to active session branch entries before it replaces eligible tool results. Pi creates a live custom message timestamp and creates another timestamp when it persists that message.

## Problem Statement

Projection stops for the remainder of an active run when a live custom message timestamp differs from the timestamp in its persisted `custom_message` entry, although the message content and metadata are identical.

## Who is affected

Pi sessions that load `context-projection` and receive custom messages from extensions, including workflow state messages.

## Evidence

Runtime observation found a mapping mismatch where only the top-level `timestamp` field differed. Pi `AgentSession.sendCustomMessage` assigns `Date.now()` to the live message, while `SessionManager.appendCustomMessageEntry` assigns a new timestamp during persistence. Regression coverage is in `pi-package/shared/context-projection.test.ts` and `pi-package/extensions/context-projection/index.test.ts`.

## Impact

Eligible tool results remain in provider context after the mismatch. Context usage can then cross projection and compaction thresholds without the configured projection savings.

## Reproduction Steps

1. Start a Pi session with `context-projection` enabled.
2. Add a custom message during the active run.
3. Persist the custom message with a timestamp that differs from the live message timestamp.
4. Emit a context event that contains the live message.
5. Observe that branch mapping returns no result and projection does not replace eligible tool results.

## Current State

`mapEventMessagesToBranchEntries` requires deep equality between each reconstructed branch message and each context event message. A custom message timestamp mismatch makes the complete mapping fail safe to no projection.

## Desired Outcome

A live custom message maps to its persisted entry when all fields except timestamp are deeply equal. Differences in content, custom type, details, or display continue to make mapping fail.

## Success Metrics

- A context event with a timestamp-only custom message mismatch projects eligible tool results.
- A context event with any other custom message mismatch does not project tool results.
- Ordinary messages retain strict timestamp matching.

## Scope

Custom message identity during active-branch context mapping.

## Out of Scope / Non-Goals

- Pi source code or dependency changes.
- Tolerance windows for timestamps.
- Relaxed matching for ordinary messages.
- Changes to projection thresholds or summary generation.

## Constraints

The implementation must use the public Pi extension API and preserve fail-safe mapping for semantic message differences.

## Assumptions

Session branch entries and provider-context messages remain in the same order.

## Open Questions

None.
