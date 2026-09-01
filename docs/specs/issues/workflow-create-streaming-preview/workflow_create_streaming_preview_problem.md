# Problem Statement

## Context

Pi users can observe tool arguments while the model generates a tool call in the interactive TUI. The `workflow_create` tool currently delays its workflow content presentation until the arguments are complete.

## Problem Statement

During `workflow_create` argument generation, the TUI does not show the workflow definition received so far.

## Who is affected

Pi users who create workflows through the interactive TUI.

## Evidence

- `renderWorkflowCreateCall` passes workflow content to the renderer only when `context.argsComplete` is true.
- Project-owned MCP, subagent, advisor, council, and vision renderers show bounded previews of current call content.
- Project-owned compact tool renderers distinguish labels with bold `toolTitle` styling and values with `toolOutput` styling.
- The reported user scenario requires partial content in collapsed mode, complete received content in expanded mode, and consistent compact label styling.

## Impact

Users cannot inspect the workflow definition while it is being generated. They must wait until argument generation finishes before they can examine its content.

## Reproduction Steps

1. Start a `workflow_create` call in the interactive TUI.
2. Observe the call while the model generates its arguments.
3. Expand the call before argument generation finishes.
4. Confirm that the received workflow content is not shown.

## Current State

Before argument completion, `workflow_create` can show the workflow reference but hides the initial stage and workflow content. After completion, collapsed mode replaces the workflow content with an expansion hint. Expanded mode shows the complete content as YAML.

## Desired Outcome

Collapsed mode shows a bounded preview of the workflow content received so far and visually distinguishes semantic labels from values. Expanded mode shows all workflow content received so far.

## Success Metrics

- Received workflow content is visible before `context.argsComplete` becomes true.
- Collapsed mode shows no more than three visual content lines.
- Collapsed `Workflow:`, `Stage:`, `From:`, `To:`, and `Content:` labels use bold `toolTitle` styling while their values use `toolOutput` styling.
- Expanded mode shows the complete received workflow content without presentation changes.
- The active screen and subagent session screen render identical data for the same arguments and expansion state.

## Scope

The call presentation of `workflow_create` during and after argument generation.

## Out of Scope / Non-Goals

- Changing the `workflow_create` schema or validation.
- Changing workflow creation execution.
- Changing workflow result presentation.
- Changing other workflow tools.

## Constraints

- The renderer must keep every line within the width supplied by the Pi tool shell.
- The active screen and subagent session screen must use the same presentation logic.
- Tests must verify rendering behavior without asserting prompt text.

## Assumptions

None.

## Open Questions

None.
