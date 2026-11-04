# Idea: Checks bound to transitions

## Definitions
Terms of format 3 are in [terms.md](terms.md).
- Stage exit check: a check that an agent must pass before it takes a transition from a stage, for example a check of the results of the stage.

## Context and Problem
Problem statement: [problem-transition-workflow.md](problem-transition-workflow.md). An agent can take a transition without its stage exit check, also when the check exists as a nested workflow of format 3, and the next stage then starts from a result that nobody checked. A workflow author describes such a check in two places: as text in the stage and as a nested workflow.

## Goal
A transition for which a workflow requires a stage exit check happens only after this check, and the workflow author describes each such check in one place.

## Affected Scenarios
- An agent requests a transition, passes the check that the transition requires, and continues on the target stage.
- The check shows that the stage is not done, and the agent continues the stage or returns to an earlier one.
- The user tells the agent to skip the check or to stop the work while the check runs.

## Scope and Non-Scope
In scope:
- Transitions of format 3 workflows from catalog files and from `workflow_create`, of both types, `advance` and `rework`.
- Main agents and subagents, with the workflows that their definitions allow.
- Each requirement of [prd.md](prd.md) about nested workflows applies to a check that a transition starts, for example the restoration of the chain after compaction (FRQ-11) and the information about each change of the chain (FRQ-14).

Out of scope:
- Which checks of a particular set of rules are bound to which transitions, and the removal of the text of stage exit checks from catalog workflows.
- Workflows of formats 1 and 2.
- Mod `workflow` of Claude Code.

## Requirements

### Functional Requirements
- [X] FRQ-01: A workflow author can name, on a transition of a format 3 workflow, a nested workflow as its stage exit check. When the agent requests this transition, the harness starts this nested workflow, and the agent stays on the stage from which it requested the transition.
  - Origin: source. Constraint of the requester: the check is a nested workflow that the transition names, and the request of the transition starts it.
  - Goal: the check starts at each request of the transition without a text instruction to the agent, and the author describes the check only in the definition of the workflow.
  - Goal achievement: Partial. FRQ-02 makes the transition depend on the end of the check.
  - Feasibility: Confirmed. Format 3 already starts nested workflows on top of the chain and keeps the parent on its stage ([prd.md](prd.md), FRQ-01 and FRQ-02).
- [X] FRQ-02: When the agent leaves the check that a transition started, it states whether the transition may continue, and it can leave with either statement at any step of the check. When the agent allows the transition, the harness performs it in the same agent run. When the agent does not allow it, the agent continues the stage from which it requested the transition, and the transition does not happen.
  - Origin: source. Constraints of the requester: the transition happens only when the end of the check allows it, and otherwise the agent stays on its stage; the agent can end the check at any step, because the user can tell it to skip the check or to stop the work. Accepted risk: an agent can allow the transition without the check; the basis of the exit makes this visible in the session ([prd.md](prd.md), FRQ-09).
  - Goal: the transition happens only after the check ends with its permission.
  - Goal achievement: Full.
  - Feasibility: Confirmed. Format 3 already returns the agent to the calling stage when a nested workflow ends ([prd.md](prd.md), FRQ-03), and the harness already performs transitions.
- [X] FRQ-06: When the check that a transition names cannot start, for example because its ID is already in the running chain, the transition does not happen, and the agent learns why.
  - Origin: formulated. A check that cannot start would otherwise leave the transition without its check.
  - Goal: no transition that requires a check happens without the start of this check.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The harness already rejects such starts by the rules of format 3 ([prd.md](prd.md), FRQ-05 and FRQ-10).

### Non-Functional Requirements
No non-functional requirements beyond those of [prd.md](prd.md).

## Critical Scenarios
In each scenario, the nested workflow is the workflow that the author named on the transition by FRQ-01, and the agent decides at its exit whether the transition continues by FRQ-02.

- SCN-01: Agent allows the transition at the end of the nested workflow
  - Requirements: FRQ-01 (`advance` transition), FRQ-02 (permission on the last stage of the nested workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: the agent on a stage requests an `advance` transition that names a nested workflow; the harness starts the nested workflow, and the transition has not happened yet; the agent passes the stages of the nested workflow and, on its last stage, leaves it and allows the transition; in the same agent run, the agent works on the target stage of the transition.
- SCN-02: Agent refuses the transition in the middle of the nested workflow
  - Requirements: FRQ-01 (repeated request), FRQ-02 (refusal on a middle stage of the nested workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: the agent requests a transition that names a nested workflow, and the harness starts it; on a middle stage of the nested workflow, the agent leaves it and does not allow the transition; the agent works on the stage from which it requested the transition, and the target stage is not active; the agent requests the same transition again, and the harness starts the nested workflow again.
- SCN-03: Agent skips the nested workflow at the instruction of the user
  - Requirements: FRQ-01 (`rework` transition), FRQ-02 (permission on the first stage of the nested workflow)
  - Level: external. The agent sees the results in the answers of the harness and in the context.
  - Area: the workflow extension, the workflow catalog, and the context that the agent receives
  - Flow: the user tells the agent to skip the check; the agent requests a `rework` transition that names a nested workflow, and the harness starts it; on its first stage, the agent leaves it and allows the transition; the agent works on the earlier stage that the transition leads to.
- SCN-04: Nested workflow that cannot start
  - Requirements: FRQ-06 (nested workflow already in the running chain)
  - Level: external. The agent sees the rejection.
  - Area: the workflow extension and the workflow catalog
  - Flow: an agent whose running chain already holds the nested workflow that a transition names requests this transition; the harness does not start the nested workflow and does not perform the transition, and the agent stays on its stage and learns why.

## Open Questions
No open questions.

## Technical Supplement
No technical supplement.

## References
- [problem-transition-workflow.md](problem-transition-workflow.md)
- [prd.md](prd.md)
