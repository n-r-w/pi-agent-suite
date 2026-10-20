# Technical Solution: Stage Presentation with Optional Thinking

## Problem Statement
See [problem.md](problem.md) and [prd.md](prd.md). Definitions are in [terms.md](terms.md).

## Proposed Solution

### SOL-01: Optional thinking at the presentation boundary
For FRQ-01 and FRQ-02, the presentation parser accepts saved stage attributes with a model object and no thinking value. The renderer displays the remaining attributes within the selected display mode.

In `pi-package/extensions/workflow/tool-rendering.ts`, `parseStageContent` accepts an absent `model.thinking`. When thinking is provided, the parser requires a non-empty string. It also requires a model object and non-empty strings for ID, description, and prompt. A provided goal must be a non-empty string; provided initial/final flags must be booleans.

`WorkflowStageContent.model` represents optional string thinking. `createStageAttributes` selects `Description`, optional `Goal`, `Prompt`, optional `Thinking`, and optional `Initial` and `Final`, in that order. When valid metadata contains `model: {}`, the renderer omits only `Thinking` from this selection.

For example, a user viewing a stored `workflow_get_stage` block with description `Saved stage`, prompt `Saved instructions`, `model: {}`, and flags `initial: true` and `final: false` sees these compact rows when each row fits on one line:

```text
Description: Saved stage
Prompt: Saved instructions
Initial: true
Final: false
```

If the metadata also contains a goal, the renderer inserts `Goal` between `Description` and `Prompt`. Compact mode has a four-visual-line attribute budget and a hint for hidden lines. Expanded mode displays all saved attributes as labeled sections. Neither mode includes `Thinking` for this input.

### SOL-02: Known edit values
For FRQ-03, the renderer displays only captured thinking values. A new value without a prior value appears on its own; two different known values appear as a comparison.

In `pi-package/extensions/workflow/tool-rendering.ts`, `createStageChanges` compares optional thinking values directly. When only the new value is known, it uses that value as the row's `value` and omits `nextValue`. When both values are known and differ, it supplies both `value` and `nextValue`. When the replacement value is absent or equals the prior value, it omits the Thinking row. It selects description, goal, and prompt changes independently of thinking.

For example, saved `model: {}` followed by replacement `model: { thinking: "high" }` produces `Thinking: high` in compact mode. Expanded mode contains a `--- Thinking ---` section with `high` and no comparison arrow. A known prior value of `medium` and a new value of `high` produce `Thinking: medium -> high` in compact mode. When the replacement thinking value is absent, other captured changes remain visible.

These rules concern saved presentation metadata. The stage-edit tool still requires a thinking value in its replacement input, as described in [workflow_edit_stage](../../../extensions/workflow.md#workflow_edit_stage). Accepting omitted thinking in presentation metadata leaves that input contract, workflow state, and runtime model settings unchanged.

### SOL-03: Shared first-render behavior and validation
For FRQ-04 and NRQ-01, main and subagent screens use the shared renderer and Pi's default tool shell. In `pi-package/extensions/workflow/tool-rendering.ts`, `renderWorkflowResult` restores saved presentation metadata into shared render state. `renderWorkflowStageCall` reads that state inside its deferred row callback, so the first render after result delivery can display the saved attributes. The renderer uses the shared compact budget and terminal-width wrapping.

For NRQ-02, the regression cases in `pi-package/extensions/workflow/tool-rendering.test.ts` use Pi's public `ToolExecutionComponent`. They cover inspection of restored format-1 stages without model overrides, JSON-round-tripped replay on fresh fixtures, independent saved metadata with a goal, and edits with absent prior thinking. The cases exercise main and subagent adapters, compact and expanded modes, and widths of 22 and 100 columns. Additional cases check supplied thinking values, malformed attributes, and edit metadata with an absent replacement thinking value. Assertions inspect non-prompt attributes and the Prompt section's structure.

For NRQ-03, `bun run verify` runs behavior tests, type checks, and lint/format checks. The implementation uses the declared dependencies and requires no lint suppressions.

## Overengineering and Overspecification Considerations
No elements extend beyond the presentation parser and attribute selection needed for the requirements. The renderer uses the shared shell, budget, and wrapping. It introduces no default thinking value, state migration, or dependency. Test fixture organization remains an implementation detail.

## Open Questions
None.

## References
- `pi-package/extensions/workflow/tool-rendering.ts`: `parseStageContent`, `createStageAttributes`, and `createStageChanges` define presentation parsing and attribute selection.
- `pi-package/extensions/workflow/tool-rendering.test.ts`: regression cases exercise Pi's public tool component.
- [Workflow extension](../../../extensions/workflow.md#tool-presentation): user-visible presentation.
