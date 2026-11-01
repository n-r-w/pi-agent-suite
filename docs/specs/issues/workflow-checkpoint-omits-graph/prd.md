# Idea: Workflow graph after compaction

## Definitions

See [terms](terms.md).

## Context and Problem

See [problem statement](problem.md).

## Goal

After a compaction, an agent that works by a workflow knows all stages of the workflow and the paths between them, as it does right after activation.

## Affected Scenarios

- A main agent works by a catalog workflow, and Pi compacts the session while the workflow is active.
- A subagent works by its workflow, and Pi compacts the subagent session while the workflow is active.
- Pi compacts a session after its workflow has completed, and the agent later chooses a rework transition.
- A user resumes a compacted session or navigates its tree, and the workflow extension restores the workflow state in the model context.

## Scope and Non-Scope

In scope:
- What the model receives about the workflow when the workflow extension restores the workflow state after a compaction, for active and completed workflows, on each restoration path.
- Extension documentation that describes this content.

Out of scope:
- A compaction that keeps the activation record among the kept entries.
- Activation, stage activation, stage update, reminder, and completion records.
- Guidelines of stages other than the active one.
- Pi compaction itself, for example the summary content or the size of the kept entries.

## Requirements

### Functional Requirements

- [X] FRQ-01: When the model context holds the workflow state that the workflow extension restored after a compaction, and this compaction left the activation record in the summarized part, the model context also holds the workflow graph of the saved workflow state. This applies to active and completed workflows.
  - Origin: source. Desired state and problem boundary of the [problem statement](problem.md).
  - Goal: the agent knows all stages and the paths between them after a compaction.
  - Goal achievement: Full. The model receives the same stages, descriptions, flags, and transitions that the activation record gave it.
  - Feasibility: Confirmed. The saved workflow state holds the full workflow definition, stage edits included, and the extension already renders the workflow graph from it for the activation record. The extension already publishes a restoration record once per compaction and once per repair on session start or branch navigation, so the graph does not need to be repeated before every model request, which `tool-prompt-cache-duplication` removed.
- [X] FRQ-02: The workflow extension adds the workflow graph to the model context only when the context that the model will receive holds no workflow graph of this workflow. For example, the extension adds no graph when a compaction left the activation record among the kept entries, or when the graph was already restored after this compaction and the user resumes the session.
  - Origin: source. The task requires that graph records appear only when the model needs them.
  - Goal: the model context holds no extra copies of the workflow graph.
  - Goal achievement: Full. Each case where the context already holds the graph gets no new copy.
  - Feasibility: Confirmed. The compaction entry in the session stores the first kept entry, and the extension already reads the session entries after the latest compaction to find matching workflow records.

### Non-Functional Requirements

- [X] NRQ-01: To restore the workflow graph, the workflow extension only appends new records at the end of the session. It changes neither the system prompt nor any session entry that the model has already received.
  - Origin: source. The task requires that earlier history stays unchanged, so that the prompt cache of the model provider stays valid.
  - Goal: the restoration of the graph keeps the prompt cache of the model provider valid.
  - Goal achievement: Full. Each model request after the restoration starts with the same content as before it, followed by the appended records.
  - Feasibility: Confirmed. The extension already publishes every workflow record as a new session entry at the end of the session, and it adds no workflow content to the system prompt.
  - Metric: the number of changed or removed parts of a model request that the restoration causes, measured by comparing the provider requests before and after the restoration. Threshold: zero.

## Critical Scenarios

- SCN-01: Compaction during an active workflow
  - Requirements: FRQ-01, active workflow; FRQ-02; NRQ-01
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi compaction, request to the model provider
  - Flow: An agent works by a workflow. Pi compacts the session, and the activation record falls into the summarized part. The workflow extension restores the workflow state. The next model request holds the workflow graph exactly once. The system prompt and all messages before the new workflow records match what Pi built from the summary and the kept entries.
- SCN-02: Compaction after a workflow has completed
  - Requirements: FRQ-01, completed workflow
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi compaction, request to the model provider
  - Flow: A workflow has completed. Pi compacts the session, and the activation record falls into the summarized part. The workflow extension restores the state of the completed workflow. The next model request holds the workflow graph.
- SCN-03: Session resume after a compaction
  - Requirements: FRQ-01, active workflow; FRQ-02; NRQ-01
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi session loading, request to the model provider
  - Flow: A session with an active workflow had a compaction, the activation record fell into the summarized part, and the workflow extension restored the graph. The user closes Pi and resumes the session. The first model request after the resume holds the workflow graph exactly once. The messages that the model received before Pi was closed stay unchanged.
- SCN-04: Session tree navigation after a compaction
  - Requirements: FRQ-01, active workflow; FRQ-02
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi session tree, request to the model provider
  - Flow: The user navigates the session tree to a branch with an active workflow, where a compaction left the activation record in the summarized part. The first model request on this branch holds the workflow graph exactly once.
- SCN-05: Compaction after a stage edit
  - Requirements: FRQ-01, active workflow
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, tool `workflow_edit_stage`, Pi compaction, request to the model provider
  - Flow: An agent changes the description of a stage of a dynamic workflow. Pi then compacts the session, and the activation record falls into the summarized part. The next model request holds the workflow graph with the new description of this stage.
- SCN-06: Compaction keeps the activation record among the kept entries
  - Requirements: FRQ-02
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi compaction, request to the model provider
  - Flow: An agent activates a workflow shortly before a compaction. Pi compacts the session, and the activation record stays among the kept entries. The next model request holds the workflow graph exactly once.
- SCN-07: Repeated compaction
  - Requirements: FRQ-01, active workflow; FRQ-02
  - Level: external. The result is visible in the request to the model provider.
  - Area: workflow extension, Pi compaction, request to the model provider
  - Flow: After the first compaction, the workflow extension restored the graph. Pi compacts the session again, and the restored graph stays among the kept entries. The next model request holds the workflow graph exactly once.

## Open Questions

None.

## Technical Supplement

None.

## References

- [Problem statement](problem.md)
- [Terms](terms.md)
- [Workflow extension documentation](../../../extensions/workflow.md), section "Provider context"
- [Tool prompt cache duplication: technical solution](../tool-prompt-cache-duplication/technical-solution.md), SOL-06
