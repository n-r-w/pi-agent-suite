# Technical Solution: Workflow Model and Thinking Settings

## Problem Statement
- PRB-01: Ready-made YAML workflows cannot define model and thinking settings for a workflow or its stages.
- PRB-02: Model ID validation is duplicated across several configuration boundaries.
- PRB-03: Pi's `setThinkingLevel` clamps unsupported levels, while `setModel` reports an application failure through `false` or an exception.

## Proposed Solution

### SOL-01: Shared model settings contract
- Add `pi-package/shared/model-settings.ts`.
- Define the shared `ModelSettings` type with independently optional `id` and `thinking` fields.
- Move provider/model shape validation and model-settings parsing into this module.
- Reuse the existing `ReasoningLevel` contract from `pi-package/shared/reasoning-levels.ts`, including `max`.
- Add one shared capability check based on `getSupportedThinkingLevels(model)`.
- Use the shared contract in every configuration boundary that accepts model or thinking settings.
- Preserve boundary-specific error messages and existing configuration field names outside workflow settings.

### SOL-02: Workflow configuration model
- Add `model?: ModelSettings` to `WorkflowDefinition`.
- Add `model?: ModelSettings` to `WorkflowStage`.
- Extend catalog YAML parsing to accept `model` at the workflow and stage levels.
- Keep `workflow_create` unable to define model settings.
- Use source-specific parser key sets so dynamic workflow definitions reject `model` at both levels.
- Validate saved catalog snapshots with model settings and saved dynamic snapshots without them.

Workflow YAML shape:

```yaml
model:
  id: provider/model
  thinking: high
```

### SOL-03: Agent settings as a runtime source
- Add the shared `model` settings to `MainAgentContribution`.
- `main-agent-selection` publishes the selected agent's model settings through the existing runtime composition.
- The workflow extension reads agent settings from runtime composition instead of reading agent files.
- The current Pi model and thinking level remain the fallback when no higher-priority setting exists.

### SOL-04: Effective settings resolution
- Add one resolver that calculates model and thinking independently.
- Resolve each field in this order:
  `stage → workflow → agent → current Pi runtime value`.
- During activation, use the initial stage as the stage source.
- During a transition, use the target stage as the stage source.
- For a rework transition, use the rework target stage.
- When a model change is requested and thinking is not explicitly configured, treat the current effective thinking level as the fallback value and validate it against the target model.
- When no source provides a model value, no model mutation occurs. When no source provides a thinking value, no thinking mutation occurs unless a model change requires preserving and validating the current Pi runtime thinking level.

### SOL-05: Runtime application and failure handling
- Resolve and validate the target model and effective thinking level before appending an activation or transition entry.
- Resolve configured model IDs through the current `ExtensionContext.modelRegistry`.
- Check the requested or preserved thinking level against the target model before calling `setThinkingLevel` or changing the model.
- Treat an unknown model as an operation error.
- Treat `setModel() === false` or a thrown `setModel` error as an operation error.
- Call `setThinkingLevel` only after model validation and model application succeed.
- Verify the resulting level through `getThinkingLevel()` because Pi can clamp the requested level.
- Append the workflow entry only after runtime settings are applied successfully.
- Keep the previous workflow state when validation or runtime application fails.
- Restore the previous model and thinking level when session persistence fails after runtime application.
- Do not add model or thinking arguments to workflow tools; the LLM continues to provide only workflow and stage IDs.

### SOL-06: Lifecycle synchronization
- Cache the current model and model registry in workflow runtime state.
- Update the cached model on Pi's `model_select` event.
- Synchronize model settings during `session_start` and `session_tree` after replaying workflow state.
- Extend the existing main-agent contribution listener to reapply active workflow settings after agent changes.
- Reapply settings from the active route instead of persisting a second runtime-settings snapshot.

### SOL-07: Reuse across other modules
- Replace local provider/model validation with the shared model contract in:
  - `shared/agent-registry.ts`;
  - `extensions/ask-llm`;
  - `extensions/consult-advisor`;
  - `extensions/convene-council`;
  - `extensions/run-subagent`;
  - `shared/custom-compaction-config.ts`;
  - `shared/tool-result-summary.ts`.
- Run the shared thinking-level capability check before auxiliary LLM requests.
- Keep `buildAuxiliaryLlmOptions` as an option serializer; it must not silently clamp or replace an unsupported level.
- Keep main-session application and auxiliary-request application as separate adapters because their Pi APIs have different failure semantics.

### SOL-08: Validation
- Add shared-contract tests for model IDs, all seven thinking levels, optional fields, and model capability checks.
- Add workflow parser tests for workflow-level and stage-level settings.
- Add tests proving dynamic workflow creation rejects model settings.
- Add precedence tests for model and thinking independently.
- Add activation, advance, and rework transition tests.
- Add failure tests for unknown models, unsupported thinking levels, `setModel() === false`, thrown model-application errors, and persistence errors.
- Add lifecycle tests for session replay and main-agent changes.
- Update workflow and agent documentation with the shared settings shape and the `max` thinking level.

## Overengineering and Overspecification Considerations
- Workflow tool parameters remain unchanged.
- Dynamic workflows remain excluded.
- No model discovery or provider management is added.
- No second runtime settings store is introduced.
- Shared validation is centralized, while API-specific application remains local to avoid a universal adapter with incompatible failure behavior.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/workflow/workflow.ts` — workflow and stage definitions, validation, persistence, and route transitions.
- REF-02: `pi-package/extensions/workflow/index.ts` — workflow tool registration and lifecycle synchronization.
- REF-03: `pi-package/shared/agent-registry.ts` — current agent model parsing and validation.
- REF-04: `pi-package/shared/reasoning-levels.ts` — shared thinking-level contract.
- REF-05: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — Pi extension API behavior.
- REF-06: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/models.js` — model thinking-level capability and clamping behavior.
