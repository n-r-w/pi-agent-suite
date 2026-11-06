# Technical Solution: Reuse workflow rules and graph on repeated activation

## Problem Statement

See the [problem statement](problem.md) and the requirements and critical scenarios in the [PRD](prd.md).

## Proposed Solution

Before it publishes an activation of a catalog workflow, the workflow extension reads the session history that Pi will send to the model. When the latest record there that shows the rules and graph of this workflow shows the same version, the extension publishes a short activation record that refers to it. Otherwise, it publishes the full rules and graph as now. In both cases, the record holds the initial stage and the workflow chain as now. Checkpoints decide whether to include the graph by the same rule. Workflows that `workflow_create` creates keep the full activation record.

### SOL-01: Definition key

Serves FRQ-01 and FRQ-02.

The extension identifies the shared rules and the graph of a workflow by a key. It computes the key from the workflow ID, the root guidance, and the graph as the activation record renders them: stage IDs, stage descriptions, initial and final markers, and transitions. Any change of this text gives another key. The extension reads the catalog when it loads, so a changed catalog file takes effect after the next load, for example after a restart of Pi. For example, after the author changes a stage description in the catalog file and the extension loads it, the next activation gets a new key, and the extension publishes the full rules and graph.

A workflow ID alone cannot serve as the key. The catalog can change between two runs of one workflow, and a record of the earlier run would then show an outdated graph. This breaks FRQ-02 in SCN-05.

Each record that shows the rules and graph stores the key of each definition that it shows in its `details` metadata. This applies to an activation record with full content and to a checkpoint that shows the graph of the active workflow or of a waiting workflow. The key of a checkpoint comes from the saved workflow state, so it reflects stage edits.

### SOL-02: Definition visibility from the session history

Serves FRQ-01 and FRQ-02.

The extension reads the entries of `buildSessionProjection()` before each decision. A workflow record counts only when all three conditions hold:
- Pi saved the record to the session. A record that waits in Pi's queue is not in the projection.
- The model receives messages of this record, so a compaction or a context edit did not remove it.
- The text that the model receives equals the saved text, so no context edit replaced it.

Among the counted records that show the rules and graph of the workflow ID, the extension takes the latest one. The definition is visible when this record has the key of the definition in question. In each other case, the definition is missing:
- No counted record of this workflow ID shows the rules and graph, for example after a compaction summarized the full record.
- The latest record has another key, for example after the catalog changed. Only the latest record decides, because the agent takes the latest rules and graph that it saw as current. For example, a session shows version 1 of `Research`, then version 2, and the author then restores version 1 in the catalog and the extension loads it: the next activation holds the full rules and graph of version 1, although the record of version 1 is still visible.
- The latest record has no key, because a version before this change wrote it. Such a record cannot show whether the catalog still holds the same version.

For example, the agent activates `Research`, and the user presses Escape while the agent still answers. Pi clears its queue, and the activation record never reaches the session. When the agent later exits and activates `Research` again, the projection holds no full record, so the extension publishes the full rules and graph.

### SOL-03: Activation record with reused definition

Serves FRQ-01 and FRQ-03.

When the activated workflow comes from the catalog and its definition is visible by SOL-02, the activation record holds `<workflow_activated>` with the workflow ID, the source, and a reuse marker, without root guidance and graph. The marker follows the `guidelines="inline"` and `guidelines="reuse"` attribute of stage records, so one convention tells the agent that an earlier record holds the omitted text. The record then holds the initial stage activation and `<workflow_chain>` exactly as now.

Otherwise, the activation record holds the full rules and graph as now, and it stores the key by SOL-01. This includes each activation through `workflow_create`. Only such workflows accept `workflow_edit_stage`, and their edits change the graph through records that show no complete graph. Without reuse for them, the rule needs no handling of stage edits.

Stage instructions use the same history check by the solution of [Workflow records dropped before delivery](../workflow-discarded-record-reuse/solution.md).

### SOL-04: Graph visibility at checkpoints

Serves FRQ-02.

