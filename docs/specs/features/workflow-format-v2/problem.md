# Problem Statement

## Key definitions and abbreviations
Terms of this feature are defined in [terms.md](terms.md): stage goal, stage task, known stage, inline entry, reuse entry, rework transition, transition ground, unconditional transition, and workflow format version.

## Context
The workflow extension leads an agent through the stages of a workflow. Each stage has a prompt. By convention, the prompt starts with the stage goal and then describes the stage task, rules, completion criteria, and the conditions of rework transitions in a section "Rework rules".

To keep the context small, the extension publishes the prompt of a stage once. A later entry into a known stage, for example after a rework transition, is a reuse entry: the agent receives the stage ID and the available transitions and relies on the prompt that it received earlier.

## Observed Problem
Two parts of the stage text that the agent needs at the moment of a decision are missing from the records that the agent sees at this moment:
1. After a rework transition returns an agent to a known stage, the agent receives no stage goal, although the goal tells the agent what state ends the stage. The extension cannot add the goal to a reuse entry, because the workflow format has no goal element: the goal is only a convention inside the prompt text.
2. When the agent chooses a transition, the list of available transitions names only the target stage and the transition type. The conditions of each transition are free text inside the stage prompt, so after a reuse entry the agent chooses a transition without its conditions in view. When a stage has several `advance` transitions, the choice between them also depends only on this text.

In addition, LLMs confuse the stage goal with the stage task, both when they write a workflow and when they execute a stage.

## Affected Audience
- Agents that execute catalog workflows and workflows created through `workflow_create`.
- Users who lead these agents and must notice when an agent skips the goal of a stage or takes a transition without its condition.
- Workflow authors, both people who write catalog YAML files and agents that call `workflow_create`.

## Evidence
- `pi-package/extensions/workflow/context.ts`, `WorkflowContext.enterStage`: a stage that is already in `knownStages` gets `guidelines="reuse"`, and `renderStageActivation` then renders only the available transitions.
- `pi-package/extensions/workflow/context.ts`, `renderAvailableTransitions`: each transition is rendered with the attributes `to` and `type` only.
- `docs/extensions/workflow.md`, section "Provider context": "Repeated entry into a known unchanged stage uses `guidelines="reuse"` and does not repeat the prompt."
- `pi-package/extensions/workflow/workflow.ts`, `WorkflowStage` and `WorkflowTransition`: a stage has `id`, `description`, `prompt`, `triggers`, `initial`, `final`, and `model`; a transition has `from`, `to`, and `type`. No field holds the stage goal or the condition of a transition.
- `pi-package/extensions/workflow/index.ts`, schema of `workflow_create`: the description of `prompt` asks the author to start the prompt with a `Goal:` line and to put rework rules into the prompt. The catalog loader checks neither convention.
- The catalog of the project owner has 126 stages. 88 of them describe rework conditions in a section "Rework rules" of the prompt, and 4 stages have more than one `advance` transition.
- Observation in a session of another project that ran the catalog workflow `ComplexCoding`:
  - The agent returned through rework transitions from the implementation stage to the technical solution stage, whose goal is that the user confirms the technical solution after seeing its text.
  - In two consecutive replies, the agent proposed to prepare the implementation plan without showing the changed technical solution.
  - The extension had published the prompt of this stage about two and a half hours earlier in the same session.
- Observation of the project owner: when an LLM writes a stage goal, it often writes the actions of the stage, and when it executes a stage, it treats finished actions as a reached goal.

## Impact
- An agent that returns to a stage for rework can skip the purpose of the return, for example a confirmation by the user, and continue with work of a later stage.
- An agent can take a transition whose condition does not hold, or miss a transition whose condition holds, because it chooses without the conditions in view.
- The user must notice these errors and correct the agent by a message.
- Rework is the moment when the results of earlier stages change, so a skipped goal or a wrong transition at this moment lets later stages start from an unconfirmed result.

## Current State
- A catalog workflow file has no format version.
- The stage goal is a paragraph of the stage prompt that the format does not identify.
- The conditions of transitions are free text in the stage prompt that the format does not identify.
- An inline entry contains the complete stage prompt, so it contains the goal and the rework rules when the author wrote them.
- A reuse entry contains no part of the stage prompt.
- `workflow_transition` accepts only the target stage ID.
- The model-facing guidance of the workflow tools does not explain the difference between a stage goal and a stage task.

## Desired State
For a workflow that declares a new format version:
- On each entry into a stage, including a reuse entry, the agent receives the goal of this stage.
- Wherever the agent sees the available transitions, it sees the conditions of each transition that has them, and it takes such a transition by naming the condition that holds.
- When no condition of any available transition fits the situation, the agent stops and describes the situation instead of choosing a transition by its own judgment.

Workflows without a declared version behave as they do now. The agent guidance states the difference between a stage goal and a stage task.

## Problem Boundary
- Catalog workflows loaded from YAML files.
- Workflows created and edited through `workflow_create` and `workflow_edit_stage`.
- Entries into stages, in particular reuse entries after rework transitions.
- Choice of a transition by the agent.
- Existing users of the package whose catalog files and saved sessions have no format version.

## Assumptions
- A stage goal in a reuse entry restores the focus of the agent on the stage after a rework transition. This assumption is based on the observation in the section "Evidence" and is not measured.
- Conditions of transitions that the agent sees next to the transitions lead to fewer wrong transitions than the same conditions inside the stage prompt. This assumption is not measured.

## Open Questions
None.
