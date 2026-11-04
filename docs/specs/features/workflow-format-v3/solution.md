# Technical Solution: Nested workflows

## Problem Statement
Only a part of the processes that agents must follow fits into the deterministic workflow mechanism: nested processes stay outside it, and agents skip their steps or mix them with the stages of the parent workflow. Problem: [problem.md](problem.md). Approved requirements and critical scenarios: [prd.md](prd.md).

## Proposed Solution
The workflow extension keeps a chain of running workflows instead of one workflow state. A workflow of format 3 can declare that it is intended for nested run; such a workflow starts on top of the chain and returns the agent to the calling stage when it ends, and every other workflow replaces the chain as activation does now. All formats follow the same runtime rules; the format decides only which fields a file may hold.

### Chain of running workflows
The main data structure is the chain: an ordered list of the existing workflow states, from the first started workflow to the last one. Each element keeps what one state keeps now except the status: the definition, the route, the source, and the restoration snapshot of model settings. Each element of the chain runs; a workflow that ends leaves the chain, so the status "completed" no longer exists. Today's single state is a chain of one element.

Invariants of the chain, which the domain module checks at each change:
- only the last element, the top, moves: transitions, stage edits, triggers, reminders, and stage instructions concern the top;
- each element below the top waits on the stage from which the agent started the element above it;
- no workflow ID occurs twice.

Operations on the chain:
- a nested start appends a workflow at the top; the chain may be empty (FRQ-01, FRQ-04, FRQ-06);
- a start of a workflow without the nested mark ends each element and leaves this workflow as the only element (FRQ-07, FRQ-12);
- an exit removes the top; when the chain becomes empty, the agent has no workflow (FRQ-03, FRQ-08);
- a transition changes the route of the top only (FRQ-02).

A start of a workflow whose ID is in the chain is rejected (FRQ-05), and the error names the reason. The activation options keep each workflow of the chain, so the list changes only with the catalog or the policy, and the agent receives it once per context segment instead of at each start and exit. A dynamic workflow follows the same rules.

A typed chain replaces the single state in each place that now assumes one state: the runtime, replay, availability, the context journal, the status indicator, and tool presentation. A chain with an explicit top keeps these places from deciding by their own conditions which state is current.

### Format 3
Format 3 is format 2 with two optional root fields: `nested`, a boolean that marks a workflow intended for nested run, and `kind`, the ID of a workflow kind. Catalog files of formats 1 and 2 load as now and get `nested` false and no kind (FRQ-12). `workflow_create` always produces format 3 and accepts both fields (FRQ-13). Format selection, as now, follows the `version` field of the file.

Validation happens where the data enters: the catalog loader and `workflow_create` reject an unknown kind ID. A catalog file with an unknown kind is skipped with a warning, as a file with any other validation error is skipped now.

### End of a workflow and model settings
A workflow ends only by the new tool `workflow_exit`, which removes the top at any stage and requires a basis (FRQ-03, FRQ-08, FRQ-09). A transition to a final stage ends nothing: the agent does the work of the final stage and then leaves the workflow. When a parent remains, it is the top again on the stage from which the agent started the removed workflow, and its transitions are available in the same agent run (FRQ-03). When no parent remains, the agent has no workflow (FRQ-06).

A workflow on its final stage keeps running until the agent leaves it or a start of an unmarked workflow replaces the chain. While it runs, its rework transitions stay available, for example a return from a report stage to implementation when the user asks for more changes. The record of entry into a final stage tells the agent to leave the workflow after the work of this stage.

Rejected method: the current automatic completion at event `agent_settled`, when a successful agent run ends on a final stage. The end of a run does not mean that the work of the stage is done: on a final stage, an agent may ask the user a question and wait for the answer, and an automatic end would return the agent to the parent before the nested process ends.

Model settings follow the top. Each element keeps the snapshot that the extension took when the element started, as each workflow keeps it now. When the top is removed and a parent remains, the extension applies the settings of the active stage of the parent by the existing resolution of stage, workflow, agent, and snapshot settings. When the chain becomes empty, it applies the snapshot of the first element, as completion applies it now. A replacement ends each element the same way: the extension first applies the snapshot of the first element of the old chain, and the new workflow then takes its own snapshot from these settings and applies the settings of its initial stage. So a workflow that sets no model runs with the settings that held before the old chain, and its exit restores them. For example, the session starts with model A, a workflow sets B, its nested workflow sets C, and an unmarked workflow without model settings replaces the chain: the new workflow runs with A and restores A at its exit. A model that a final stage sets stays in force until the exit or the replacement.

