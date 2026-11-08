# Problem statement

## Key definitions and abbreviations

- Stage information: a stage's goal, instructions, available transitions with their conditions and required check workflows, and guidance for leaving a final stage.
- Model context: messages available to the model for its next response. Earlier session messages can be absent after compaction or context editing.
- Current state: the active workflow and stage, waiting enclosing workflows, and the outcome or pending status of a requested transition.

## Context

The workflow extension publishes stage information when a workflow starts, enters a stage, returns from a nested workflow, or restores workflow context. An agent can encounter the same stage several times, within one workflow run or across successive runs.

## Observed problem

When previously delivered stage information remains unchanged and available in model context, the extension still sends full copies of the stage goal, available transitions, and final-stage leave guidance. These repeated copies increase context volume for main agents and subagents and model usage associated with their tasks.

## Affected audience

- Users whose agents revisit stages or repeatedly run workflows.
- Main agents and subagents receiving repeated stage information.

## Evidence

- In `pi-package/extensions/workflow/context.ts`, `renderStageActivation` skips known stage instructions but always includes the stage goal, available transitions, and final-stage leave guidance. `renderWorkflowCheckpoint` also repeats these parts when stage instructions are reused. The stage-activation behavior exists in release `v2.22.1`.
- Session `2026-11-06T07-47-24-061Z_01a1afd3-9f1c-777d-94a9-ba0960244253.jsonl` contains 19 stage-entry records for `Research`, of which 13 exactly repeat earlier records in that session. These records are in one ancestor chain with no compaction.
- In `pi-package/extensions/workflow/workflow.ts`, `getAvailableTransitions` allows an advance transition from the current stage and allows a rework transition only when its target has been visited in the current run. Thus identical stage identifiers alone do not establish identical available transitions.

## Impact

MEDIUM. The agent receives additional copies of stage information already available in its history. Those copies occupy context also needed for task facts and results. This observation establishes repeated text, without establishing an effect on provider charges or task correctness.

## Current state

The extension already tracks whether stage instructions remain available and omits their full text on reuse. It repeats stage goals and available transitions, including their conditions and required check workflows. For final stages, it also repeats the guidance to call `workflow_exit` after completing the stage.

The extension separately publishes the current workflow chain and transition outcomes. These describe the current execution, even when the stage information itself is unchanged.

## Desired state

During ordinary work and after a process restart with saved-session loading, the agent reuses unchanged stage information that remains in its context. It receives missing or changed information and knows the current state and currently available transitions.

Following the boundary agreed for F1, this proposal permits full repeated delivery after switching the selected main agent. Current instructions and the selected agent's permissions remain necessary.

## Problem boundary

Included: repeated stage information on activation, stage entry, return from a nested workflow, and context restoration in main-agent and subagent sessions. The problem includes process restart with saved-session loading.

Outside this problem:

- Repeated shared workflow rules and the workflow graph, covered by F1.
- Shortening transition and exit justifications, covered by F3.
- Changing workflow stages, transition eligibility, checks before transitions, or exit rules.
- Removing current-state information, pending transitions, or transition outcomes.
- Optimizing across a switch of the selected main agent, changing reminders, or changing user-interface rendering.

## Assumptions

No assumptions are needed to establish repeated text. Its effect on provider charges has not been measured.

## Open questions

None about the observed problem. The proposed scope and critical requirements await approval.
