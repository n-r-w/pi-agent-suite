# Problem Statement

## Context

The workflow extension uses an append-only journal to publish workflow lifecycle data and catalog activation availability to the model. An empty activation-options record has replacement semantics when activation options that were published earlier in the same context segment become unavailable.

Agent selection can change during a session. The selected agent can allow or deny workflow catalog entries and workflow tools, but the session can retain workflow state created before that agent change.

## Problem Statement

The workflow extension publishes an empty activation-options record when no activation options are available without distinguishing a required replacement from a context segment that has no earlier activation-options list. This creates redundant model-facing workflow data in new context segments.

## Who is affected

- Models receiving session context with no available activation options and no earlier list to invalidate.
- Users who inspect session history or pay for tokens sent to the model.
- Developers who maintain workflow journal restoration and agent-policy behavior.

## Evidence

- `pi-package/extensions/workflow/index.ts` calls `publishWorkflowActivationOptions` after session synchronization and compaction.
- `publishWorkflowActivationOptions` passes an empty list when `workflow_activate` is not active.
- `pi-package/extensions/workflow/context.ts` renders an empty list as `<workflow_activation_options />` and persists it through `pi.sendMessage` as a hidden workflow message.
- `test/integration/runtime-package-loading.test.ts` expects the empty record when workflow projection is unavailable because of agent tool policy or `workflows: []`.
- The supplied session-tree capture contains `[workflow]: <workflow_activation_options />` in a new Simple-agent session with no earlier activation-options list.
- Code-path inspection found no other redundant workflow publication in the same baseline. Workflow system-prompt guidance, provider tools, lifecycle records, reminders, checkpoints, and visible TUI status are absent when their owning capabilities or state are absent.

## Impact

- Each redundant record consumes model-context tokens without changing model-visible workflow availability.
- The record adds workflow terminology to sessions where the model has no activation option to use.
- Session history contains a workflow entry that does not represent workflow activity or invalidate earlier data.
- The record can recur when branch navigation or compaction creates a context segment without an earlier activation-options list.

## Reproduction Steps

1. Select an agent that has no active `workflow_activate` tool.
2. Start a session whose selected branch has no workflow state or activation-options record.
3. Open the session tree.
4. Observe the hidden workflow entry with `<workflow_activation_options />`.
5. Compact the session or select a branch segment without an activation-options record.
6. Observe that the extension can publish another empty record for the new context segment.

## Current State

The workflow journal uses `<workflow_activation_options />` for two different conditions:

1. The same context segment contains an earlier non-empty activation-options record that must be invalidated.
2. The context segment contains no earlier activation-options record.

The first condition requires a replacement record. The second condition creates a redundant empty record.

Workflow lifecycle publication follows restored workflow state separately from activation-option availability. A session can therefore retain workflow state while the current agent hides workflow tools. That journal continuity is required so a later agent change can restore usable workflow capabilities without losing model-facing lifecycle state.

## Desired Outcome

The workflow journal publishes an empty activation-options record only when it invalidates an earlier non-empty activation-options record in the same context segment.

Workflow lifecycle and restoration records required by persisted workflow state continue to be published independently of current agent selection, workflow catalog policy, and workflow-tool visibility.

## Success Metrics

- A new context segment with no activation options and no earlier activation-options record receives no empty activation-options record.
- Branch navigation to a context segment with no activation-options history adds no empty activation-options record.
- Compaction adds no empty activation-options record when the new segment has no activation-options list to invalidate.
- Removing activation availability after a non-empty activation-options publication produces one replacement record in that context segment.
- Switching to an agent without workflow catalog access or workflow tools does not interrupt records required by persisted workflow state.
- Switching back to an agent with workflow capabilities preserves workflow restoration and continuation.

## Scope

- Activation-options publication during session start, branch navigation, compaction, and agent-policy changes.
- Workflow journal continuity across agent changes.
- Main-agent and subagent policy paths.

## Out of Scope / Non-Goals

- Changing the meaning of `workflows: []`, which blocks catalog activation but does not independently block dynamic workflow creation.
- Suppressing lifecycle, checkpoint, completion, or reminder records required by workflow state.
- Removing a replacement record when the same context segment contains an earlier non-empty activation-options record.
- Redesigning workflow message formats or workflow-state persistence.

## Constraints

- Workflow state remains authoritative for runtime reconstruction.
- Agent tool policy remains the final gate for provider tool visibility.
- Agent selection must not remove or reset persisted workflow state.
- Compaction and branch restoration must not expose stale activation options.
- Catalog activation, dynamic workflow creation, transition, editing, completion, reminder, and restoration behavior must remain available when their existing conditions apply.

## Assumptions

None.

## Open Questions

None.
