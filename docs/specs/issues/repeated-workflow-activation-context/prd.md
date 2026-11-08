# Idea: Reuse workflow rules and graph on repeated activation

## Definitions

Definitions of activation, shared rules, workflow graph, and model context are in [the problem statement](problem.md#key-definitions-and-abbreviations).

## Context and problem

See the approved [problem statement](problem.md).

## Goal

Reduce repeated delivery of shared rules and workflow graphs while the agent retains all information needed to work in the active workflow.

## Affected scenarios

An agent starts a workflow again after finishing an earlier run, including when another workflow ran in between. This occurs in both main-agent and subagent sessions. After a process restart, an agent can load a saved session and start a completed workflow again. Compaction and context editing can change which earlier information remains available. Switching the selected main agent is a separate case in which repeated delivery is accepted.

## Scope and non-scope

In scope: shared rules and graph information sent on repeated activation, including after a process restart, and preservation of their availability when earlier information is absent or outdated.

Approved exception: after switching the selected main agent, the extension may send full copies of shared rules and graphs again, even when retained in context. Deduplication across that switch is outside this issue. Current instructions and the selected agent's existing permissions remain necessary.

Out of scope: restoration of an active workflow after a process restart. In this case, the extension already omits retained shared rules and graphs, as section "Current state" of the problem statement describes.

Also out of scope: repeated activation of workflows that `workflow_create` creates; each activation of such a workflow keeps its full rules and graph. Restoration of an active workflow after another extension removes or replaces its records through a context edit, outside session start, branch navigation, and compaction; no producer in Pi or this package makes such an edit now.

Also out of scope: reducing stage goals and available transitions on stage entry, shortening transition or exit justifications, changing periodic reminders or user-interface rendering, and changing workflow execution rules.

## Requirements

The requirements below are approved.

### Functional requirements

- [ ] FRQ-01: When an agent activates a catalog workflow and the current shared rules and graph remain in its model context, the extension SHALL identify the earlier information to reuse and omit further full copies of those rules and that graph. This applies to main agents and subagents, including after an intervening workflow or loading a saved session. After switching the selected main agent, full repeated delivery is permitted.
  - Origin: source. The approved problem statement describes repeated delivery of unchanged information already in context.
  - Goal: Eliminate duplicate shared rules and graph information on repeated activation.
  - Goal achievement: Partial. Reuse removes repetitions but also depends on preserving missing information and current state.
  - Feasibility: Confirmed. The extension already distinguishes retained workflow messages and reuses previously delivered stage instructions.

- [ ] FRQ-02: When the current shared rules or graph are absent from the agent's model context, the extension SHALL provide the missing current information before the agent continues work in the activated or restored workflow, including after a process restart. A switch of the selected main agent SHALL NOT make the extension treat missing information as available. A copy from another session, a copy absent after compaction or context editing, and an outdated copy SHALL NOT count as available current information.
  - Origin: source. The approved desired state preserves the instructions needed to continue and restores information lost from context.
  - Goal: Keep required workflow information available when reuse is not possible.
  - Goal achievement: Partial. Availability protects the agent from incomplete or outdated guidance; FRQ-01 addresses duplication.
  - Feasibility: Confirmed. The extension has the active workflow definition and can inspect retained workflow messages when restoring context.

- [ ] FRQ-03: On each activation, including when earlier information is reused, the extension SHALL tell the agent which workflow and stage are active and which enclosing workflows are waiting, and preserve delivery of the stage information needed to continue under the existing workflow rules. After switching the selected main agent, the extension SHALL preserve availability of current instructions for permitted workflow work and enforce the selected agent's existing permissions.
  - Origin: source. The approved desired state preserves the agent's knowledge of the active workflow and stage and the instructions needed to continue.
  - Goal: Keep each activation understandable when shared rules and graph information are reused.
  - Goal achievement: Partial. Current-state information makes reuse usable; FRQ-01 and FRQ-02 address repeated and missing definitions.
  - Feasibility: Confirmed. The extension already publishes the current workflow chain and stage information on activation.

### Non-functional requirements

None. This change targets repeated information directly; no provider-cost or latency threshold has been established.

## Critical scenarios

Each scenario applies to both main-agent and subagent sessions unless it explicitly compares separate sessions or switches the selected main agent.

- SCN-01: First activation
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives workflow information.
  - Area: Workflow activation and model context.
  - Flow: The agent starts a workflow with no earlier definition in its context. It receives the shared rules, graph, and current workflow and stage information needed to begin.

- SCN-02: Repeated activation with retained information
  - Requirements: FRQ-01, FRQ-03.
  - Level: external. The agent receives an activation that reuses earlier information.
  - Area: Workflow completion, subsequent activation, and model context.
  - Flow: The agent finishes a workflow, runs another workflow, and starts the original unchanged workflow again while its definition remains in context. It receives a reference to the earlier rules and graph without full duplicate copies, together with the current workflow chain and stage information.

- SCN-03: Context removal before repeated activation
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives information missing from its current context.
  - Area: Compaction or context editing, workflow activation, and model context.
  - Flow: Earlier shared rules or graph information become absent through compaction or context editing. When the agent next activates that workflow, it receives the missing current information and the active state needed to continue.

- SCN-04: Process restart followed by repeated activation with retained information
  - Requirements: FRQ-01, FRQ-03.
  - Level: external. The agent receives an activation after session resumption.
  - Area: Process restart, saved-session loading, workflow activation, and model context.
  - Flow: After a process restart, the agent loads a saved session with the current definition of a previously completed workflow still in model context. When the agent starts that workflow again, it receives a reference to the retained rules and graph without full duplicate copies, plus the current state and stage information.

- SCN-05: Changed definition
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives current workflow information.
  - Area: Workflow definitions, activation, and model context.
  - Flow: An agent activates a workflow while its context contains only an earlier version of the shared rules or graph. It receives the current information needed for this activation and the current state, rather than a reference that treats the outdated information as current.

- SCN-06: Separate agent context
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. A subagent receives its own workflow information.
  - Area: Main-agent session, separate subagent session, and workflow activation.
  - Flow: A main agent has received a workflow definition. A subagent starts the same workflow in a separate session whose context lacks that definition. The subagent receives the rules, graph, and current state needed for its own activation.

- SCN-08: Process restart with missing workflow information
  - Requirements: FRQ-02, FRQ-03.
  - Level: external. The agent receives the missing information before continuing.
  - Area: Process restart, saved-session loading, workflow restoration or activation, and model context.
  - Flow: The agent loads a saved session whose earlier rules or graph are absent after compaction or context editing. Whether continuing an active workflow or starting a completed one again, it receives the missing current information before continuing work.

- SCN-09: Main-agent switch with workflow permission retained
  - Requirements: FRQ-01, the main-agent-switch exception; FRQ-02; FRQ-03.
  - Level: external. The selected main agent receives current workflow information.
  - Area: Main-agent selection, workflow permissions, and model context.
  - Flow: The user switches to a main agent permitted to use the workflow. The selected agent has current rules, graph, and state before continuing workflow work. Full repeated delivery is accepted even when the earlier definition remains in context.

- SCN-10: Main-agent switch with different workflow permissions
  - Requirements: FRQ-03, selected-agent permissions.
  - Level: external. The selected main agent's available workflow operations reflect its permissions.
  - Area: Main-agent selection and workflow permissions.
  - Flow: The user switches to a main agent whose permissions exclude the earlier workflow. Earlier workflow messages and reuse information do not grant the selected agent access to that workflow.

## Open questions

None. The exception for switching the selected main agent and the requirements are approved. The [technical solution](solution.md) describes the implementation approach.

## Technical supplement

Feasibility references in `pi-package/extensions/workflow/context.ts` include `WorkflowJournal.activate`, `WorkflowJournal.restore`, `WorkflowJournal.checkpoint`, `renderWorkflowActivation`, and `renderWorkflowChain`. These references describe available capabilities without selecting a reuse mechanism.

## References

- [Approved problem statement](problem.md).