Rejected method: the new workflow takes its snapshot from the settings of the old top, as activation does now. In the example above, the new workflow would run with C, which a nested process set, and restore C at its exit.

For existing workflows of formats 1 and 2, this changes the behavior and not the files: a workflow no longer becomes completed at the end of a run on its final stage, reminders keep coming while it stays there, and the snapshot of model settings applies at the exit or the replacement. Users who override the guidance of the extension through `config.json` need to add the instruction to leave a workflow through `workflow_exit`; without it, their agents stay on final stages until the next start of an unmarked workflow replaces the chain.

### Transitions and the basis
`workflow_transition` and `workflow_exit` require a non-empty free-text `basis` (FRQ-09). The extension checks only that the basis is present; the model decides its content. The tool descriptions ask for the facts that make the move right. `workflow_transition` keeps the optional `ground`, which it validates against the declared grounds as now, except that a call without `ground` to a transition with exactly one ground selects that ground. The model already chose the condition when it chose the target, so a required ID only cost a repeated call; the rejection lists each ground with its condition. Each call stays in the session as a tool call with its arguments, so the basis is visible there; the saved state entries do not store it, because no reader of these entries needs it.

### Saved state
The extension writes workflow state entries of journal version 2. A start entry states whether the workflow joined the chain as nested or replaced the chain; transition and edit entries concern the top; and an exit entry removes the top. Replay rebuilds the chain from these entries in order (FRQ-11).

Replay reads entries of journal version 1 as operations on a chain of one element: activation and creation replace the chain, transitions and edits apply to its only element, and a completion entry acts as an exit, which removes the workflow and applies its snapshot of model settings (FRQ-17). So a session in which a workflow completed before the update has no running workflow, and the rework transitions of that workflow are no longer available. One exception keeps saved history: when the earlier version already saved an unversioned rework transition after the completion entry, replay applies it to the completed workflow and restores the resulting route and stage settings. The exception applies only to such saved entries, and a workflow that leaves the chain through an exit entry cannot be reworked. A session that the previous version saved and the new version continues holds entries of both versions, and replay handles them in one pass. Entries without a journal version keep their current handling: a warning and no state.

Version compatibility: an earlier version of the extension that opens a session with entries of journal version 2 reports an unsupported journal version, by its current rule. A user who goes back to an earlier package version loses workflow state of such sessions. This is a trade-off: the chain cannot be written in entries that the earlier version understands without changing their meaning.

### What the agent sees
The extension keeps its current channel: hidden custom messages that `pi.sendMessage` appends to the session (NRQ-01). The journal publishes a record at each change of the chain (FRQ-14):
- a nested start: the activation of the nested workflow as now, with its graph and its initial stage, and the list of waiting workflows with their stages;
- a return after an exit or the end of a nested workflow: the stage of the new top with its goal and available transitions, with the stage instructions inline or reused by the current rule of known stages;
- a start that replaces the chain: the activation of the new workflow, which states that no workflow waits;
- the end of the last workflow: a record that no workflow runs.

The checkpoint after compaction and session restoration renders the top as now and adds the list of waiting workflows with their stages, with the goal and the prompt of each waiting stage that no visible record shows. The journal keeps its known stages for each workflow of the chain, so that a return to a parent stage reuses instructions that the agent already has in the current context segment. The current revision check covers the whole chain. The revision hashes the chain with the keys of each object in code-point order, because a bound start and the replay of its saved entry build the same chain item with its fields in different orders.

Workflow tools are only added during a session. The extension adds a workflow tool the first time it becomes applicable, for example `workflow_get_stage` and `workflow_edit_stage` when the agent creates a workflow, and never removes it in this session. A call that does not apply now returns an error that states why, for example `workflow_exit` when no workflow runs. `workflow_exit` follows the current availability rule of `workflow_transition`: it is available when a workflow runs or an allowed catalog workflow exists. The agent definition can still exclude any tool by its tool policy; this rule concerns only availability that the workflow state decides. Additions go through `pi.setActiveTools()`, and on models that accept system messages in the middle of a conversation pi appends a patch with the new tool declarations and keeps the cached prefix (NRQ-01).

Rejected method: tools that appear and disappear with the workflow state, as `workflow_get_stage`, `workflow_edit_stage`, and `workflow_activate` do now. The model has called a removed tool before and may call it again, and it then gets an error that the tool does not exist; on models without system messages in the middle of a conversation, each removal also costs a cache miss.

