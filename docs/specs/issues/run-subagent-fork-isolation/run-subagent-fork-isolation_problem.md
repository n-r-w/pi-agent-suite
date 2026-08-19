# Problem Statement

## Context

The `run-subagent` extension persists a root session's subagent hierarchy as custom journal entries. Pi 0.84.2 creates a native fork by retaining one root-session branch in a new session file with a new Pi session ID.

## Problem Statement

When Pi creates a native fork of a root session that has retained subagents, `run-subagent` reconstructs journal entries with their original owner Pi session IDs. The forked root has a different Pi session ID, so the inherited subagents are inaccessible from the fork and may still reference mutable child session files used by the original hierarchy.

## Who is affected

Users who invoke Pi's native `/fork` or `/clone` operation on a root session that contains `run-subagent` sessions are affected. The defect also affects `run-subagent` components that authorize, list, address, or allocate owner-local IDs for inherited sessions.

## Evidence

- Pi emits `session_start` with `reason: "fork"` and `previousSessionFile` after a native fork: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:388-449`.
- Pi assigns the forked root a new session ID while retaining custom entries from the selected branch: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1077-1169`.
- `run-subagent` ignores the `session_start` event payload: `pi-package/extensions/run-subagent/index.ts:263-270`.
- `run-subagent` derives root ownership from the new root session ID: `pi-package/extensions/run-subagent/index.ts:1277-1282`.
- Journal reconstruction preserves persisted session keys: `pi-package/extensions/run-subagent/persistence.ts:262-319` and `pi-package/extensions/run-subagent/persistence.ts:398-432`.
- Direct access requires the caller's Pi session ID to match the persisted owner Pi session ID: `pi-package/extensions/run-subagent/session-ownership.ts:5-24`.
- An isolated reproduction reconstructed a session under `old-root`, rejected access from the forked root, and reported `[not_owner] session 1 is not directly owned by the caller`.

## Impact

The fork cannot steer, wait for, or query inherited direct subagents. The management screen omits inherited sessions because traversal starts from the forked root session ID. New subagents can reuse inherited owner-local IDs because allocation only considers sessions owned by the forked root. Shared child session files also prevent the original and forked hierarchies from evolving independently.

## Reproduction Steps

1. Create a persisted root Pi session.
2. Start at least one `run-subagent` session and retain its journal entry in the root branch.
3. Create a native Pi fork from a branch point that retains the journal entry.
4. Start `run-subagent` in the forked root session.
5. Attempt to address the inherited subagent through `subagent_steer`, `subagent_wait`, or `subagent_query`.
6. Observe that direct ownership authorization rejects the inherited owner-local session ID.

## Current State

The forked root receives a new Pi session ID, but retained `run-subagent` journal entries keep the original root owner Pi session ID and original child session file references. `run-subagent` reconstructs those entries without interpreting the native fork relationship.

## Desired Outcome

A native root fork represents the retained root branch and retained subagent hierarchy as an independent historical snapshot. The fork can address every retained subagent by its owner-local ID. Work performed after the selected root fork point appears only in the hierarchy where that work occurred.

## Success Metrics

- An isolated native-fork behavior test can steer, wait for, and query inherited direct subagents through the forked root.
- The forked management projection contains the retained subagent hierarchy.
- Starting a new direct subagent in the fork does not reuse an inherited owner-local ID.
- Continuing a subagent in the original hierarchy does not change the corresponding forked child session.
- A fork created before a later child continuation contains child history only through the retained root fork point.

## Scope

The problem covers native Pi forks of root sessions, retained `run-subagent` journal state, inherited nested subagent sessions, owner-local identity, historical consistency, and isolation between original and forked session hierarchies.

## Out of Scope / Non-Goals

- Compatibility with `run-subagent` session files written before this correction.
- Changes to Pi's native session format or fork implementation.
- General copying or synchronization of resources outside the persisted `run-subagent` hierarchy.

## Constraints

- Pi 0.84.2 provides the native fork lifecycle and `SessionManager` APIs.
- The original root and child session files must remain unchanged by work in the fork.
- The fork must preserve owner-local subagent IDs while using independent Pi session IDs for inherited child sessions.
- Tests must use isolated temporary fixtures without real user sessions, models, network calls, authentication, or git state.

## Assumptions

None.

## Open Questions

None at the problem-definition level.
