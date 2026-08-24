# Idea: Periodic Active Workflow Reminders

## Definitions

- **Reminder interval**: The number of tool calls between model-facing messages that carry current workflow state.
- **Workflow reminder**: A hidden model-facing message that does not change workflow state.

## Context and Problem

During a long stage with no transition or compaction, workflow information moves farther from the end of model context. No newer workflow state message is published based on tool-call volume alone.

An aggregate analysis of 6,467 active-stage intervals from 688 workflow sessions found p95 at 35 tool calls and p99 at 83. An interval of 50 is reached by 2.83% of stage intervals and would produce about 0.43 reminders per workflow session.

## Goal

Return a compact current workflow state to the end of model context after a configured number of tool calls.

## Scenarios

- An active workflow remains on one stage for the configured number of tool calls.
- One parallel tool-call batch crosses the reminder interval.
- Activation, stage entry, current-stage editing, or compaction publishes fresh workflow state and starts a new interval.
- A reminder interval of `0` disables periodic reminders.

## Scope and Non-Scope

In scope:
- Active workflows.
- One tool-call counter.
- One extension-wide reminder interval.
- One compact reminder before the next existing model request.

Out of scope:
- Per-workflow reminder intervals.
- Adaptive interval selection.
- Reminders for completed workflows.
- Root guidelines, stage guidelines, available transitions, inactive stages, and the complete workflow graph in reminders.

## Requirements

- The extension counts every tool call while a workflow is active.
- Workflow activation, stage entry, current-stage editing, checkpoint publication, and periodic reminders reset the counter.
- When the counter reaches the configured interval, the extension adds one reminder before the next existing model request.
- A reminder contains only the workflow ID and current stage ID.
- Every parallel tool call counts separately. One parallel batch produces no more than one reminder.
- The reminder interval applies to the complete workflow extension and defaults to `50`.
- The reminder interval accepts an integer greater than or equal to `0`. A value of `0` disables periodic reminders.

## Open Questions

No open questions remain.

## Technical Supplement

Technical design is defined in `workflow_reminders_solution.md`.

## References

- `workflow_reminders_problem.md`
- `workflow_reminders_glossary.md`
- `docs/extensions/workflow.md`
