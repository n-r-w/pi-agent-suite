# Problem Statement

## Context

The workflow extension publishes model-facing workflow records into the conversation. On activation, `<workflow_activated>` holds the root guidance, every stage with its description and `initial` or `final` flag, and every transition with its endpoints and type. Each stage activation then holds the stage goal, the stage guidelines, and `<available_transitions>`, which lists only the transitions out of the active stage.

After `session_compact`, the records published before the compaction are outside the provider-visible context. The extension appends one `<workflow_checkpoint>` to restore the workflow state for the model.

## Observed Problem

The checkpoint holds the root guidance, the goal and guidelines of the active stage, and `<available_transitions>`. It holds no `<stages>` and no `<transitions>`. After a compaction, the model therefore sees only the transitions out of the active stage and no longer sees the later stages of the workflow, their descriptions, or the paths between them. A completed checkpoint holds only the rework transitions, with the same loss.

## Affected Audience

Agents that work by a workflow in a session long enough to be compacted are affected, and so are the users of these agents. The harm is largest when the guidelines of a stage refer to stages beyond its outgoing transitions, for example a planning stage that must name the later stages that check the whole result.

## Evidence

- `pi-package/extensions/workflow/context.ts:renderWorkflowActivation` renders `<stages>` and `<transitions>`; `renderWorkflowCheckpoint` renders neither.
- `docs/extensions/workflow.md`, section "Provider context", states that activation appends the complete transition graph and that an active checkpoint holds the stage goal, the active stage guidelines, and the available transitions.
- Section SOL-06 of `docs/specs/issues/tool-prompt-cache-duplication/technical-solution.md` lists the content of the checkpoint and gives no reason to leave the graph out. The problem that this solution addressed, PRB-03, was a full snapshot repeated before every model request; a checkpoint is appended once per compaction.

## Impact

After a compaction, an agent chooses its next steps without the structure of the workflow. A stage whose guidelines need the later stages, such as a plan that names the stages that will check its result, can produce a result that omits them.

## Current State

The checkpoint restores the active stage and its outgoing transitions, and the rest of the graph is lost from the model context until a new activation.

## Desired State

After a compaction, the model sees the whole workflow graph, as it does after activation.

## Problem Boundary

The problem covers the content of `<workflow_checkpoint>` after `session_compact` for active and completed workflows. It does not cover the activation, stage, reminder, or completion records.

## Assumptions

- A compaction summary does not reliably keep the graph from the activation record. The behavior was found by reading the code and the documentation, and it was not reproduced in a live session.

## Open Questions

None at the problem-definition level. Requirements and a technical solution have not yet been defined.
