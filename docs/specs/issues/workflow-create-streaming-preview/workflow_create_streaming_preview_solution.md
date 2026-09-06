# Technical Solution: Streaming Preview for `workflow_create`

## Problem Statement

- PRB-01: `renderWorkflowCreateCall` hides workflow content until `context.argsComplete` becomes true, so users cannot inspect the definition during generation.

## Proposed Solution

### Rendering behavior

- SOL-01: `renderWorkflowCreateCall` passes current arguments to `createWorkflowContent` regardless of `context.argsComplete`.
- SOL-02: `createWorkflowContent` accepts an incomplete argument object and returns the received `description`, `prompt`, `stages`, and `transitions` fields. It returns no content before any displayable field is present.
- SOL-03: The workflow `id` remains in the `Workflow` row and is not duplicated in YAML.
- SOL-04: The initial stage row appears when the current arguments contain enough data to identify it.
- SOL-05: Collapsed mode renders a `Content:` label followed by no more than three visual YAML lines. The label does not count against the content limit.
- SOL-06: When YAML exceeds three visual lines, the renderer adds the existing `BoundedToolResult` hidden-content hint. The hint does not count against the content limit.
- SOL-07: Expanded mode keeps the `--- Content ---` section and renders all received workflow content as YAML without styling changes.
- SOL-08: `primeWorkflowRenderState` continues to persist presentation state only after `context.argsComplete` becomes true. Partial presentation data is not stored as completed result details.
- SOL-09: Compact `Workflow:`, `Stage:`, `From:`, `To:`, and `Content:` labels use bold `toolTitle` styling. Reference values and YAML remain `toolOutput`.

### Code changes

- DEC-01: Use `BoundedToolResult` with `collapsedContentLineLimit: 3` and `renderCollapsedLines` for the compact YAML preview.
- DEC-02: Keep `serializeWorkflowContent` as the single YAML serialization and width-fitting path for collapsed and expanded modes.
- DEC-03: Keep the existing default Pi tool shell. Do not add a custom shell or renderer compatibility layer.
- CMP-01: Update `pi-package/extensions/workflow/tool-rendering.ts` for incremental content extraction and compact preview rendering.
- CMP-02: Update `pi-package/extensions/workflow/tool-rendering.test.ts` for streaming, collapsed, expanded, compact label styling, width, and screen-parity behavior.
- CMP-03: Update `docs/extensions/workflow.md` to describe the new collapsed and in-progress presentation.

### Test-driven implementation

- TSK-01: Add a failing streaming-call test before changing production code.
  - Purpose: prove that received content is visible while `argsComplete` is false.
  - Input: successive incomplete argument objects rendered through one `workflow_create` definition.
  - Expected output: collapsed YAML updates as fields arrive and expanded mode contains every received field.
  - Edge case: no `Content:` section exists before a displayable workflow field arrives.
  - Dependencies: the existing workflow rendering fixture and `createToolRenderContext`.
- TSK-02: Update the completed-call test before changing production code.
  - Purpose: replace the collapsed expansion-only row with a bounded YAML preview.
  - Input: successful and rejected completed calls.
  - Expected output: both calls retain the preview, while successful result output remains empty and rejected result output keeps its error presentation.
  - Edge case: content of three or fewer visual lines has no hidden-content hint.
  - Dependencies: `renderCompletedTool` and the active and reconstructed session definitions.
- TSK-03: Update width and screen-parity tests.
  - Purpose: preserve the default tool-shell width contract and identical rendering on both screens.
  - Input: narrow-width collapsed and expanded workflow calls.
  - Expected output: every rendered line fits the supplied width, and active and subagent session output match.
  - Edge case: long YAML scalar values require width-aware serialization.
  - Dependencies: Pi `Box`, `visibleWidth`, and existing workflow fixtures.
- TSK-04: Add a compact-label styling test before changing production styling.
  - Purpose: distinguish semantic labels from their values without changing expanded mode.
  - Input: collapsed `workflow_create` and transition calls rendered with a marked theme.
  - Expected output: labels use bold `toolTitle`; values and YAML use `toolOutput`.
  - Edge case: expanded rows remain byte-for-byte equal to their pre-change marked-theme output.
  - Dependencies: existing `MARKED_THEME`, workflow rendering fixtures, and `renderReference`.
- CNS-01: Tests verify structure, field presence, line budgets, state transitions, and theme roles. They do not assert prompt text.

### Acceptance criteria

- ACC-01: Received workflow content is visible when `context.argsComplete` is false.
- ACC-02: Collapsed mode shows at most three visual YAML lines.
- ACC-03: Collapsed mode shows a hidden-content hint when additional visual lines exist.
- ACC-04: Expanded mode shows all workflow content received at render time.
- ACC-05: Completed calls retain the same content preview behavior.
- ACC-06: Active and subagent session screens render identical data.
- ACC-07: Workflow schema validation, execution, and result behavior do not change.
- ACC-08: Collapsed semantic labels use bold `toolTitle`, values use `toolOutput`, and expanded presentation remains unchanged.

## Overengineering and Overspecification Considerations

- TRD-01: The solution changes the existing renderer, tests, and documentation only.
- TRD-02: `BoundedToolResult` already owns the required visual-line budget and hidden-content hint.
- TRD-03: No new shared abstraction or change to other tools is required.

## Open Questions

None.

## References

- REF-01: `workflow_create_streaming_preview_problem.md` - approved problem statement.
- REF-02: `workflow_create_streaming_preview_prd.md` - approved product requirements.
- REF-03: `docs/extensions/workflow.md` - current workflow tool presentation contract.
- REF-04: `pi-package/extensions/workflow/tool-rendering.ts` - current workflow renderer.
- REF-05: `pi-package/shared/tool-presentation/bounded.ts` - shared bounded preview implementation.
