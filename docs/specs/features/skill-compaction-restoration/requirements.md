# Idea: Skill restoration after compaction

## Definitions

Terms follow `terms.md`. Requirement identifiers retain their meanings from `prd.md`.

## Context and Problem

See `problem.md` and the current-behavior sources in `facts.md`.

## Goal

After compaction, agents continue with previously loaded skill instructions without requiring the user or model to reload files that were restored.

## Scenarios

1. An agent loads a skill and its asset, then compacts. Its next request contains both files when they fit.
2. A user invokes a skill command. Its skill body returns after compaction.
3. Repeated compaction, session reopening, and branch navigation preserve restoration for the selected branch.
4. Native compaction and custom compaction restore skills in main agents and subagents.
5. When only some files fit, the model receives those files and an explicit list of absent files.

## Scope and Non-Scope

Included: Pi-listed skill directories and their descendants, read-tool loading, skill commands, both compaction kinds, main agents, and subagents.

Excluded: bash reads, tree branch-summary generation, and re-inserting files already loaded in the retained suffix.

## Requirements

### Functional Requirements

- [X] FRQ-01: After every successful compaction, the model receives each skill file loaded in the effective summarized context, including files restored after a previous compaction, subject to FRQ-03. This holds for main agents and subagents, native and custom compaction, and reopened sessions on the selected branch.
  - Origin: source. `prd.md`, FRQ-01; approved target picture.
  - Goal: continue with previously loaded instructions.
  - Goal achievement: Full. The agent receives the files removed by compaction whenever they fit.
  - Feasibility: Confirmed. Pi exposes effective branch history, compaction lifecycle events, persistent extension data, and request transformation.
- [X] FRQ-02: A file qualifies when it is inside a directory of a skill in Pi's skill list, including subdirectories. A project file outside those directories does not qualify. For example, a listed skill's assets/problem.md qualifies; a project-local SKILL.md outside the listed directories does not.
  - Origin: source. `prd.md`, FRQ-02.
  - Goal: return skill instructions without adding unrelated project files.
  - Goal achievement: Full. The ownership criterion follows Pi's skill list.
  - Feasibility: Confirmed. Pi exposes skill provenance, and read calls retain file paths.
- [X] FRQ-03: Restored content uses the available space below the automatic compaction threshold after preserving room for further work. When some files do not fit, the model receives their paths and an instruction to read them before relevant work. With no available space, it receives only that list.
  - Origin: source. `prd.md`, FRQ-03; headroom decision recorded in `solution.md`.
  - Goal: avoid immediate repeated compaction while identifying absent instructions.
  - Goal achievement: Partial. The model receives a clear instruction, but compliance remains model-dependent.
  - Feasibility: Confirmed. Pi exposes model capacity and compaction settings; the package estimates request size.
- [X] FRQ-04: The package system prompt does not instruct the model to reload skills after compaction. The instruction to reread a truncated file remains.
  - Origin: source. `prd.md`, FRQ-04.
  - Goal: avoid extra reads for files already returned to context.
  - Goal achievement: Full. The package no longer directs redundant post-compaction reads.
  - Feasibility: Confirmed. The package owns the skill guidelines in its system prompt.

### Non-Functional Requirements

None.

## Open Questions

None. Compliance with the absent-file instruction remains the model-dependent risk recorded in `prd.md`.

## Technical Supplement

The approved scope also includes the configuration, TUI, path sharing, model override handling, and package ordering described in `solution.md`.

## References

- `target-picture.md`
- `problem.md`
- `prd.md`
- `facts.md`
