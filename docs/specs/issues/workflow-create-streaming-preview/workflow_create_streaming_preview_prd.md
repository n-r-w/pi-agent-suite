# Idea: Streaming Preview for `workflow_create`

## Definitions

- Workflow content: the `description`, optional `prompt`, `stages`, and `transitions` fields received by `workflow_create`.
- Visual line: one rendered terminal row after wrapping to the available TUI width.
- Collapsed mode: the bounded tool-call presentation shown by default.
- Expanded mode: the full tool-call presentation selected through `app.tools.expand`.

## Context and Problem

The problem is defined in `workflow_create_streaming_preview_problem.md`.

## Goal

Show the workflow definition received so far while `workflow_create` arguments are being generated.

## Scenarios

- A user observes workflow generation in collapsed mode.
- A user expands an in-progress call to inspect all received workflow content.
- A user inspects a completed successful or rejected call.

## Scope and Non-Scope

Scope includes `workflow_create` call presentation on the active screen and subagent session screen. The tool schema, validation, execution, and result presentation are outside scope.

## Requirements

- `workflow_create` must display received workflow content before `context.argsComplete` becomes true.
  Justification: the reported scenario requires content visibility during generation. Project-owned MCP, subagent, and universal renderers render current arguments without waiting for `argsComplete`.
- Collapsed mode must show no more than three visual lines of workflow content and must show a hidden-content hint when additional lines exist.
  Justification: `consult_advisor`, `convene_council`, MCP, and subagent call renderers use a three-visual-line preview with an expansion hint.
- Expanded mode must show all workflow content received at render time.
  Justification: the reported scenario requires complete received content in expanded mode. Project-owned call renderers show complete content when expanded.
- The preview must use the existing YAML representation of workflow content.
  Justification: `renderWorkflowContent`, `serializeWorkflowContent`, `docs/extensions/workflow.md`, and workflow rendering tests define YAML as the current expanded representation.
- A completed collapsed call must retain the content preview instead of replacing it with `Content: ... to show`.
  Justification: the requested collapsed presentation includes partial generated content. The current completed presentation contains only an expansion instruction.
- Collapsed `Workflow:`, `Stage:`, `From:`, `To:`, and `Content:` labels must use bold `toolTitle` styling while their values use `toolOutput` styling.
  Justification: the supplied TUI evidence shows these labels without visual distinction. Project-owned compact renderers and workflow stage attributes use bold `toolTitle` labels with `toolOutput` values.
- Existing tool-name, workflow, and initial-stage rows must remain available as their source data becomes available.
  Justification: `docs/extensions/workflow.md` defines these rows, and `tool-rendering.test.ts` verifies them on active and subagent session screens.
- The active screen and subagent session screen must render identical data for identical arguments and expansion state.
  Justification: `AGENTS.md` requires consistent TUI rendering on both screens, and existing workflow rendering tests compare them.

## Open Questions

None.

## Technical Supplement

The three-line limit applies only to rendered YAML content. The `Content:` label and hidden-content hint do not count against this limit. Expanded presentation styling does not change.

## References

- `AGENTS.md`
- `docs/extensions/workflow.md`
- `pi-package/extensions/workflow/tool-rendering.ts`
- `pi-package/extensions/workflow/tool-rendering.test.ts`
- `pi-package/shared/tool-presentation/bounded.ts`
