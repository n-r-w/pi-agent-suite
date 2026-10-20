# Idea: Labeled text first-row width boundary

## Definitions

See [terms.md](terms.md).

## Context and Problem

See [problem.md](problem.md).

## Goal

Keep the label and value on separate rows when the first-row slot cannot hold the value's first character. This case assumes that each value character fits within the full content width.

## Scenarios

- With label `From:`, value `review`, and content width 6, the renderer places `From: ` and `review` on separate rows.
- With label `L:`, value `界ab`, and content width 4, the renderer places `L: ` and `界ab` on separate rows because `界` needs two columns and the first-row slot has one.
- At content widths 7, 9, and 12, the renderer keeps `From:` and the start of `review` on the first row.
- Main and subagent screens render selected transitions in compact and expanded modes, with live and replay results.

## Scope and Non-Scope

The shared labeled wrapping helper and affected wrapping documentation are in scope. Pi source, dependencies, shell selection, screen-specific wrappers, collapsed run-subagent name rendering, and Pi Box behavior at total width 1 are outside scope.

## Requirements

### Functional Requirements

- [ ] FRQ-01: When the first-row slot cannot hold the first value character and each value character fits within the full content width, the renderer shall keep the label and separator on the first row and wrap the complete value on continuation rows. It shall retain separate label and value styles.
  - Origin: source. The task requires first-row allocation for zero value capacity and a first character that cannot fit the remaining slot.
  - Goal: Prevent overflow caused by appending a full-width value row to the label.
  - Goal achievement: Full. The label and value occupy separate rows under the stated conditions.
  - Feasibility: Confirmed. The value can use the full width of the following rows; the isolated zero-capacity and two-column-character checks pass.
- [ ] FRQ-02: When the first-row slot can hold value text, the renderer shall keep the label and the start of the value on the first row and wrap the remainder at the full content width.
  - Origin: source. The task requires preservation of normal layout.
  - Goal: Retain label and value sharing when space permits.
  - Goal achievement: Full. The normal-width layout remains available alongside the separate-row case.
  - Feasibility: Confirmed. The normal-width checks pass at content widths 7, 9, and 12.
- [ ] FRQ-03: The workflow renderer shall use shared rendering on main and subagent screens. For each compact reference, it shall show at most four visual lines, with the tool title and hidden-line hint outside that budget. The hint shall report hidden and total line counts. During replay, the renderer shall use the saved endpoints and selected ground. Expanded references shall preserve source line breaks and show all lines.
  - Origin: source. The task requires shared main/subagent rendering and preservation of budgets and layout.
  - Goal: Preserve workflow presentation while correcting first-row allocation.
  - Goal achievement: Full. Both screens retain reference limits, expansion behavior, and saved transition content.
  - Feasibility: Confirmed. Both screens use shared rendering, and the selected-transition checks cover compact and expanded live and replay results.

### Non-Functional Requirements

- [ ] NRQ-01: For selected-transition fixtures, the first public Pi tool render at total width 8, followed by renders at total widths 22 and 120, shall produce rows whose visible widths are at most the supplied total width. The checks shall cover all eight combinations of main/subagent screen, compact/expanded mode, and live/replay result.
  - Origin: source. The task requires public Pi checks at widths 8, 22, and 120.
  - Goal: Verify first-row allocation inside Pi's default tool shell.
  - Goal achievement: Partial. These checks cover the selected-transition fixtures at the three specified widths.
  - Feasibility: Confirmed. All eight combinations pass the visible-width assertions.
- [ ] NRQ-02: Regression tests shall use isolated fixture data and rendering assertions without checking production prompt text. Full validation with `bun run verify` shall exit successfully.
  - Origin: source. Project testing rules require isolated fixtures, prohibit prompt-content checks, and define full validation.
  - Goal: Verify the correction without real user state or production prompt assertions.
  - Goal achievement: Partial. The regression cases and full validation check the requested behavior and package checks.
  - Feasibility: Confirmed. The supplied full validation completes successfully with the fixture-based regressions.

## Open Questions

None.

## Technical Supplement

The public helper entry point is `renderLabeledWrappedText` in `pi-package/shared/labeled-wrapped-text.ts`.

## References

- [solution.md](solution.md)
