# Problem Statement: Checks bound to transitions

## Key definitions and abbreviations
Terms of format 3 are in [terms.md](terms.md), and terms of this addition are in [terms-transition-workflow.md](terms-transition-workflow.md).
- Stage exit check: a check that an agent must pass before it takes a transition from a stage, for example a check of the results of the stage.

## Context
Workflow authors attach stage exit checks to stages. A stage exit check is a nested process with a fixed moment of start: the moment when the agent wants to take a transition. Format 3 lets an author turn a nested process into a nested workflow, which an agent starts inside a stage and which returns the agent to that stage when it ends ([prd.md](prd.md)).

## Observed Problem
An agent can take a transition from a stage without its stage exit check, and the next stage then starts from a result that nobody checked. Whether the check runs depends only on how well the model follows text, also when the check exists as a nested workflow of format 3.

## Affected Audience
- Agents that work by workflows whose stages have stage exit checks, main agents and subagents.
- Users who rely on the result of a stage and receive a result that nobody checked.
- Workflow authors, who describe a stage exit check as text in the stage and, with format 3, also as a nested workflow, so that one check has two places to keep in agreement.

## Evidence
- `RegularCoding.yaml` of the agent suite, stage `align_goal`: the stage prompt ends with the text "Exit: algorithm `CHECK RESULT` of `gate-transition` skill for `PROBLEM DESCRIPTION`, for `REQUIREMENTS`, and for `CRITICAL SCENARIOS`." Stages `confirm_plan` and `user_review` of the same file have such text too. The catalog of the agent suite has 36 such `Exit:` parts in 11 of its 16 workflows.
- `transition-description.md` of the agent suite, rule 2: "Take an `advance` transition only when the active stage is complete and, when the stage has part `Exit`, the check that this part names allows the move." The rule is text in the tool description.
- `pi-package/extensions/workflow/workflow.ts`, `transitionWorkflow`: the extension enters the target stage for each request whose target stage is available and whose ground is declared.
- [prd.md](prd.md), FRQ-01: the agent starts a nested workflow by its own decision while a stage is active.

## Impact
- `HIGH`: an agent takes a transition without the stage exit check, and later stages start from a result that nobody checked.
- `MEDIUM`: an author who turns a stage exit check into a nested workflow keeps the text in the stage that tells the agent to start it, and the two places can diverge.

## Current State
- A stage exit check exists as text in the stage prompt and in the description of `workflow_transition`. The agent decides whether to run it, how to run it, and whether its result allows the transition.
- With format 3, the agent can run the check as a nested workflow and return to the stage. The transition after the return is an ordinary transition, and the agent can take it also without the check.

## Problem Boundary
- Transitions of format 3 workflows, from catalog files and from `workflow_create`, main agents and subagents.
- Stage exit checks and any other nested process whose moment of start is a transition.
- Outside the boundary: which checks a particular set of rules requires before which transitions, and workflows of formats 1 and 2.

## Assumptions
- How often agents skip a stage exit check that only text names was not measured. The observed sessions in [problem.md](problem.md) show skipped steps of nested checks that only a skill named.

## Open Questions
No open questions.
