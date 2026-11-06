# Technical Solution: Workflow records dropped before delivery

## Problem Statement

See the [problem statement](problem.md).

## Proposed Solution

The workflow extension stops relying on its memory of sent records and reads the session history that Pi will send to the model. Before it publishes a record that can show or reuse stage instructions, it sends a reuse entry only when this history holds a record with the instructions of the same stage definition. At the start of each run, it checks that the history shows the active workflow and adds a checkpoint with what is missing. The extension uses the same history check that issue [repeated-workflow-activation-context](../repeated-workflow-activation-context/solution.md) introduces for shared rules and graphs, so one rule decides all cases.

### SOL-01: Stage instructions known from the session history

Serves the second sentence of the desired state.

Each record that shows stage instructions already stores the stage key in its `details` metadata. Before `activate`, `enterStage`, and `checkpoint` choose `guidelines="inline"` or `guidelines="reuse"`, the extension reads the entries of `buildSessionProjection()`. A stage is known when the projection holds a record with its key that meets the conditions of SOL-02 of `repeated-workflow-activation-context`: Pi saved it, the model receives its messages, and the received text equals the saved text. The same applies to the stage keys of waiting workflows in a checkpoint.

The set of known stages in the memory of `WorkflowJournal` goes away, together with its rebuild in `WorkflowJournal.restore`. The record kinds and their metadata stay as they are, so sessions saved before this change keep their stage knowledge.

For example, the agent enters stage `review`, and the user presses Escape before Pi saves the record. On the next entry into `review`, the projection holds no record with its key, so the agent receives the instructions of `review` again.

### SOL-02: Repair at the start of each run

Serves the first sentence of the desired state.

The `before_agent_start` handler of the extension already reads the projection at the start of each run to prepare activation options. With the same projection, the extension checks the workflow state, the way `createWorkflowSynchronizer` does on `session_start`:
- When a workflow is active, the extension takes the latest lifecycle record that counts by SOL-02 of `repeated-workflow-activation-context`. When this record carries another chain revision than the saved state, or the graph of a workflow in the chain is missing by SOL-04 of that issue, the extension returns a checkpoint. The checkpoint holds the current stage, its transitions, and the chain, and also the rules, graph, and stage instructions that the projection lacks.
- When no workflow is active, the saved state has a recorded exit, and the latest counted lifecycle record still shows an active workflow, the extension returns the record that no workflow is active.

Pi collects the messages of all `before_agent_start` handlers (`emitBeforeAgentStart` in `extensions/runner.js` of Pi) and appends them together with the new user input, without the steering queue. Escape therefore cannot drop this checkpoint the way it drops a steered record. When the projection shows the current state, the extension returns no checkpoint, so an ordinary run gets no extra record.

For example, the agent activates `Research`, the user presses Escape before Pi saves the activation record, and then writes "continue". The projection holds no lifecycle record with the current chain revision, so the run starts with a checkpoint that holds the rules, graph, and first stage of `Research`. The same holds when the user selects another main agent before writing.

### Rejected methods

- Removal of the dropped record from memory when Pi clears its queue: the extension receives no event for `clearQueue`, and a context edit gives no event either.
- Rebuild of the memory before each publication: it reads the same projection as SOL-01 and keeps a second copy of the same knowledge.
- Repair only on a switch of the selected main agent: the next run of the same agent continues without the dropped record as well.

### Trade-offs

- A record in Pi's queue does not count. When the agent enters the same stage twice before Pi saves the first record, for example through a rework and a return in one tool batch, both records hold the instructions.
- The extension reads the projection at each stage publication. Its cost grows with the length of the session; no measurement shows a delay.
- SOL-02 repairs at the start of a run. An RPC client that sends `clear_queue` without stopping the run leaves the agent without the dropped record until the run ends. Escape in the interactive mode stops the run, so the next run starts with the repair.
- In the same case, when the extension publishes a reminder later in the same run and Pi saves it, the reminder carries the current chain revision without stage instructions. The next run then finds the current state shown and adds no checkpoint, so the agent continues the active stage without its instructions until a stage entry or a compaction shows them. The case needs an RPC client that sends `clear_queue` without stopping the run right after a stage entry, and no component of this package sends `clear_queue`.
- In the same case, when the agent edits another stage through `workflow_edit_stage` later in the same run and Pi saves that edit, the edit record carries the current chain revision. The next run then finds the current state shown and adds no checkpoint, although the instructions of the active stage stay missing. The case needs a workflow from `workflow_create`, an earlier compaction that removed the instructions of the active stage, a `clear_queue` that does not stop the run, and an edit of an inactive stage in the same run.
- With a virtual model, Pi can compact the session right before the first request of a run, after this check, because the router picks a model with a smaller context window. When the compaction summarizes the record that the repair checkpoint refers to for the rules and graph, the restoring checkpoint reaches the model one response late, as Pi issue #9051 describes. No extension of this package registers a virtual model.
- When Pi compacts the session at the start of a run and removes workflow records, the compaction handler queues its checkpoint, and this check adds a second one, because the queued checkpoint is not in the projection yet. Pi saves both before the first response, so the model receives the restored information twice.

### Documentation

Section "Provider context" of `docs/extensions/workflow.md` states that a stage is known while a saved, model-visible, unchanged record shows its prompt, and that each run starts with a checkpoint when the session does not show the current workflow state. `pi-package/CHANGELOG.md` gets an entry under `## [Unreleased]`, because the defect exists in release `v2.22.1`.

## Overengineering and Overspecification Considerations

- History check at each stage publication (SOL-01): the desired state needs it. The case occurs: Escape during a response makes Pi drop queued workflow records.
- Comparison of the received text with the saved text: it comes with the shared check of `repeated-workflow-activation-context`, whose FRQ-02 needs it. This problem alone does not need it, because no producer replaces workflow records now.
- Check at the start of each run (SOL-02): the desired state needs it. The case occurs: Escape right after a workflow operation drops its record, and the next run continues the workflow. The check reuses the projection that the handler already reads and the decision of `createWorkflowSynchronizer`.
- No other element beyond the smallest change.
- Left to the implementer: how the publication paths receive the projected entries, and the split of the code into functions.

## Open Questions

None.

## References

- [Problem statement](problem.md) - the problem and its evidence
- [Reuse workflow rules and graph on repeated activation](../repeated-workflow-activation-context/solution.md) - the shared history check, SOL-02
- [Workflow extension documentation](../../../extensions/workflow.md) - section "Provider context"
