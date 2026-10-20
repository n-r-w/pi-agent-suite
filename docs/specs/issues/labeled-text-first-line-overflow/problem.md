# Problem Statement

## Key definitions and abbreviations

See [terms.md](terms.md).

## Context

Shared labeled text appears in workflow references and other extension renderers inside Pi's default tool shell.

## Observed Problem

Before the correction, the shared helper could append a full-width value row to the label and separator. This happened when the label and separator left no capacity for the value, or when the first value character could not fit the remaining first-row slot. The combined row exceeded the content width.

## Affected Audience

Users viewing labeled tool output at narrow terminal widths on main and subagent screens.

## Evidence

With label `From:`, value `review`, and content width 6, the uncorrected helper returned `From: review`, which occupies 12 terminal columns. The adjacent helper test checks that the corrected output contains `From: ` and `review` on separate rows. The selected-transition test also checks public Pi rendering at total widths 8, 22, and 120 on both main and subagent screens.

## Impact

Rows extend beyond the allocated display area.

## Current State

When the first value character cannot fit after the label and separator, the helper reserves the first row for the label and separator. It wraps the complete value on continuation rows. See [solution.md](solution.md) for the allocation mechanism.

## Desired State

When the first-row slot cannot hold the first value character, the helper starts the value on continuation rows and retains separate label and value styles. This case assumes that each value character fits within the full content width.

## Problem Boundary

This issue concerns the shared helper's first-row allocation when the value can wrap at the full content width. Pi Box behavior at total width 1 and collapsed run-subagent `renderName` rendering are outside this issue.

## Assumptions

None.

## Open Questions

None.
