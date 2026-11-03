# Problem Statement

## Key definitions and abbreviations

Terms of this issue are defined in [terms.md](terms.md).

## Context

The workflow extension publishes hidden records for the model. The activation record holds the root guidance, the workflow graph, and the entry into the initial stage. Each later stage activation holds the stage goal, the stage guidelines, and `<available_transitions>`, which lists only the transitions out of the active stage, with their grounds.

During a compaction, Pi passes the summarized part, hidden workflow records included, to a summarizer model. After the compaction, the model sees the summary, the kept entries, and the entries appended later.

The extension appends a checkpoint after `session_compact`. It also appends a checkpoint on session start and on branch navigation when the entries after the latest compaction or branch summary hold no workflow record that matches the saved workflow state.

## Observed Problem

A checkpoint holds the root guidance, the goal and guidelines of the active stage, and `<available_transitions>`. It holds no workflow graph. When the activation record is in the summarized part, the model sees only the stages that the active stage leads to. The other stages, their descriptions, and the paths between them are visible only as far as the summary retells them. A checkpoint of a completed workflow holds only the rework transitions, with the same loss.

## Affected Audience

Main agents and subagents that work by a workflow in a session long enough to be compacted, and the users of these agents.

## Evidence

- Code: in `pi-package/extensions/workflow/context.ts`, `renderWorkflowActivation` renders `<stages>` and `<transitions>`, and `renderWorkflowCheckpoint` renders neither. Both publication paths, `registerWorkflowCompaction` and the synchronizer of `session_start` and `session_tree` in `index.ts`, call `WorkflowJournal.checkpoint`.
- Rendered output: for a workflow with the stages `plan`, `implement`, and `review`, the activation record lists the three stages and the three transitions. The checkpoint at `plan` lists only the transition `plan -> implement`.
- Session history: a scan of local Pi session files from September and October 2026 found 134 checkpoints that the extension appended right after a compaction. None of them holds the workflow graph.
  - In 127 checkpoints, the activation record was in the summarized part, and at least one stage was invisible in the checkpoint. These checkpoints come from 54 sessions, 33 of main agents and 21 of subagents, and from 18 workflows. For example, at stage `implement_plan` of `ComplexCoding`, the checkpoint shows 4 of 13 stages.
  - In 68 of these 127 cases, the compaction summary names none of the invisible stages. In 19 cases, it names all of them. A stage name in the summary does not show that its transitions are known.
  - In 2 checkpoints, the activation record was among the kept entries.
- Tools: no workflow tool returns the workflow graph. `workflow_get_stage` returns one stage by its ID, without transitions, and is available only for an active dynamic workflow (`availability.ts`, `resolveWorkflowAvailability`).
- Documentation: section "Provider context" of `docs/extensions/workflow.md` and SOL-06 of `docs/specs/issues/tool-prompt-cache-duplication/technical-solution.md` list the content of the checkpoint without the workflow graph. SOL-06 gives no reason to leave the graph out. Per PRB-03 of the same issue, the extension previously repeated the full transition graph before every model request.

## Impact

After a compaction, an agent chooses its next steps without the structure of the workflow. A stage whose guidelines refer to later stages, such as a plan that names the stages that will check its result, can produce a result that omits them. Level: HIGH. The outcome of the task can change, and a repeated run of the stage removes the damage.

## Current State

- Active workflow, activation record in the summarized part: the model sees the root guidance, the goal and guidelines of the active stage, and the transitions out of it. It sees other stages only through the summary text.
- Completed workflow, activation record in the summarized part: the model sees the root guidance and the rework transitions.
- Catalog workflow: the model has no tool that shows other stages. Active dynamic workflow: the model can read one stage through `workflow_get_stage` when it knows the stage ID.
- The workflow graph returns to the model context only with a new activation record.

## Desired State

After a compaction, an agent that works by a workflow knows all stages of the workflow and the paths between them, as it does right after activation.

## Problem Boundary

The problem covers each checkpoint that the model receives while the activation record is in the summarized part, for active and completed workflows, from both publication paths.

The following similar cases are outside the problem:

- A compaction that keeps the activation record among the kept entries: the model still sees the workflow graph.
- The activation, stage activation, stage update, reminder, and completion records.
- Guidelines of stages other than the active one: the activation record does not hold them either, and the model receives the guidelines of a stage when it enters this stage.

## Assumptions

- The loss of the workflow graph changes the results of agents. The session history shows the loss itself, and a keyword search over it found no agent result that the loss changed.

## Open Questions

None.