### Activation options and kinds
Kinds are defined in `<suite root>/workflow/kinds.yaml`, next to the directory `workflows/`: each entry has an ID and a description, and IDs are unique. The file is optional: without it, no kinds exist, the activation options list the workflows as one group, as now, and a workflow that names a kind fails validation as with any unknown kind.

`<workflow_activation_options>` lists the workflows that the agent may activate grouped by kind, in the order of the kinds file, with the description of each kind, and the workflows without a kind in a group of their own (FRQ-15). Each workflow intended for nested run carries a mark in this list (FRQ-18). The existing deduplication keeps the list out of the context while it does not change, and a changed list is appended as now.

The meaning of the mark stands in the guidance of the extension, which pi puts into the system prompt of each agent with workflow tools: a marked workflow starts on top of the active one and returns the agent to the calling stage, and an unmarked workflow replaces each running workflow (FRQ-18). The guidance is static, so it does not change the prompt prefix. The same guidance replaces the current rule that forbids a new workflow before the final stage: the agent may start a marked workflow at any moment, the rule stays for unmarked workflows, and the agent leaves each workflow through `workflow_exit` after the work of its final stage. Users who override this guidance through `config.json` need the same change in their files.

### Access
Agent definitions keep restricting workflows by ID (FRQ-10): a nested start passes the same policy check as any activation. The policy needs no change.

### Readers of saved entries outside the extension
`pi-package/extensions/run-subagent/workflow-status.ts` reads raw workflow state entries to show the workflow and stage of a child agent. It follows the chain semantics of journal version 2 and shows the top workflow, so that the subagent screens keep showing the active stage after a return. The status row of the main session shows the top workflow too.

### Critical scenarios
| Scenario | Methods that run it |
|---|---|
| SCN-01 | Nested start, rejection of parent transitions, transitions of the top with a basis, exit on the final stage, return record |
| SCN-02 | Required basis of `workflow_transition` and `workflow_exit` |
| SCN-03 | Nested start on a nested top, rejection of an ID that is in the chain, two returns |
| SCN-04 | Nested start on an empty chain, exit to an empty chain, record that no workflow runs |
| SCN-05 | Start of an unmarked workflow that replaces the chain, replacement record |
| SCN-06 | Exit on a middle stage of a nested workflow and of the first workflow |
| SCN-07 | Policy check of activation for nested starts |
| SCN-08 | Replay of journal version 2, checkpoint with waiting workflows, known stages per workflow |
| SCN-09 | Loading of formats 1 and 2 as unmarked workflows without a kind; a format 2 workflow as parent; replacement by a format 1 workflow |
| SCN-10 | `workflow_create` in format 3 with `nested` and `kind` |
| SCN-11 | Kinds file, grouped activation options, kind without effect on behavior |
| SCN-12 | Replay of journal version 1 as a chain of one element, with a completion entry read as an exit |
| SCN-13 | Records appended by `pi.sendMessage`, tools only added by `pi.setActiveTools()` |
| SCN-14 | Mark of nested workflows in the activation options and its meaning in the guidance |

## Overengineering and Overspecification Considerations
- Chain instead of one state: FRQ-01, FRQ-04. A single state cannot hold a waiting parent.
- `workflow_exit`: FRQ-03 needs an end inside the run, and FRQ-08 needs an exit on any stage; one tool serves both.
- Removal of automatic completion and of the status "completed": one way to end a workflow instead of two.
- Tools that are only added: removes the current removal logic and replaces it with an error at the call.
- Journal version 2 with reading of version 1: FRQ-11, FRQ-17.
- Kinds file and grouping: FRQ-15.
- Adaptation of `workflow-status.ts` and of the status row: without it, both show the stage of a workflow that already ended after a return.
- Left to the implementer: the names and XML form of the new records and of the mark, the wording of the tool descriptions and the guidance, the structure of journal entries, and the layout of `kinds.yaml` beyond ID and description.

## Open Questions
No open questions.

## References
- `pi-package/extensions/workflow/` - the workflow extension that this solution changes.
- `pi-package/extensions/run-subagent/workflow-status.ts` - reader of workflow state entries for subagent screens.
- `docs/extensions/workflow.md` - documentation of the workflow extension, which describes one active workflow now.
- `docs/extensions/system-prompt.md`, section "Prompt history and tool activation" - how pi keeps the request prefix when tools change.
