# Technical Solution: Workflow Runtime Settings Restoration

## Problem Statement
- PRB-01: A workflow that reaches a final stage remains active after the current agent run settles.
- PRB-02: The final stage model and thinking level remain active when the next agent run starts.
- PRB-03: The runtime has no persisted restoration snapshot for the model and thinking level that were active before workflow activation.
- PRB-04: A solution based on a TUI dialog or message classification cannot serve autonomous subagents, RPC sessions, or print mode.

## Proposed Solution

### SOL-01: Explicit workflow lifecycle state
- Add `active` and `completed` lifecycle states to the persisted `WorkflowState`.
- Keep a workflow `active` while the current stage is not final.
- Keep a workflow `active` during the agent run that enters a final stage.
- On `agent_settled`, mark the workflow `completed` when the active stage has `final: true`.
- Treat `agent_settled` as a lifecycle event for the current agent run, not as a user-interaction event. No UI, prompt, or message classification is used.
- Persist a completion entry containing the workflow route and completion state. Replaying this entry must restore the `completed` state.

### SOL-02: Restoration snapshot
- Capture the effective model identifier and thinking level immediately before workflow activation changes runtime settings.
- Persist the snapshot with the activation or dynamic-workflow creation entry so restoration remains possible after session replay.
- Store the model as its `provider/model` identifier and resolve it through the current model registry when restoration is applied.
- Keep model and thinking values independent. Restoration applies both values captured at activation.
- Keep the snapshot unchanged while the workflow is active. Manual model changes and later workflow stage changes do not rewrite it.

### SOL-03: Completion and restoration transaction
- Register one `agent_settled` handler in the workflow lifecycle registration.
- The handler must ignore settled runs when no workflow is active or when the active stage is not final.
- For a final stage, resolve the restoration model from the persisted snapshot and apply the snapshot's model and thinking level.
- Append the completion entry only after runtime restoration succeeds.
- Update in-memory workflow state to `completed` only after the completion entry is appended successfully.
- When completion persistence fails, restore the final-stage model and thinking level and keep the workflow `active`.
- When the restoration model cannot be resolved or applied, keep the workflow `active`, leave the final-stage runtime settings in place, and report the operation error.
- Repeated `agent_settled` events after completion must not append another completion entry or reapply settings.

### SOL-04: Completed workflow projection
- A completed workflow must not be projected as `<active_workflow>` in the next agent context.
- The workflow extension must not apply completed-workflow model settings during `session_start` or `session_tree`.
- Workflow tools must expose only the operations allowed by the completed state. The completed route remains available for rework transitions.
- A rework transition from a completed workflow changes the state back to `active`, applies the target stage settings, and persists the new route.
- After rework, the workflow context contains the target stage instructions and available transitions again.
- Existing workflow activation and replacement semantics remain unchanged. Completion only changes model restoration, context projection, and the availability of rework transitions.

### SOL-05: State replay and persistence contract
- Extend workflow state validation to accept the lifecycle state and restoration snapshot fields required by the new entries.
- Add a dedicated completion entry kind rather than mutating a previous session entry.
- Preserve the workflow definition and route in the replayed state so rework remains deterministic.
- Validate the restoration snapshot at the session boundary: the model identifier must use the shared model-settings contract and the thinking level must use the shared reasoning-level contract.
- Treat malformed completion or snapshot data as a workflow replay error and disable workflow capabilities for that invalid branch.

### SOL-06: Runtime model application boundaries
- Reuse `resolveWorkflowModelSettings` for activation and stage transitions.
- Add a separate restoration operation that applies the persisted pre-workflow snapshot without resolving workflow or agent precedence.
- Keep model validation, `setModel` failure handling, thinking-level validation, and rollback behavior consistent with `model-runtime.ts`.
- Do not add model or thinking parameters to workflow tools. The LLM continues to select only workflow and stage identifiers.

### SOL-07: Validation
- Add a lifecycle test for a final-stage run: `agent_settled` restores the snapshot, persists completion, and changes the state to `completed`.
- Add a non-final-stage test: `agent_settled` leaves the workflow state and runtime settings unchanged.
- Add an idempotency test: repeated settlement after completion performs no second restoration or persistence.
- Add a persistence-failure test: the final-stage settings and active state are restored when the completion entry cannot be appended.
- Add a restoration-failure test: an unavailable or rejected snapshot model leaves the workflow active and reports the error.
- Add a replay test: a completed entry restores completed state and does not apply final-stage settings during session synchronization.
- Add a rework test: a completed route can transition through an allowed rework edge and applies the target stage settings.
- Add a non-interactive test covering a subagent or a context without UI methods. Completion must not call TUI APIs.
- Run the existing workflow, model-runtime, type-check, lint, and full validation suites after implementation.

## Overengineering and Overspecification Considerations
- Completion is driven by the existing `agent_settled` lifecycle event and does not introduce a new classifier, model request, or user prompt.
- The solution keeps workflow tools unchanged and adds no user-facing model-selection controls.
- The restoration snapshot is persisted because runtime values cannot be reconstructed reliably after session replay once workflow settings have replaced them.
- Runtime application remains in the workflow extension; no general-purpose settings manager is introduced.
- The solution changes only workflow lifecycle state, persistence, runtime restoration, context projection, and their tests and documentation.

## Open Questions

No unresolved design questions remain for this solution.

## References
- REF-01: `pi-package/extensions/workflow/workflow.ts` - workflow definitions, route transitions, state replay, and persisted workflow entries.
- REF-02: `pi-package/extensions/workflow/index.ts` - workflow lifecycle registration, tools, state commits, and model synchronization.
- REF-03: `pi-package/extensions/workflow/model-runtime.ts` - workflow model resolution, application, validation, and rollback.
- REF-04: `pi-package/extensions/workflow/context.ts` - active workflow context projection.
- REF-05: `pi-package/extensions/workflow/availability.ts` - workflow tool availability and projected state.
- REF-06: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` - `agent_settled` lifecycle event and non-interactive extension API contracts.
- REF-07: `pi-package/shared/model-settings.ts` - shared model identifier and thinking-level contract.
