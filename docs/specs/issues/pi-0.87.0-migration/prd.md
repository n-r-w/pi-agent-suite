# Idea: Migration to Pi 0.87.0

## Definitions

Domain terms are defined in `terms.md`.

## Context and Problem

The problem is defined in `problem.md`.

## Goal

Migrate the repository to Pi 0.87.0 so each affected component fulfills its purpose under the new Pi contracts.

## Scenarios

- The main agent shortens old tool results without restoring content that Pi removed.
- The main agent and auxiliary requests use Pi replacement content instead of original content.
- Auxiliary requests receive effective context with their own system prompt and no main-agent tools.
- Custom compaction processes effective model context.
- Council participants receive raw session evidence.
- The footer reports useful projection-aware context usage.
- `compaction-trigger` does not compact only because its estimate ignored an active projection.
- The package compiles, passes checks, and loads with Pi 0.87.0.

## Scope and Non-Scope

In scope:

- Migration to Pi 0.87.0.
- Adaptation of components affected by Pi 0.87.0 context contracts.
- Verification that each affected component fulfills its purpose.
- Dependency and lock-file updates.

Out of scope:

- Support for Pi 0.86.1 after migration.
- Exact reproduction of Pi 0.86.1 algorithms.
- Exact preservation of every secondary behavior detail.
- New component capabilities.
- The pre-existing repeated-compaction retained-context defect.

## Requirements

### Functional Requirements

- [X] FRQ-01: The repository SHALL target Pi 0.87.0.
  - Origin: source. The user requested migration to Pi 0.87.0.
  - Goal: Move the repository to the new Pi contract.
  - Goal achievement: Full. The requirement defines the migration target.
- [X] FRQ-02: The migrated repository SHALL NOT support Pi 0.86.1.
  - Origin: source. The user selected O4-1.
  - Goal: Exclude dual implementations.
  - Goal achievement: Partial. The requirement limits the solution but does not complete migration.
- [X] FRQ-03: Context projection SHALL shorten eligible old tool results and SHALL NOT restore content that Pi omitted or replaced in effective context.
  - Origin: source. The user selected O11-1 and defined success through component purpose.
  - Goal: Preserve the purpose of context projection.
  - Goal achievement: Full for main-agent context projection.
- [X] FRQ-04: Auxiliary requests SHALL use effective Pi context while retaining their own system prompt and an empty tool set.
  - Origin: source. The user approved the auxiliary-request scenario in O11-1.
  - Goal: Give auxiliary models current and isolated history.
  - Goal achievement: Full for auxiliary requests.
- [X] FRQ-05: Custom compaction SHALL select and summarize messages from effective Pi context.
  - Origin: source. The user approved the custom-compaction scenario in O11-1.
  - Goal: Prevent compaction from processing removed or stale content.
  - Goal achievement: Full for migration-related custom compaction behavior.
- [X] FRQ-06: Council SHALL receive raw session evidence, and `context_edit` entries SHALL NOT create separate council-context blocks.
  - Origin: source. Council exists to provide raw decision evidence.
  - Goal: Preserve the distinction between raw history and effective model context.
  - Goal achievement: Full for council context.
- [X] FRQ-07: The footer and `compaction-trigger` SHALL account for active context projection. When effective context remains below the trigger threshold, `compaction-trigger` SHALL NOT compact only because the Pi estimate includes content removed by context projection.
  - Origin: source. The user selected O11-1 and rejected exact legacy-algorithm preservation.
  - Goal: Avoid materially inflated usage and premature compaction.
  - Goal achievement: Full for projection-aware usage.
- [X] FRQ-08: The package SHALL pass typecheck, behavior tests, formatting and lint checks, and package loading with Pi 0.87.0.
  - Origin: source. Migration must produce a usable package.
  - Goal: Establish technical readiness on the target version.
  - Goal achievement: Full for compilation, checks, and loading.

### Non-Functional Requirements

- [X] NRQ-01: Preliminary findings SHALL enter the technical solution only after evaluation against Pi 0.87.0 and repository evidence.
  - Origin: source. The user did not accept the preliminary analysis as final.
  - Goal: Prevent assumptions from determining migration scope.
  - Goal achievement: Partial. The requirement controls evidence quality.
- [X] NRQ-02: Compatibility evaluation SHALL cover release notes, public Pi contracts, used implementation paths, and observed failures.
  - Origin: formulated. The requirement defines sufficient evidence sources.
  - Goal: Identify material issues omitted from the preliminary analysis.
  - Goal achievement: Full. The sources cover documented and observed compatibility effects.
- [X] NRQ-02.1: Changes SHALL be checked in an isolated Pi 0.87.0 environment without real user data, models, or sessions.
  - Origin: source. The user selected O7-1.
  - Goal: Exercise target behavior without affecting user state.
  - Goal achievement: Full. The requirement provides isolated target-version evidence.
- [X] NRQ-03: When an affected component cannot fulfill its purpose without a product decision, work on that component SHALL stop until the user decides how to proceed.
  - Origin: source. The user selected O11-1.
  - Goal: Prevent an implicit change to component purpose.
  - Goal achievement: Full. The requirement defines the blocker response.
- [X] NRQ-04: The solution SHALL use canonical Pi 0.87.0 APIs and SHALL NOT copy legacy algorithms or add compatibility logic unless a user scenario requires it.
  - Origin: source. The user explicitly rejected legacy-algorithm copying and overengineering.
  - Goal: Keep the migration minimal and aligned with component purpose.
  - Goal achievement: Full. The requirement constrains the solution to necessary behavior.

## Open Questions

None.

## References

- `problem.md`
- `terms.md`
- [Pi 0.87.0 release notes](https://pi.dev/news/releases/0.87.0)
- Pi 0.87.0 session format and extension-event documentation
