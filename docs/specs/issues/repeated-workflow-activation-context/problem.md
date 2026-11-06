# Problem statement

## Key definitions and abbreviations

- Activation: starting a workflow and publishing its initial state to the agent.
- Shared rules: instructions in `workflow.prompt` that apply across the workflow's stages.
- Workflow graph: stage identifiers and descriptions, initial and final stage markers, and transitions between stages.
- Model context: messages available to the model for its next response. Earlier session messages can be absent after context compaction or editing.

## Context

The workflow extension sends the agent shared rules, a workflow graph, and initial-stage information when a workflow starts. An agent can finish a workflow and start the same workflow again during one session, for example when researching successive user questions.

## Observed problem

When the agent starts an unchanged workflow again while its shared rules and graph remain in model context, the extension sends those rules and that graph in full again. The repeated text increases context volume for the agent and model usage associated with the user's task.

## Affected audience

- Users whose agents repeatedly start the same workflows during a session.
- Main agents and subagents that receive these repeated workflow definitions.

## Evidence

- In `pi-package/extensions/workflow/context.ts`, `renderWorkflowActivation` unconditionally includes shared rules and the graph. `WorkflowJournal.activate` checks prior stage knowledge only for stage instructions. The same unconditional rendering exists in release `v2.22.1`.
- Session `2026-11-06T07-47-24-061Z_01a1afd3-9f1c-777d-94a9-ba0960244253.jsonl` contains five activations of `Research` and four of `BehaviorGraph`, with no compaction. All examined workflow records belong to the latest branch's ancestor chain.
- In that session, exact repetitions of shared rules and graphs after their first publication total 19,198 characters out of 58,193 characters in workflow custom-message content, or 33.0%. This measures text volume within workflow messages; it does not establish a percentage of total session usage or provider charges.
- In `pi-package/extensions/workflow/index.ts`, `createWorkflowSynchronizer` publishes a checkpoint on session start only when the latest model-visible record shows another workflow state or no visible record shows the graph. `WorkflowJournal.checkpoint` includes the shared rules and the graph only in the second case. Tests `deduplicates compatible restore checkpoints` in `index.test.ts` and `omits rules from a checkpoint while the kept entries show them` in `context.test.ts` cover this behavior.

## Impact

MEDIUM. The agent receives additional copies of instructions and graph information already present in its history. These copies occupy context that the agent also needs for task facts and results. The observation does not establish a change in task correctness.

## Current state

Each activation publishes the shared rules, when defined, and the full graph regardless of earlier activations. This also occurs when the initial stage uses `guidelines="reuse"` and its instructions are omitted.

After compaction, the extension separately checks retained messages when restoring workflow information. Earlier publication alone therefore does not establish that the model still has the rules and graph.

When a saved session with an active workflow loads after a process restart, the extension publishes no record if the model-visible records already show the current workflow state and graph. If only the state differs, the extension publishes a checkpoint that omits the shared rules and the graph while a model-visible record shows them.

## Desired state

During ordinary work and after loading a saved session following a process restart, repeated starts of an unchanged workflow add no further full copies of shared rules and graph information that remain in model context. The agent still knows which workflow and stage are active and uses the earlier rules and graph. When compaction removes this information from model context, the extension provides it again. After a switch of the selected main agent, repeated delivery is accepted while current instructions and the selected agent's permissions are preserved.

## Problem boundary

Included: repeated activation of the same unchanged workflow in a main-agent or subagent session while its shared rules and graph remain in model context, including after a process restart and saved-session loading.

Outside this problem:

- Restoration of an active workflow after a process restart. Section "Current state" describes how the extension already omits retained shared rules and graphs in this case.
- First delivery of a workflow definition, delivery of changed definitions, and restoration of information absent after compaction or context editing.
- Repeated stage goals and available transitions on stage entry, covered by F2.
- Verbose transition and exit justifications, covered by F3.
- User-interface descriptions and periodic reminders.
- Deduplication across a switch of the selected main agent. Full repeated delivery after that switch is an approved compromise.
- Repeated activation of workflows that `workflow_create` creates. Only their stages accept `workflow_edit_stage`, which changes the graph outside a full record, and the measured repetitions come from catalog workflows.

## Assumptions

No assumptions are needed to establish the duplicate text. Its effect on provider charges has not been measured.

## Open questions

None for the problem statement. The implementation approach and acceptance criteria belong to subsequent documents.