`hasVisibleWorkflowGraph` decides whether a checkpoint includes the graph of the active workflow and of each waiting workflow. Today, it accepts any record with the same workflow ID that shows a graph. After this change, it applies SOL-02 to the definition of the saved workflow state: the checkpoint omits the graph only when the latest counted record with the rules and graph of this workflow ID has the key of this definition. An activation record with the reuse marker shows no graph, so it never counts.

This rule rejects an older record of the same workflow ID. For example, the session shows version 1 of `Research`, the agent activates version 2, and the user presses Escape before Pi saves the activation record. A later compaction keeps the record of version 1. The checkpoint finds no record with the key of version 2 and includes its rules and graph.

### Critical scenarios

- SCN-01: the projection holds no record with the rules and graph of this workflow ID, so the activation record holds the full rules and graph.
- SCN-02: the full record of the first run stays in the projection and is the latest graph record of this workflow ID, so the second activation reuses it. The intervening workflow has another workflow ID.
- SCN-03: the compaction summarizes the full record, so the next activation holds the full rules and graph again. A record that a context edit removed or replaced does not count either. If the workflow is active during the compaction, the checkpoint shows the graph by SOL-04 and stores the key by SOL-01, and a later activation after exit reuses this checkpoint.
- SCN-04: after the restart, the extension reads the projection of the saved session, so the activation reuses the retained record.
- SCN-05: the changed catalog definition has a key that differs from the latest graph record of this workflow ID, so the activation record holds the full current rules and graph.
- SCN-06: the subagent runs in its own session, and the extension in the subagent process reads only that session. It finds no record of the main session, so its activation holds the full rules and graph.
- SCN-08: after the restart, the projection holds neither the full record nor a checkpoint with the graph. The synchronizer publishes a checkpoint with the graph for an active workflow, because `hasVisibleWorkflowGraph` finds no record with the key of its definition by SOL-04. For a completed workflow, the next activation holds the full rules and graph by SOL-02.
- SCN-09: selecting another main agent publishes no workflow record and leaves the session history as it is. The selected agent receives a reused activation when the earlier full record stays visible. FRQ-01 permits full delivery after the switch but does not require it.
- SCN-10: the `workflows` policy of the selected agent governs new activation, and `workflow_activate` checks it before the extension publishes anything, as now. A visible record gives no access to a workflow. Continuation of an already active workflow stays as it is now: the `tools` policy of the selected agent governs `workflow_transition` and `workflow_exit`, as section "Agent workflow policy" of `docs/extensions/workflow.md` describes.

### Rejected methods

- Keys in the memory of the journal, recorded at publication and rebuilt on `session_start`, `session_tree`, and `session_compact`, the way stage instructions work now: Pi can drop a queued record, for example when the user presses Escape during a response or an RPC client sends `clear_queue`. The memory then shows rules and a graph that the model never received. This breaks FRQ-02.
- Reuse by workflow ID: an outdated record would count as current. This breaks FRQ-02 in SCN-05.
- Reuse when any visible record shows the same key: after the catalog returns to an earlier version, the earlier record would count, although a later visible record shows another version as current. This breaks FRQ-02.
- Reuse for workflows from `workflow_create`: their stage edits change the graph through `<workflow_stage_updated>` records. A correct rule would need to tell edits that change the graph from edits that do not, and to see edits that still wait in Pi's queue, which the projection does not show. The measured repetitions come from catalog workflows, so this handling saves almost nothing.

### Trade-offs

