# Problem Statement

## Context

The workflow extension publishes model-facing state when a workflow is activated, a stage changes, a stage definition changes, the workflow completes, or session context is compacted.

## Problem Statement

A long-running active stage can execute many tool calls without publishing another workflow state message. The active workflow and stage information then moves farther from the end of model context.

## Who is affected

- Models working through tool-heavy workflow stages.
- Users who otherwise need to repeat the active workflow state manually.

## Evidence

- `pi-package/extensions/workflow/context.ts` publishes activation, stage activation, stage update, completion, and checkpoint records.
- `pi-package/extensions/workflow/index.ts` does not publish workflow state based on elapsed tool calls.
- `docs/extensions/workflow.md` documents the append-only workflow journal and its lifecycle publication points.

## Impact

The model can lose attention to the active workflow, current stage, and available transitions during a long stage. This risk is a user-reported concern and has not been measured across models.

## Reproduction Steps

1. Activate a workflow.
2. Remain on one stage without editing it or compacting context.
3. Execute many tool calls across consecutive model turns.
4. Observe that no newer workflow state record is added by tool-call volume alone.

## Current State

The original workflow record remains in persistent history. The extension adds no periodic workflow record while the active stage remains unchanged.

## Desired Outcome

The model periodically receives a compact marker for the current workflow and active stage during long tool loops without manual user reminders.

## Success Metrics

- A deterministic run adds one current workflow reminder after the configured tool-call interval.
- A parallel tool-call batch adds no more than one reminder before the next model request.
- The reminder contains only the current workflow ID and active stage ID.

## Scope

- Active workflows with many tool calls between lifecycle publications.
- Model-facing workflow state inside the existing session context.

## Out of Scope / Non-Goals

- Measuring model attention across providers.
- Repeating full workflow definitions or stage guidelines.
- Reminding completed workflows.

## Constraints

- Workflow state entries remain authoritative for runtime reconstruction.
- Reminder publication must preserve the append-only journal design.
- Repetition must remain bounded to limit context growth.

## Assumptions

The concern primarily applies to uninterrupted active workflows with many tool calls and no stage transition or compaction.

## Open Questions

No open questions remain.
