# Idea: Workflows started at stage entry

## Definitions
Terms are in [terms.md](terms.md) and [terms-stage-workflow.md](terms-stage-workflow.md).

## Context and Problem
Problem statement: [problem-stage-workflow.md](problem-stage-workflow.md). An agent can do the work of a stage without the nested workflow that the stage prompt names for this work.

## Goal
A stage whose work its author assigns to a nested workflow runs this workflow on each entry, without a decision of the agent.

## Affected Scenarios
- An agent enters a stage that names a stage workflow, works through the stage workflow, and continues the stage after its exit.
- An agent returns to such a stage by a `rework` transition.
- The stage workflow cannot start.

## Scope and Non-Scope
In scope:
- Stages of format 3 catalog workflows, main agents and subagents.
- Each stage entry: activation of the workflow at its initial stage, an `advance` or `rework` transition, and an exit of a bound workflow with permission to continue.

Out of scope:
- Which stages of a particular set of rules name which workflows.
- Workflows of formats 1 and 2, and workflows that `workflow_create` makes.
- Mod `workflow` of Claude Code.

## Requirements

### Functional Requirements
- [X] FRQ-01: A workflow author can name, on a stage of a format 3 catalog workflow, a nested catalog workflow. On each stage entry, the harness first shows the agent the stage with its prompt and then starts this nested workflow, so the stage prompt can state what the nested workflow works on and what the stage does after it.
  - Origin: source. Constraint of the requester: the field is optional, and a stage without it works as before.
  - Goal: the nested workflow runs at each entry without a text instruction to the agent.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The extension already starts a nested workflow without a decision of the agent for a bound transition.
- [X] FRQ-02: When the stage workflow exits, the agent continues the same stage, and the harness does not start the stage workflow again until the next stage entry.
  - Origin: formulated. The stage keeps its own work after the nested workflow.
  - Goal: one run of the stage workflow per stage entry.
  - Goal achievement: Full.
  - Feasibility: Confirmed. An ordinary nested return already resumes the parent stage without stage-entry triggers.
- [X] FRQ-03: When the stage workflow cannot start, for example because its ID already runs in the chain or it left the catalog, the stage entry does not happen, and the agent learns why.
  - Origin: formulated, by FRQ-06 of [prd-transition-workflow.md](prd-transition-workflow.md).
  - Goal: no stage entry happens without its stage workflow.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The harness already rejects such starts for bound transitions before any change of state.

### Non-Functional Requirements
No non-functional requirements beyond those of [prd.md](prd.md).

## Critical Scenarios
- SCN-01: Entry by activation and return
  - Requirements: FRQ-01, FRQ-02
  - Level: external. The agent sees the records of the harness.
  - Area: the workflow extension and the workflow catalog
  - Flow: the agent activates a workflow whose initial stage names a stage workflow; the agent receives the activation record of the workflow and then the activation record of the stage workflow; the agent exits the stage workflow and continues the initial stage, and no new start follows.
- SCN-02: Entry by `rework` and by permitted exit
  - Requirements: FRQ-01
  - Level: external. The agent sees the records of the harness.
  - Area: the workflow extension and the workflow catalog
  - Flow: the agent returns by `rework` to a stage that names a stage workflow, and the stage workflow starts again; the agent allows a bound transition into a stage that names a stage workflow, and the stage workflow starts after the stage record.
- SCN-03: Stage workflow that cannot start
  - Requirements: FRQ-03
  - Level: external. The agent sees the rejection.
  - Area: the workflow extension and the workflow catalog
  - Flow: the agent requests an entry into a stage whose stage workflow already runs in the chain; the harness rejects the request, and state, models, and records stay unchanged.

## Open Questions
No open questions.

## Technical Supplement
No technical supplement.

## References
- [problem-stage-workflow.md](problem-stage-workflow.md)
- [prd.md](prd.md)
- [prd-transition-workflow.md](prd-transition-workflow.md)
