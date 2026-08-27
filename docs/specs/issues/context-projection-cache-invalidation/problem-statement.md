# Problem Statement

## Context

The `context-projection` extension replaces eligible old tool results when remaining context tokens reach L1, L2, or L3. Provider KV caches reuse an unchanged request prefix across consecutive model calls.

## Problem Statement

After a projection level becomes active, newly eligible tool results can be replaced on every later request at that level. Each new replacement changes an earlier request prefix and invalidates provider KV cache entries after that position.

## Who is affected

Long-running Pi sessions that enable `context-projection` and depend on provider prompt caching.

## Evidence

`handleContextProjection` previously passed the active level to `projectContextMessages` on every `context` event. As recent-turn protection moved forward, older results became new projection candidates without a deeper threshold transition.

## Impact

Repeated historical-prefix changes reduce KV cache reuse. Providers must process the changed prefix again even when the session remains inside one projection level.

## Reproduction Steps

1. Enable context projection with recent-turn protection.
2. Cross the L1 remaining-token threshold.
3. Project eligible old tool results.
4. Add another tool-use turn while remaining tokens stay at L1.
5. Observe that a newly unprotected old result is projected and the earlier provider prefix changes again.

## Current State

Projection discovery runs whenever a projection level is active. Existing replacements are also replayed on every request.

## Desired Outcome

New projection discovery runs only when the session reaches a deeper level than any level applied since the latest successful compaction. Existing replacements remain stable and are replayed on every request.

## Success Metrics

- L1, L2, and L3 each create at most one projection batch between successful compactions.
- Usage moving above and below an applied threshold does not repeat that level.
- A direct jump across multiple levels creates one batch at the deepest reached level.
- Successful compaction starts a new threshold cycle.

## Scope

Ordinary context projection discovery, threshold state persistence, branch restoration, and compaction reset.

## Out of Scope / Non-Goals

- Forced projection of custom-compaction summary sources.
- Provider-specific cache APIs.
- Changes to projection thresholds or recent-turn calculations.
- Removal of existing projection replay.

## Constraints

The implementation must use the public Pi extension API and store durable state in session entries.

## Assumptions

Provider KV caches can reuse a request prefix when its serialized content remains identical.

## Open Questions

None.
