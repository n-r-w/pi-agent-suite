# Problem Statement

## Key definitions and abbreviations
- Nested process: a process that an agent runs inside a stage of a workflow, after which the agent continues the same stage. Examples: a check of the result of a stage before the agent leaves it, or the handling of a defect that the agent found during the stage.
- Parent workflow: the workflow in whose stage the agent runs a nested process.

## Context
Authors of agent rules describe the processes that agents must follow. A workflow is the deterministic part: the workflow extension tracks each move, the agent enters a stage only by `workflow_transition`, and it sees the transitions that are available from the active stage. Nested processes have a condition of their start, rules, and a graph of steps, as workflows have, and they live in text instructions, for example skills.

## Observed Problem
Only a part of the processes that agents must follow fits into the deterministic workflow mechanism. Nested processes stay outside it, so whether an agent passes their steps depends only on how well the model follows text, and agents skip these steps or mix them with the stages of the parent workflow.

## Affected Audience
- Agents that work by workflows and meet nested processes inside their stages, main agents and subagents.
- Users who lead these agents and must notice skipped steps and correct the agent.
- Authors of agent rules, who keep a nested process either as text that nothing tracks or as a second copy in the stages of a workflow.

## Evidence
- `pi-package/extensions/workflow/workflow.ts`, `WorkflowState`: one state holds one `workflow`, one `route`, and one `status`. `activateWorkflow` and `createWorkflow` start a new state, and `pi-package/extensions/workflow/prompts/activate-description.md` states "Activation replaces current workflow state." So a nested process that runs as a workflow replaces the parent workflow.
- `pi-package/extensions/workflow/index.ts`, `completeSettledWorkflow`: a workflow ends only on its final stage, on event `agent_settled` after a successful agent run. After that end, the agent is on no stage of any earlier workflow.
- Observed agent sessions where agents mark the start and the end of a nested process by lines in their messages:
  - Agents took transitions of the parent workflow before a nested process ended.
  - A workflow whose stages repeat the steps of a nested check process made the agent follow both copies: the agent started the check once and passed many stages before it ended the check.
  - An agent started a nested process, took a rework transition of the parent workflow in the middle of it, and then left the stage that it returned to within a minute: the nested process replaced the work of the stage.
- Observed runs of the same workflows and nested processes:
  - An agent that moved between stages only by calls of a transition tool did the work of each stage after its move and passed each check that a stage named at its exit, while it skipped a nested check that only a skill named.
  - Without such a tool, the same agent with the same task ran a nested check for each result of its stages in one run and for one result of five in the next one.
  - Agents whose rules required a line in their messages for each step of a nested process wrote no such line.

## Impact
- `HIGH`: an agent skips steps of a nested process or replaces the work of a stage with them, and later stages start from a result that nobody checked.
- `MEDIUM`: authors add text rules that make the agent report the steps of nested processes, and agents skip these rules too, so the user still has to find and correct each skipped step.
- `MEDIUM`: an author who copies a nested process into the stages of a workflow keeps two copies of one process, which diverge, and the agent follows both at the same time.

## Current State
- The extension tracks the stages of one workflow at a time. Activation or creation of a workflow replaces the previous one, and a workflow ends only on its final stage at the end of a successful agent run.
- A nested process exists only as text. The agent decides itself when it starts, which step comes next, and when it ends; nothing in the harness checks this.

## Desired State
Each process that agents must follow, nested processes included, runs under the deterministic mechanism, so that the harness tracks its steps as it tracks the stages of a workflow.

## Problem Boundary
- Agents that work by catalog workflows or by workflows created through `workflow_create` and meet nested processes inside their stages, main agents and subagents.
- Nested processes that authors of agent rules describe, whatever their source.
- Outside the boundary: the content of a particular set of rules, for example which processes become nested workflows.

## Assumptions
No assumptions.

## Open Questions
No open questions.
