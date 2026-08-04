# Problem Statement

## Context
Pi agents can define a model and thinking level in the agent configuration. Ready-made workflows are loaded from the YAML catalog and define a shared prompt, stages, and transitions. The LLM activates workflows and changes stages, but it does not know the catalog of available models.

## Problem Statement
A ready-made YAML workflow cannot define a model or thinking level for the workflow and its stages. When the LLM activates the workflow or changes its stage, the runtime settings cannot reflect the requirements of the current process and remain at the agent or session level.

## Who is affected
- Pi users who create workflows for their agents.
- The LLM that activates workflows and changes stages.
- The Pi runtime that applies the active model and thinking level.

## Evidence
- `pi-package/extensions/workflow/workflow.ts`: `WorkflowDefinition` contains only `id`, `description`, `prompt`, `stages`, and `transitions`.
- `pi-package/extensions/workflow/workflow.ts`: `WorkflowStage` contains only `id`, `description`, `prompt`, `initial`, and `final`.
- `pi-package/extensions/workflow/index.ts`: `workflow_activate` accepts only `workflowId`.
- `pi-package/extensions/workflow/index.ts`: `workflow_transition` accepts only `stageId`.
- `docs/extensions/workflow.md`: the YAML workflow example has no model or thinking settings.
- `docs/extensions/main-agent-selection.md` and `pi-package/shared/agent-registry.ts`: an agent can define optional `model.id` and `model.thinking` values.

## Impact
Users cannot associate model and thinking settings with the context of a workflow or a specific stage. This limits control over agent behavior in multi-stage processes.

## Reproduction Steps
1. Configure an agent with model A and thinking level A.
2. Create a workflow that requires model B or thinking level B for the process or one of its stages.
3. Activate the workflow or transition to the stage.
4. Observe that the workflow tools do not provide workflow-specific model or thinking settings.

## Current State
- An agent can define an optional model and thinking level.
- A YAML workflow can define a shared prompt, stage prompts, and transitions.
- Workflow activation changes the active workflow and initial stage.
- A stage transition changes the active route.
- A workflow cannot define a model or thinking level.

## Desired Outcome
A ready-made YAML workflow can describe optional model and thinking settings for the workflow and its stages. For each setting, the effective source follows this order:

`stage → workflow → agent → current Pi runtime value`

If no source defines a setting, the current Pi runtime value remains unchanged. An unavailable model or unsupported thinking level causes workflow execution to fail with the error returned by Pi; the workflow does not silently fall back to another value.

## Success Metrics
- Activation and stage transition results follow the defined priority order for model and thinking independently.
- An omitted setting does not change the corresponding current Pi runtime value.
- The LLM does not choose a model from the catalog.
- Quantitative cost, speed, and quality metrics are not used for this problem.

## Scope
- Ready-made workflows from the YAML catalog.
- Optional model and thinking settings at workflow and stage levels.
- Workflow activation.
- Stage transitions.
- Model and thinking priority relative to the selected agent and current Pi runtime values.

## Out of Scope / Non-Goals
- Settings for dynamic workflows created through `workflow_create`.
- Automatic model selection by the LLM.
- Changes to agent configuration semantics.
- Provider model discovery or provider availability management.
- Silent fallback when Pi rejects a configured model or thinking level.

## Constraints
- Model and thinking settings are independently optional.
- Stage settings have priority over workflow settings.
- Workflow settings have priority over agent settings.
- Agent settings have priority over the current Pi runtime value.
- If a configured model or thinking level cannot be applied, Pi returns an error during workflow execution.

## Assumptions
- Workflow authors provide model identifiers and thinking levels; the LLM does not select them.
- Workflow settings use the existing model and thinking concepts already available in agent configuration.

## Open Questions
- The PRD must define the YAML representation and validation rules for workflow and stage settings. This is not a blocker for this problem statement.

## Domain Glossary

- **Agent:** A selected Pi configuration with a prompt, optional model, optional thinking level, and other runtime restrictions.
- **Workflow:** A ready-made process loaded from the YAML catalog and represented as a validated graph of stages and transitions.
- **Stage:** A step in a workflow with its own prompt and position in the workflow graph.
- **Workflow activation:** The operation that makes a workflow active and selects its initial stage.
- **Stage transition:** The operation that changes the active stage of the current workflow.
- **Model:** The LLM model used by Pi for the current request.
- **Thinking level:** The model reasoning setting. Existing values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- **Current Pi runtime value:** The model or thinking level active in Pi before a workflow or stage setting is applied.
- **Configuration priority:** The order used to resolve a setting from stage, workflow, agent, and current Pi runtime values.
