# Problem Statement: Workflows started at stage entry

## Key definitions and abbreviations
Terms of format 3 are in [terms.md](terms.md), and terms of this addition are in [terms-stage-workflow.md](terms-stage-workflow.md).

## Context
A stage of a workflow can do its work through a nested workflow, for example collect facts through a research workflow. Format 3 lets the agent start such a nested workflow inside a stage ([prd.md](prd.md), FRQ-01), and bound transitions start a nested workflow when the agent leaves a stage ([prd-transition-workflow.md](prd-transition-workflow.md)). Nothing starts a nested workflow when the agent enters a stage.

## Observed Problem
An agent can do the work of a stage without the nested workflow that the stage prompt names for this work, and the result of the stage then lacks what this workflow gives, for example facts traced from the code. Whether the nested workflow runs depends only on how well the model follows text.

## Affected Audience
- Agents that work by workflows whose stages do their work through a nested workflow, main agents and subagents.
- Users who receive a result built without the work that the stage required.
- Workflow authors, who can express such a start only as text in the stage prompt.

## Evidence
- Log `docs/log/2026-11-04-sonnet-nested-workflows-run.md` of the rules workspace `agent-rules-improvement`: in a run of a Sonnet subagent by workflow `SubagentCoding`, stage `collect_facts` named workflow `Research` as the manner of its action, and the agent did the action with 18 shell commands without `Research`; stage `create_plan` named `BehaviorGraph`, and the agent spent 5 seconds on the stage with no tool call.
- In a second run, after the stage prompts commanded the start directly, the agent started `Research` in `collect_facts` and again skipped `BehaviorGraph` in `create_plan`.
- `pi-package/extensions/workflow/index.ts`, `executeWorkflowTransition`: an unbound transition enters the target stage and runs only its triggers, which accept closed trigger types.

## Impact
- `HIGH`: a stage result lacks the work that its nested workflow does, and later stages rely on it.

## Current State
- A start of a nested workflow at stage entry exists only as text in the stage prompt, and the agent decides whether to follow it.

## Problem Boundary
- Stages of format 3 catalog workflows, main agents and subagents.
- Outside the boundary: which stages of a particular set of rules name which workflows, workflows of formats 1 and 2, and workflows that `workflow_create` makes.

## Assumptions
- Two runs of one model, so the observed skips are a sign, not a rate.

## Open Questions
No open questions.
