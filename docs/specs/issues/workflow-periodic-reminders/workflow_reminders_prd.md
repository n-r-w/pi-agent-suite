# Idea: Periodic Active Workflow Reminders

## Definitions

- **Activity unit**: One completed tool call, or one completed reasoning turn when that turn has no tool calls.
- **Reminder interval**: The number of activity units between model-facing messages that carry current workflow state.
- **Workflow reminder**: A hidden model-facing message that does not change workflow state.

## Context and Problem

During a long stage with no transition or compaction, workflow information moves farther from the end of model context. No newer workflow state message is published based on completed tool calls or reasoning turns.

An aggregate analysis of 6,467 active-stage intervals from 688 workflow sessions found p95 at 35 tool calls and p99 at 83. The configured default remains `50`. The analysis did not measure reasoning turns, so it does not determine the resulting reminder frequency under the activity-unit rule.

## Goal

Return a compact current workflow state to the end of model context after a configured number of activity units.

## Scenarios

- An active workflow remains on one stage for the configured number of activity units.
- A completed reasoning-only turn contributes one retained activity unit.
- One parallel tool-call batch crosses the reminder interval.
- Activation, stage entry, current-stage editing, or compaction publishes fresh workflow state and starts a new interval.
- A reminder interval of `0` disables periodic reminders.

## Scope and Non-Scope

In scope:
- Active workflows.
- One activity-unit counter.
- One extension-wide reminder interval.
- One compact reminder before the next existing model request.

Out of scope:
- Per-workflow reminder intervals.
- Adaptive interval selection.
- Reminders for completed workflows.
- Root guidelines, stage guidelines, available transitions, inactive stages, and the complete workflow graph in reminders.

## Requirements

- While a workflow is active, each completed turn contributes the greater of its tool-call count and one reasoning unit.
- A final assistant message has one reasoning unit when any `thinking` block contains text, a `thinkingSignature`, or `redacted: true`.
- Multiple reasoning blocks in one completed turn contribute one reasoning unit.
- Workflow activation, stage entry, current-stage editing, checkpoint publication, and periodic reminders reset the counter.
- When the counter reaches the configured interval during a non-terminating tool turn, the extension adds one `steer` reminder before the next request in the tool loop.
- When the counter reaches the configured interval during a reasoning-only turn, the extension adds one `nextTurn` reminder for the next user-triggered request without starting another model request.
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
