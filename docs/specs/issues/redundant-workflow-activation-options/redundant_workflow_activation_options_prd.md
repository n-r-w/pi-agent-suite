# Idea: Remove Redundant Workflow Activation-Options Records

## Definitions

Terms are defined in [Domain Glossary](redundant_workflow_activation_options_glossary.md).

## Context and Problem

See [Problem Statement](redundant_workflow_activation_options_problem.md).

## Goal

Remove empty activation-options records that do not invalidate earlier activation options while preserving workflow journal continuity across agent changes.

## Scenarios

- A session starts without available catalog workflows and without an earlier activation-options record.
- Branch navigation selects a context segment without an earlier activation-options record.
- Compaction creates a context segment without an earlier activation-options record.
- An agent or policy change removes catalog workflows that were published earlier in the context segment.
- A session with persisted workflow state switches to an agent without workflow tools and later switches back.

## Scope and Non-Scope

In scope:

- Activation-options publication during `session_start`, `session_tree`, `session_compact`, and agent-policy changes.
- Workflow journal continuity across main-agent changes.
- Main-agent and subagent policy paths.

Out of scope:

- Changes to the meaning of `workflows: []`.
- Changes to workflow-state persistence.
- Changes to lifecycle records required by persisted workflow state.
- Changes to ready-made or dynamic workflow behavior outside activation-options publication and agent-change continuity.

## Requirements

- `REQ-01`: The workflow extension must not publish `<workflow_activation_options />` when the model-visible context contains no earlier activation-options record with one or more catalog workflows.
  - Justification: The empty record has no earlier availability to invalidate.
- `REQ-02`: The workflow extension must publish `<workflow_activation_options />` when the model-visible context contains an earlier activation-options record with one or more catalog workflows and those workflows become unavailable.
  - Justification: The model must not continue to use stale activation options.
- `REQ-03`: Publication of lifecycle, checkpoint, completion, and reminder records must depend on persisted workflow state rather than the current agent policy.
  - Justification: A temporary agent change must not interrupt the workflow journal.
- `REQ-04`: Returning to an agent with available workflow capabilities must allow the workflow to continue from persisted session state.
  - Justification: An agent change must not damage or reset the workflow.
- `REQ-05`: `REQ-01` through `REQ-04` must apply during `session_start`, `session_tree`, `session_compact`, and agent-policy changes.
  - Justification: Publication behavior must not depend on which lifecycle event changed context or workflow availability.
- `REQ-06`: Sessions without an agent-policy change must preserve the ready-made and dynamic workflow behavior documented in `docs/extensions/workflow.md`.
  - Justification: The change is limited to redundant empty records and workflow journal continuity.
- `REQ-07`: Behavior tests must cover main-agent and subagent paths and verify publication logic without inspecting prompt content.
  - Justification: Both paths apply workflow policy, and project testing rules prohibit prompt-content assertions.

## Open Questions

None.

## Technical Supplement

None.

## References

- [Problem Statement](redundant_workflow_activation_options_problem.md)
- [Domain Glossary](redundant_workflow_activation_options_glossary.md)
- `docs/extensions/workflow.md`
- `pi-package/extensions/workflow/context.ts`
- `pi-package/extensions/workflow/index.ts`
