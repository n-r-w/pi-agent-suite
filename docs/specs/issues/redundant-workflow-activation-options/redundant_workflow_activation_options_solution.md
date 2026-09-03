# Technical Solution: Remove Redundant Workflow Activation-Options Records

## Problem Statement

See [Problem Statement](redundant_workflow_activation_options_problem.md).

- PRB-01: `WorkflowJournal.activationOptions` publishes `<workflow_activation_options />` in a context segment that contains no earlier activation-options record.
- PRB-02: Workflow journal records required by persisted workflow state must continue across agent changes, including periods when the selected agent has no workflow tools.

## Proposed Solution

### Activation-options publication

- SOL-01: Keep activation-options publication ownership in `WorkflowJournal.activationOptions` in `pi-package/extensions/workflow/context.ts`.
- SOL-02: Suppress an empty activation-options value when `activationOptionsContent` is `undefined`.
- SOL-03: Keep the existing exact-content deduplication for every previously published activation-options value.

The method applies checks in this order:

```ts
const content = renderActivationOptions(workflows);
if (content === this.activationOptionsContent) {
	return;
}
if (workflows.length === 0 && this.activationOptionsContent === undefined) {
	return;
}
```

Publication and assignment to `activationOptionsContent` remain unchanged after these checks.

The resulting state transitions are:

| Previous value in the context segment | Resolved options | Result |
| --- | --- | --- |
| None | Empty | No record |
| None | Non-empty | Publish options |
| Non-empty | Empty | Publish one replacement record |
| Empty | Empty | No record |
| Empty | Non-empty | Publish options |
| Non-empty | Same non-empty value | No record |
| Non-empty | Different non-empty value | Publish options |

`WorkflowJournal.restore` already restores `activationOptionsContent` from workflow messages in the selected context segment. `WorkflowJournal.startContextSegment` already resets it to `undefined`. The new condition therefore applies consistently after session start, branch navigation, compaction, and agent-policy changes.

### Workflow journal continuity

- SOL-04: Do not change workflow-state replay, lifecycle publication, reminder scheduling, completion, checkpoint publication, or model-runtime restoration.
- SOL-05: Keep `runtime.state` independent of selected-agent workflow policy and active workflow-tool filtering.
- SOL-06: Keep tool reconciliation responsible only for provider tool visibility. It must not clear persisted workflow state or journal state.

A policy change from available activation options to no activation options still publishes one replacement record when the non-empty options exist in the context segment. Persisted workflow state continues to drive lifecycle records while workflow tools are hidden. Returning to an agent with workflow capabilities recalculates tools from the preserved state and policy.

### Lifecycle integration

- SOL-07: Keep `publishWorkflowActivationOptions` calls in the session synchronizer, compaction handler, and agent-policy refresh path.
- SOL-08: Do not add event-specific suppression conditions. `WorkflowJournal.activationOptions` owns the context-segment publication rule for every caller.

### Tests

- SOL-09: Add `WorkflowJournal` behavior coverage for the state-transition table using record counts and `details.kind` rather than message content.
- SOL-10: Update workflow extension tests so initial synchronization and compaction with no activation options produce no activation-options record.
- SOL-11: Keep coverage that non-empty options followed by empty options produce one replacement record.
- SOL-12: Add or update agent-change coverage so persisted workflow state survives selection of an agent without workflow tools and remains usable after switching back.
- SOL-13: Update real Pi main-agent and subagent policy checks so a context with no activation options and no earlier workflow record has zero workflow custom messages.
- SOL-14: Do not add assertions against prompt or workflow-message content. Tests observe record count, `details.kind`, persisted workflow state, and active tool names.

Validation commands:

```bash
bun run test
bun run typecheck
bun run check
bun run verify
```

### Documentation

- SOL-15: Update `docs/extensions/workflow.md` to state that `<workflow_activation_options />` is published only as a replacement for non-empty activation options in the same context segment.
- SOL-16: Document that a context segment with no available activation options and no earlier activation-options record receives no activation-options message.
- SOL-17: Preserve the documented rule that agent workflow policy does not delete or block saved workflow state.

## Overengineering and Overspecification Considerations

- DEC-01: Reuse `activationOptionsContent` as the context-segment publication state. A new flag, state format, journal record, or persistence field is unnecessary.
- DEC-02: Centralize the condition in `WorkflowJournal.activationOptions` rather than duplicating it across lifecycle handlers.
- DEC-03: Leave workflow lifecycle and restoration code unchanged because those paths already use persisted workflow state independently from activation-option availability.
- DEC-04: Limit test changes to publication decisions, agent-change continuity, and assertions directly affected by the new behavior.

## Open Questions

None.

## References

- REF-01: [Problem Statement](redundant_workflow_activation_options_problem.md) - Approved problem scope and desired outcome.
- REF-02: [Domain Glossary](redundant_workflow_activation_options_glossary.md) - Workflow journal and activation-options terminology.
- REF-03: [Product Requirements](redundant_workflow_activation_options_prd.md) - Approved requirements.
- REF-04: `pi-package/extensions/workflow/context.ts` - Workflow journal state, rendering, restoration, and publication.
- REF-05: `pi-package/extensions/workflow/index.ts` - Lifecycle integration, policy refresh, tool reconciliation, and compaction.
- REF-06: `pi-package/extensions/workflow/context.test.ts` - Workflow journal behavior tests.
- REF-07: `pi-package/extensions/workflow/index.test.ts` - Workflow extension lifecycle and policy tests.
- REF-08: `test/integration/runtime-package-loading.test.ts` - Real Pi main-agent and subagent policy checks.
- REF-09: `docs/extensions/workflow.md` - Current workflow extension behavior.
