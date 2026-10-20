# Technical Solution: Labeled text first-row width boundary

## Problem Statement

See [problem.md](problem.md) and [prd.md](prd.md).

## Proposed Solution

In `pi-package/shared/labeled-wrapped-text.ts`, `wrapTextWithFirstLineWidth` returns an empty first entry when the first-row slot has no capacity or cannot hold the first value character. It wraps the complete value at the full content width after that entry. `renderLabeledWrappedText` prefixes the empty entry with the styled label and a value-styled separator. It applies the value style to the continuation rows.

For label `From:`, value `review`, and content width 6, the helper returns `From: ` and `review` on separate rows. For label `L:`, value `界ab`, and content width 4, the helper returns `L: ` and `界ab` on separate rows because the two-column character cannot fit the one-column first-row slot.

When the label fills or exceeds the content width, `renderLabeledWrappedText` still truncates the label and starts the value on the next row. When the first-row slot can hold value text, the helper still shares the first row between the label and value. It uses the display-width primitives in `pi-package/shared/display-width.ts` for both cases.

Workflow references and other callers use the shared helper. The workflow renderer applies its four-line compact budget separately to each reference, with the tool title and hidden-line hint outside that budget. It retains saved endpoints and selected-ground data for replay. Main and subagent screens use the shared workflow renderer. Expanded references continue to use Pi's `Text` wrapping and preserve source line breaks.

The correction covers first-row allocation when each value character fits within the full content width. Pi's default shell supplies that width after padding. Pi Box behavior at total width 1 and the collapsed run-subagent `renderName` branch remain outside scope.

### Verification

`pi-package/shared/labeled-wrapped-text.test.ts` calls the public helper with isolated values. It checks zero value capacity, a two-column character in a one-column first-row slot, separate label and value styles, preservation of the fixture values, and normal-width sharing.

`pi-package/extensions/workflow/tool-rendering.test.ts` checks the first public `ToolExecutionComponent` render at total width 8, followed by widths 22 and 120. It checks all eight combinations of main/subagent screen, compact/expanded mode, and live/replay result. For each combination, the test checks row widths, endpoint and selected-ground rows, and saved transition metadata. Full validation uses `bun run verify`.

## Overengineering and Overspecification Considerations

Retaining an empty entry in the two fallback branches is the smallest correction that keeps the label separate from a full-width value row. Helper tests cover both allocation branches and normal-width sharing. The public Pi checks cover shell integration required by NRQ-01. No additional abstraction or configuration is required. Callers retain their preview budgets and styles.

## Open Questions

None.

## References

- [Workflow tool presentation](../../../extensions/workflow.md#tool-presentation)
