# Problem Statement

## Context

The repository uses Pi 0.86.1 and must migrate to Pi 0.87.0. Pi 0.87.0 changes how session context is built, which messages context extensions receive, and which session-entry types extensions must handle.

## Observed Problem

Several extensions rely on Pi 0.86.1 assumptions about session context. Under Pi 0.87.0, these extensions can skip context projection, restore content that Pi removed, use original content instead of a Pi replacement, process stale context in auxiliary requests or compaction, or fail to compile.

## Affected Audience

The problem affects users of the main agent, auxiliary model requests, custom compaction, council participation, context-usage display, and threshold-triggered compaction. It also affects maintainers who must build and release the package against Pi 0.87.0.

## Evidence

- Pi 0.87.0 excludes system messages from `ContextEvent.messages`.
- Pi 0.87.0 applies append-only `context_edit` entries through `buildSessionProjection()`.
- The repository builds its context-entry mapping with helpers that do not apply `context_edit`.
- The repository reuses that mapping for live projection, auxiliary replay, and custom compaction.
- `pi-package/extensions/convene-council/context.ts` does not handle the new `context_edit` session-entry variant.
- An isolated Pi 0.87.0 experiment reproduced failed event mapping, stale replay, one TypeScript error, and one obsolete integration assertion.

## Impact

The main agent and auxiliary models can receive different or stale conversation history. Custom compaction can process content that is no longer model-visible. Context usage can be misleading enough to trigger compaction at the wrong time. The package can also fail to compile after a dependency-only update.

## Current State

The repository runs against Pi 0.86.1. Its affected components follow Pi 0.86.1 context contracts.

## Desired State

After migration, each affected component fulfills its purpose under Pi 0.87.0. The migration does not need to reproduce Pi 0.86.1 internal algorithms or every secondary behavior detail.

## Problem Boundary

The problem covers Pi 0.87.0 compatibility changes needed for affected components to fulfill their purpose. It does not include Pi 0.86.1 support, new component capabilities, or defects that behave the same on Pi 0.86.1 and Pi 0.87.0.

## Assumptions

None.

## Open Questions

None at the problem-definition level.