- A reused activation refers to a record that can be far back in the history, for example several hours earlier in a long session. The agent relies on this record for the rules and the graph, as it already does for reused stage instructions. Idea `repeated-workflow-stage-context` was deferred so that each stage entry keeps its goal and transitions in view, which limits the effect of this distance on the current stage.
- Workflows from `workflow_create` keep their repetition: each activation holds their full rules and graph.
- Known limitation of Pi: when Pi compacts the session between two responses of a running agent, the checkpoint that restores the rules and graph reaches the model one response late. Pi holds it in its queue until the end of the next turn, as Pi issue #9051 and section "Known Unresolved Delivery Limitation" of [Workflow graph after compaction](../workflow-checkpoint-omits-graph/solution.md) describe. The extension cannot change this order. The limitation exists today for stage instructions and for a workflow whose only activation record the compaction summarized. This change adds a case: the compaction keeps a reused activation and summarizes the full record that it refers to.
- A record in Pi's queue does not count. If the agent activates the same workflow twice before Pi saves the first record, for example activation, exit, and activation in one tool batch, both records hold the full rules and graph.
- A workflow whose definition changes between runs gets a full copy on each change, also when only one stage description differs.
- In a session saved before this change, the records carry no key, so they do not count. The first repeated activation of each catalog workflow holds the full rules and graph once. In session `01a1afd3`, one such copy takes from 1,714 to 3,649 characters, depending on the workflow. The first checkpoint of an active workflow in such a session, after a compaction or on a resume that needs one, also includes its graph once.
- After `workflow_edit_stage` changes a stage description of an active workflow, the key of the saved definition changes. The next checkpoint after a compaction includes the graph once, although the activation record and the stage update together show it.
- When another extension removes or replaces the records of an active workflow through a context edit, this issue adds no repair. The run-start check of [Workflow records dropped before delivery](../workflow-discarded-record-reuse/solution.md), SOL-02, restores them before the next run. No producer in Pi or this package makes such an edit now.
- After a downgrade to a version before this change, that version counts a reused activation as a record with the graph. A checkpoint after a compaction can then omit the graph, although the model context lacks it.

### Documentation

Section "Provider context" of `docs/extensions/workflow.md` describes when an activation reuses the rules and graph, which records count, and how a checkpoint decides to include the graph. The test "reuses known stage definitions in a later run of the same workflow" in `pi-package/extensions/workflow/context.test.ts` asserts the current repetition, so the change updates it. `pi-package/CHANGELOG.md` gets an entry under `## [Unreleased]`, because the defect exists in release `v2.22.1`.

## Overengineering and Overspecification Considerations

- Definition key (SOL-01): FRQ-02 and SCN-05 need it. The case occurs because the catalog is a set of files that the user edits between sessions.
- Keys of checkpoints (SOL-01): FRQ-01 needs them. Without them, an activation after a checkpoint with the graph repeats the graph. The case occurs in long sessions: a compaction during an active workflow publishes such a checkpoint.
- History check at each decision (SOL-02): FRQ-02 needs it. The case occurs: Escape during a response makes Pi drop queued workflow records.
- Comparison of the received text with the saved text (SOL-02): FRQ-02 needs it, because a replaced record no longer holds the copy. The Pi API allows such an edit of a workflow record (`SessionManager.appendContextEdit`), although no producer in Pi or this package makes one now. The comparison is one condition of the same check.
- Latest record per workflow ID instead of any record with the key (SOL-02): FRQ-02 needs it for a catalog that returns to an earlier version. It costs no more code than a search for any record.
- One rule for activations and checkpoints (SOL-04): FRQ-02 needs a checkpoint that rejects an outdated graph, and the same rule replaces the current workflow ID rule instead of adding a second one.
- No other element beyond the smallest change that meets the requirements.
- Left to the implementer: the names of the metadata fields and of the reuse attribute value, the hash function, and the split of the code into functions.

## Open Questions

None.

## References

- [Problem statement](problem.md) - the problem and its evidence
- [PRD](prd.md) - requirements and critical scenarios
- [Workflow extension documentation](../../../extensions/workflow.md) - sections "Provider context" and "Agent workflow policy"
- [Workflow graph after compaction: technical solution](../workflow-checkpoint-omits-graph/solution.md) - current graph visibility rule for checkpoints and the Pi delivery limitation
- [Workflow records dropped before delivery](../workflow-discarded-record-reuse/problem.md) - the same history check for stage instructions and the repair at the start of each run
- [Repeated workflow stage information](../repeated-workflow-stage-context/problem.md) - deferred related idea
