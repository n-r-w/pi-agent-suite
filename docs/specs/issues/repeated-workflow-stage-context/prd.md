# Idea: Reuse unchanged stage information

## Definitions

Definitions of stage information, model context, and current state are in [the problem statement](problem.md#key-definitions-and-abbreviations).

## Context and problem

See the proposed [problem statement](problem.md).

## Goal

Reduce repeated stage information while preserving the agent's knowledge of its current work, completion conditions, and permitted next actions.

## Affected scenarios

An agent revisits a stage, starts another run of a familiar workflow, or returns to a waiting stage after a nested workflow exits. Process restart, compaction, and context editing can affect which earlier information remains available. The same cases occur in main-agent and subagent sessions.

## Scope and non-scope

In scope: reuse of unchanged stage information on activation, stage entry, return from a nested workflow, and context restoration, including after process restart with saved-session loading.

Following the boundary agreed for F1, this proposal accepts full repeated delivery after switching the selected main agent. Current instructions and the selected agent's existing permissions remain necessary.

Out of scope: shared workflow rules and graphs from F1, transition and exit justifications from F3, changes to workflow execution rules, removal of current-state information, reminders, and user-interface rendering.

## Requirements

The problem statement and requirements below are proposed and await approval.

### Functional requirements

- [ ] FRQ-01: When the extension publishes a stage's active state and previously delivered stage information is unchanged and remains in the agent's model context, the extension SHALL identify that earlier information for reuse and omit its full repeated text. This applies to main agents and subagents during ordinary work and after process restart with saved-session loading. After switching the selected main agent, full repeated delivery is permitted.
  - Origin: formulated. F2 identifies repeated goals, transitions, and final-stage leave guidance despite reuse of stage instructions.
  - Goal: Remove repeated stage information already available to the agent.
  - Goal achievement: Partial. Reuse also depends on supplying missing information and preserving current state.
  - Feasibility: Confirmed. The extension already inspects retained messages and reuses stage instructions.

- [ ] FRQ-02: When stage information needed to continue is missing from the agent's model context or has changed, the extension SHALL provide the missing or changed current information before the agent continues stage work. This includes first delivery, separate agent contexts, compaction, context editing, and loading a saved session after process restart.
  - Origin: formulated. Omitting repeated information solves F2 only while the agent retains current information needed to work.
  - Goal: Preserve the stage goal, instructions, transition conditions, required check workflows, and final-stage exit guidance needed by the agent.
  - Goal achievement: Partial. Availability protects correct use of the stage; FRQ-01 addresses repetitions.
  - Feasibility: Confirmed. The extension has the current stage definition, transition definitions, and retained workflow messages.

- [ ] FRQ-03: Whenever the extension publishes or restores the active stage, it SHALL give the agent the current state and an unambiguous indication of currently available transitions. Reuse SHALL preserve transition conditions, required check workflows, and existing selected-agent permissions. A refused transition SHALL remain distinguishable from an accepted transition, including when the agent continues at the same stage.
  - Origin: formulated. Available rework transitions depend on stages visited in the current run, and nested-workflow exit can permit or refuse a pending transition.
  - Goal: Keep current execution distinct from previously delivered stage information.
  - Goal achievement: Partial. Current-state information makes reuse safe; FRQ-01 and FRQ-02 address repeated and missing content.
  - Feasibility: Confirmed. The extension already computes available transitions and publishes workflow chains and transition outcomes.

### Non-functional requirements

None. No provider-cost or latency threshold has been established.

## Critical scenarios

Each scenario applies to main-agent and subagent sessions unless it explicitly compares separate contexts or switches the selected main agent.

- SCN-01: First entry into a stage
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives stage information and current state.
  - Area: Workflow activation or transition and model context.
  - Flow: The agent enters a stage whose information is absent from context. It receives the current stage information, state, and available transitions needed to begin.

- SCN-02: Return to a known stage
  - Requirements: FRQ-01, FRQ-03.
  - Level: external. The agent receives current state with reused information.
  - Area: Workflow transitions and model context.
  - Flow: The agent returns to a stage whose information and available transitions are unchanged and retained. It receives current state and references to that information without further full copies.

- SCN-03: Another run of a familiar workflow
  - Requirements: FRQ-01, FRQ-02, FRQ-03.
  - Level: external. The agent receives the current run's stage information.
  - Area: Workflow completion, repeated activation, and model context.
  - Flow: The agent starts the same workflow again while earlier stage information remains in context. It reuses unchanged information. Rework transitions available only because of visits in the earlier run are excluded from the current available set.

- SCN-04: A newly available rework transition
  - Requirements: FRQ-01, FRQ-02, FRQ-03.
  - Level: external. The agent receives updated transition availability.
  - Area: Workflow route history, stage entry, and model context.
  - Flow: The agent revisits a known stage after visiting another stage that is a rework target. It receives an indication that the additional rework transition is now available, with its conditions and required check workflow when defined, while unchanged retained information is reused.

- SCN-05: Missing information after compaction or context editing
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives missing current stage information.
  - Area: Context compaction or editing and stage restoration.
  - Flow: Earlier stage information becomes absent from context. On restoration or the next stage entry, the agent receives the missing current information and current state before continuing.

- SCN-06: Process restart with retained information
  - Requirements: FRQ-01, FRQ-03.
  - Level: external. The agent receives the restored stage state.
  - Area: Process restart, saved-session loading, and workflow restoration.
  - Flow: The agent loads a saved session with an active stage and its current information still in context. It receives current state and transition availability while unchanged retained information is reused.

- SCN-07: Process restart with missing information
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives missing stage information before continuing.
  - Area: Process restart, saved-session loading, and workflow restoration or activation.
  - Flow: The agent loads a saved session whose stage information was removed from context. Whether continuing an active workflow or starting a new run, it receives the missing current information before stage work.

- SCN-08: Changed stage information
  - Requirements: FRQ-01, FRQ-02, FRQ-03.
  - Level: external. The agent receives current information for a known stage.
  - Area: Stage definitions, transition definitions, stage entry or restoration, and model context.
  - Flow: The agent encounters a known stage whose goal, instructions, transition conditions, required check workflows, or final-stage status have changed. It receives the changed current information while reusing unchanged retained information and follows current completion and exit rules.

- SCN-09: Nested check permits a transition
  - Requirements: FRQ-01, FRQ-02, FRQ-03.
  - Level: external. The agent receives the accepted transition's resulting state.
  - Area: Waiting workflow, nested check, transition completion, and model context.
  - Flow: A nested check permits the waiting transition. The agent receives the resulting active stage and available transitions. It reuses retained unchanged target-stage information and receives target-stage information that is missing or changed.

- SCN-10: Nested check refuses a transition
  - Requirements: FRQ-01, FRQ-03.
  - Level: external. The agent receives the refusal and continuing stage state.
  - Area: Waiting workflow, nested check, transition refusal, and model context.
  - Flow: A nested check refuses the waiting transition. The agent receives an explicit refusal and knows that the waiting workflow remains at its earlier stage, while its unchanged retained stage information is reused.

- SCN-11: Separate subagent context
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. A subagent receives stage information in its own context.
  - Area: Main-agent session, separate subagent session, and stage entry.
  - Flow: A main agent has received stage information. A subagent enters that stage in a separate context that lacks it and receives the current information, state, and available transitions needed for its own work.

- SCN-12: Switch of the selected main agent
  - Requirements: FRQ-01, main-agent-switch exception; FRQ-02; FRQ-03, selected-agent permissions.
  - Level: external. The selected main agent receives current information for permitted work.
  - Area: Main-agent selection, workflow permissions, and model context.
  - Flow: The user switches the selected main agent. Full repeated delivery of stage information is accepted. For permitted workflow work, the selected agent has current stage information and state; earlier messages do not grant permissions excluded by its existing policy.

## Open questions

None about current behavior. The proposed problem statement, requirements, and application of the F1 main-agent-switch compromise await approval. The implementation approach remains undecided.

## Technical supplement

Feasibility references include `WorkflowJournal.enterStage`, `WorkflowJournal.restore`, `renderStageActivation`, `renderWorkflowCheckpoint`, and `renderAvailableTransitions` in `pi-package/extensions/workflow/context.ts`, and `getAvailableTransitions` in `pi-package/extensions/workflow/workflow.ts`. They establish existing capabilities without selecting a reuse mechanism.

## References

- [Proposed problem statement](problem.md).
- [F1 requirements and main-agent-switch boundary](../repeated-workflow-activation-context/prd.md).
