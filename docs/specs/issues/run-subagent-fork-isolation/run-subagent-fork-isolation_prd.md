# Idea: Pi fork isolation for subagent sessions

## Definitions

- Native fork: Pi's `/fork` or `/clone` operation that creates a root session with a new Pi session ID from one retained branch.
- Fork point: The last root-session entry included in a native fork.
- Inherited subagent: A subagent represented in the retained branch of the root session or a nested session.
- Subagent hierarchy: All subagents owned recursively by the root session.

## Context and Problem

Pi creates a native root fork with a new session ID, but retained `run-subagent` records continue to reference the previous owners and child session files. The inherited sessions are therefore inaccessible from the fork and are not isolated from the original hierarchy.

## Goal

A native fork receives an accessible and independent copy of the subagent hierarchy in its state at the selected fork point.

## Scenarios

- A native fork inherits successful direct and nested subagent sessions.
- The original and inherited subagents continue independently.
- `subagent_start` creates a new child session without reusing an inherited owner-local subagent ID.

## Scope and Non-Scope

In scope:

- Native `/fork` and `/clone` operations for a Pi root session.
- Direct and nested subagent sessions.
- Historical consistency at the fork point.
- Access to inherited sessions.
- File isolation between the original and forked hierarchies.

Out of scope:

- Compatibility with `run-subagent` journals created before this correction.
- Changes to Pi's session format or native fork behavior.
- Copying data outside the `run-subagent` hierarchy.
- Subagent sessions whose latest state is `terminal-failure` or `terminal-aborted`.

## Requirements

- The native fork receives every subagent whose latest state is `terminal-success` and that is represented in the retained root-session branch, including every nesting level.
- Every inherited subagent preserves its owner-local subagent ID.
- Every inherited subagent receives a new Pi session ID and an independent child session file. Writes to the original child session file do not change the forked child session file, and writes to the forked child session file do not change the original child session file.
- An inherited subagent contains only state that existed at the selected fork point.
- The native fork receives the entire retained hierarchy regardless of the current `maxDepth`. The `maxDepth` setting restricts only new subagent invocations.
- Inherited sessions are accessible through `subagent_steer`, `subagent_wait`, and `subagent_query` using their preserved owner-local subagent IDs.
- The management screen displays the entire inherited subagent hierarchy.
- `subagent_start` assigns a new direct child session an owner-local subagent ID not used by an inherited direct child session.
- Compatibility with `run-subagent` journals created before this correction is not required.

## Open Questions

None.

## Technical Supplement

Not required for the Light PRD.

## References

- `docs/specs/issues/run-subagent-fork-isolation/run-subagent-fork-isolation_problem.md`
- `docs/specs/issues/run-subagent-fork-isolation/domain-glossary.md`
