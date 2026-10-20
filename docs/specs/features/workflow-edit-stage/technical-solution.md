# Technical Solution: Dynamic Workflow Stage Editing

## Problem Statement
- PRB-01: A workflow created through `workflow_create` cannot repair incorrect stage instructions without replacing the complete workflow and losing its saved route.
- PRB-02: A stage edit must survive session replay and affect the next provider request without changing workflow identity, graph structure, or progress.

## Proposed Solution

### SOL-01: Tool availability
- Register `workflow_get_stage` and `workflow_edit_stage` as sequential workflow tools.
- Expose both tools only when the saved workflow has `source === "dynamic"` and `status === "active"`.
- Keep agent tool policy, workflow policy, prompt loading, and runtime availability checks as additional gates.
- Do not accept `workflowId`. Both tools operate on the current active dynamic workflow.

### SOL-02: Stage read contract
- `workflow_get_stage` accepts only `stageId`.
- Return `id`, `description`, `prompt`, `model.thinking`, `initial`, and `final` as JSON. Include `goal` for format 2 and omit it for restored format-1 dynamic workflows.
- Reject an unknown stage without changing workflow state.

### SOL-03: Stage edit contract
- `workflow_edit_stage` requires `stageId`, `description`, `prompt`, and `model.thinking` in one closed object.
- Replace `description`, `prompt`, and `model.thinking`. For format 2, also require and replace `goal`. Reject a missing goal, an empty goal after trimming, or an invalid goal before changing state.
- For restored format-1 dynamic workflows, reject a supplied `goal` with an error stating that a stage goal requires format version 2.
- Use the central domain format rules for goal validation. Keep `goal` optional in the shared tool schema to serve both formats.
- Preserve `id`, `initial`, `final`, `triggers`, transitions, workflow fields, route, status, source, and restoration settings.
- Reject stage deletion, partial edits, unknown fields, unknown stages, catalog workflows, and completed workflows.

### SOL-04: Runtime and session state
- Append a `stage_edited` workflow-state entry containing the normalized replacement fields. For format 2, trim surrounding goal whitespace before saving. For format 1, omit the goal key.
- During replay, forward `goal` to the shared stage-edit validator only when the saved entry contains the key. Restore the normalized replacement goal for format 2 and keep format-1 entries goal-free.
- Replay `stage_edited` entries against the preceding `created` snapshot and reject entries without an active dynamic snapshot.
- Apply an edited active stage's thinking level before persistence and roll it back when persistence fails.
- Persist a non-active stage edit without changing the current stage's runtime thinking. Apply that thinking level when a later transition enters the edited stage.
- After persistence succeeds, publish `<workflow_stage_updated>` for the edited stage with its replacement description and complete prompt. When the stage has a goal, place `<stage_goal>` before `<stage_guidelines>` inside `<stage_definition>`. Mark active-stage edits with `active="true"` and inactive-stage edits with `active="false"`. The next provider request receives this update.
- If validation or persistence fails, preserve workflow state and publish no stage update.
- Do not run stage-entry triggers because editing does not enter a stage.

### SOL-05: Tool presentation and prompts
- Render stage references and YAML content through the existing workflow presentation path in compact and expanded modes.
- Persist the old and replacement stage content in presentation details so the main screen and subagent session screen render the same changes.
- Place goal changes between description and prompt changes: use a `Goal:` row in compact mode and a `--- Goal ---` section in expanded mode. If only the goal changes, show only that change.
- Trim surrounding whitespace from the replacement goal before comparison. If the normalized replacement equals the saved goal, omit the goal change row. If all editable values compare equal, show `No changes.`.
- Read saved presentation evidence inside the deferred row callback so the first replay render matches the live call.
- Tell the model in the `workflow_edit_stage` description to inspect incorrect stage fields with `workflow_get_stage` and edit in place instead of replacing the workflow.

### SOL-06: Validation
- Cover tool schemas, availability, active and non-active edits, catalog rejection, completed workflow rejection, runtime application, rollback, session replay, provider context, and TUI presentation.
- Run workflow tests, package behavior tests, strict type checks, formatting checks, and extension loading checks.

## Overengineering and Overspecification Considerations
- The graph, route, triggers, workflow identity, and catalog files remain outside the edit contract.
- One replay event stores only editable fields instead of another complete workflow snapshot.
- The implementation reuses workflow availability, model application, session replay, prompt loading, and TUI rendering code.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/workflow/index.ts` - tool registration, availability checks, runtime application, and persistence.
- REF-02: `pi-package/extensions/workflow/workflow.ts` - immutable stage replacement and session replay.
- REF-03: `pi-package/extensions/workflow/tool-rendering.ts` - compact and expanded stage presentation.
- REF-04: `docs/extensions/workflow.md` - user-facing workflow extension behavior.
