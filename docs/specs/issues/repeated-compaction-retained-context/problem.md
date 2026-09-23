# Problem Statement

## Context

Custom compaction builds a projected copy of the context that Pi will retain after compaction. `replayRetainedContextProjection()` currently finds `firstKeptEntryId`, slices the raw branch at that entry, and only then applies Pi's compaction-aware context projection.

## Observed Problem

During repeated compaction, the retained entry selected by the new compaction can occur before the previous compaction entry in raw append order. Slicing the raw branch first can remove the previous compaction boundary that Pi needs to reconstruct the effective context.

For example:

```text
Raw branch:
U1 → U2 → C1 → U3

Effective context after C1, which retains from U1:
C1 summary → U1 → U2 → U3

A later compaction retains from U2.

Expected retained context:
U2 → U3

Current retained replay can produce:
C1 summary → U3
```

The current replay can therefore omit `U2` and include the obsolete `C1` summary.

## Affected Audience

Users of custom compaction in long sessions with more than one compaction are affected.

## Evidence

- `pi-package/shared/context-projection.ts` slices `branchEntries` at `firstKeptEntryId` before calling `buildContextEntryMapping()`.
- Pi `buildContextEntries()` needs the previous compaction's `firstKeptEntryId` to reconstruct its retained range.
- Pi can choose a new `firstKeptEntryId` from inside the previous compaction's retained range.
- The behavior is present with Pi 0.86.1 and Pi 0.87.0. It is not caused by the Pi 0.87.0 migration.
- The existing test for a fixed retained suffix has no previous compaction entry and does not cover this sequence.

## Impact

Custom compaction can calculate its retained-context budget from the wrong messages. It can omit a recent user or assistant message that Pi intends to retain and can include an old summary that does not belong to the retained suffix. The resulting summary can be based on incomplete or stale context.

## Current State

Retained replay applies canonical projection only after truncating raw session history.

## Desired State

For repeated compaction, custom compaction uses the same retained messages and source-entry order that Pi assigns to the new compaction boundary.

## Problem Boundary

The problem covers retained-context replay for custom compaction when an active branch already contains a compaction entry. It does not belong to the Pi 0.87.0 migration because the same behavior exists with Pi 0.86.1.

## Assumptions

None.

## Open Questions

None at the problem-definition level. Requirements and a technical solution have not yet been defined.
