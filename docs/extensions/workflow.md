# Workflow

The `workflow` extension gives the model a validated stage graph, one active stage, and only the transitions allowed by the completed route. Workflows can come from the YAML catalog or be created for the current Pi session.

## Configuration

Create ready-made `.yaml` files under:

```text
~/.pi/agent/agent-suite/workflow/workflows/
```

When `PI_AGENT_SUITE_DIR` is set, the extension uses `<PI_AGENT_SUITE_DIR>/workflow/workflows/` instead. The NFC-normalized file name without `.yaml` is the workflow ID. Workflow IDs may use any Unicode language, internal spaces, and punctuation. They must be non-empty, trimmed, and single-line.

```yaml
description: Use for software delivery
prompt: |
  Follow these guidelines throughout the workflow.
model:
  id: openai/gpt-5
  thinking: high
stages:
  - id: implementation
    description: Implement the approved change
    prompt: |
      Implement only the approved scope.
      Follow the project testing rules.
    initial: true
    triggers:
      - type: local_knowledge_accumulation
    model:
      thinking: xhigh
  - id: review
    description: Review the implementation
    prompt: Review the implementation and report evidence-backed findings
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
  - from: review
    to: implementation
    type: rework
```

Every catalog or dynamic workflow requires:
- one initial stage and at least one final stage;
- non-empty stage IDs without spaces, tabs, line breaks, or other Unicode whitespace;
- trimmed single-line workflow and stage descriptions;
- a non-empty `prompt` for every stage;
- an optional root `prompt` for guidance that applies to every stage;
- an optional ordered `triggers` list containing only closed trigger objects;
- supported trigger types `local_knowledge_accumulation` and `global_knowledge_accumulation`;
- optional root and stage `model` objects in catalog YAML;
- a required `model` object on every `workflow_create` stage with one required `thinking` field set to `low`, `medium`, or `high`;
- unique stage IDs and valid transition endpoints;
- an acyclic `advance` graph in which every stage is reachable;
- no outgoing `advance` from final stages;
- at least one outgoing `advance` from non-final stages;
- `rework` transitions only to strict `advance` ancestors.

Surrounding prompt whitespace is removed. An omitted or empty root prompt means that the workflow has no shared guidance.

Catalog YAML model settings use independently optional `id` and `thinking` fields. `id` accepts either `provider/model` or an alias from `model-aliases/config.json`. The effective values are resolved independently with stage settings taking priority over workflow settings, followed by the selected agent and the current Pi runtime value. When a level omits `thinking`, the alias default thinking of that level's model applies. When the selected agent is unavailable, such as in child subagent processes or sessions without a selected agent, the pre-workflow restoration snapshot supplies the model and thinking for stages that omit them at the stage, workflow, and agent levels. Unknown models and thinking levels unsupported by the resolved model fail before workflow state is persisted. Settings are applied during activation, stage transitions, and session synchronization. Manual model changes in Pi or main-agent changes are not automatically overwritten.

Workflow activation and dynamic creation persist the current runtime model identifier and thinking level as a restoration snapshot. When an agent run settles on a final stage, the extension restores that snapshot and marks the workflow completed. This lifecycle handling uses `agent_settled` and does not require TUI or user interaction, so it also applies to subagents, RPC sessions, and print mode.

Each invalid or unreadable `.yaml` file is excluded independently, while valid sibling workflows remain available. At session start, Pi shows one warning that lists every excluded file and its validation issue when UI notifications are available. Catalog IDs must be unique after NFC normalization and remain case-sensitive. An unreadable workflow directory or an NFC-equivalent catalog ID collision rejects the catalog. A missing or empty workflow directory is a valid empty catalog. The catalog is read when the extension loads.

### Agent workflow policy

Main-agent and subagent frontmatter can restrict ready-made workflow activation independently from `tools`:

```yaml
---
description: Delivery agent
type: main
tools: [workflow_*]
workflows: [delivery, review]
---
```

- Omit `workflows` to allow activation of every catalog workflow.
- Use `workflows: []` to allow no catalog workflow activation.
- Use a non-empty list to allow activation of only exact catalog IDs after NFC normalization. Runtime metadata uses the catalog's spelling.
- A resolved policy does not hide or block the current active workflow. Creation, activation, and transitions still require their respective tool permissions.

NFC-equivalent duplicates, unknown names, and NFC-equivalent catalog ID collisions reject the policy before the agent changes model or runtime state. A non-empty policy also fails when the catalog is invalid; omitted and empty policies remain valid.

For child Pi processes, the launcher transports the resolved catalog policy in `PI_SUBAGENT_WORKFLOW_IDS`. This variable is owned by the launcher and should not be configured manually.

## Prompt overrides

Optional prompt overrides belong in `~/.pi/agent/agent-suite/workflow/config.json`, or the corresponding `PI_AGENT_SUITE_DIR` path:

```json
{
  "extensionDescriptionPromptFile": "/absolute/path/extension-description.md",
  "createDescriptionPromptFile": "/absolute/path/create-description.md",
  "activateDescriptionPromptFile": "/absolute/path/activate-description.md",
  "getStageDescriptionPromptFile": "/absolute/path/get-stage-description.md",
  "editStageDescriptionPromptFile": "/absolute/path/edit-stage-description.md",
  "transitionDescriptionPromptFile": "/absolute/path/transition-description.md"
}
```

Each configured path must be absolute and reference a readable file with non-empty content after trimming. Unknown fields and invalid files reject the prompt configuration atomically.

`extensionDescriptionPromptFile` supplies universal active-workflow guidance. The other files replace the Pi tool description for the corresponding tool. Pi includes descriptions only for active tools, so tool-specific rules are not duplicated in `<workflow_guidelines>`.

## Tools

All workflow tools run sequentially. Mutating tools return model-visible success content `{"success":true}`. `workflow_get_stage` returns the requested stage as JSON.

After creation, activation, advance, or rework persists the entered stage, its triggers run sequentially in listed order. Duplicate triggers are preserved. A reported or thrown trigger failure stops the remaining stage triggers but does not change workflow success. Restoring an active stage during session start or branch reconstruction runs no triggers.

A final-stage agent run remains active until `agent_settled`. The settlement restores the pre-workflow model and thinking level, persists a `completed` snapshot, and removes final-stage instructions from provider context. A completed workflow remains available for allowed `rework` transitions; rework marks it active and applies the target stage settings.

### `workflow_create`

`workflow_create` accepts one complete, flat definition:

```json
{
  "id": "task-delivery",
  "description": "Task-specific delivery workflow",
  "prompt": "Follow the approved scope.",
  "stages": [
    {
      "id": "implementation",
      "description": "Implement the change",
      "prompt": "Implement and test the change.",
      "model": {
        "thinking": "medium"
      },
      "initial": true
    },
    {
      "id": "review",
      "description": "Review the result",
      "prompt": "Review the implementation.",
      "model": {
        "thinking": "high"
      },
      "final": true
    }
  ],
  "transitions": [
    {
      "from": "implementation",
      "to": "review",
      "type": "advance"
    }
  ]
}
```

A successful call validates the whole graph, stores one `created` snapshot, and immediately activates the initial stage. It replaces an active workflow with a different ID. A replaced dynamic workflow cannot be reactivated. The new ID must not match a catalog ID or the active dynamic ID after NFC normalization and exact case comparison. Reusing the active dynamic ID is rejected without resetting its route.

The `workflow_create` TypeBox schema adds LLM-facing length and collection-size budgets. YAML catalog definitions use the same structural text rules without those tool-specific budgets. `workflow_create` requires a closed `model` object on every stage. Every stage model requires `thinking`. The allowed values are `low`, `medium`, and `high`. Root model settings, `model.id`, and other thinking levels are rejected.

`workflow_create` remains available with a missing or empty catalog when the agent's `tools` policy permits it. A catalog error blocks creation because ID collisions cannot be checked against an incomplete namespace. Dynamic workflows are never written to YAML.

### `workflow_activate`

`workflow_activate` activates one ready-made workflow listed in `<workflow_activation_options>`. Activation replaces prior workflow state. Only the exact active workflow ID after NFC normalization is excluded from options. The tool is unavailable when policy filtering and that exclusion leave no activation options.

### `workflow_get_stage`

`workflow_get_stage` is available only while a workflow created through `workflow_create` is active. It accepts only `stageId` and reads that stage from the current workflow. It does not accept `workflowId` and cannot read catalog workflows.

The JSON result contains `id`, `description`, `prompt`, `model.thinking`, `initial`, and `final`. The tool rejects an unknown stage without changing workflow state.

### `workflow_edit_stage`

`workflow_edit_stage` has the same dynamic active-workflow availability rule. It requires one closed replacement object:

```json
{
  "stageId": "implementation",
  "description": "Implement the corrected change",
  "prompt": "Follow the corrected requirements.",
  "model": {
    "thinking": "high"
  }
}
```

The tool replaces only `description`, `prompt`, and `model.thinking`. It preserves `id`, `initial`, `final`, `triggers`, transitions, workflow fields, route, status, source, and restoration settings. All replacement fields are required. `model.thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The edit appends a `stage_edited` session entry. Editing the active stage applies its thinking level immediately and updates the prompt and description used by the next provider request. Editing another stage stores the new fields without changing current runtime thinking. A later transition applies that stage's edited thinking level. Editing does not enter the stage and does not run its triggers.

### `workflow_transition`

`workflow_transition` moves the active workflow to one target listed in `<available_transitions>`. Permission for `workflow_create` does not grant transition permission.

Every tool rechecks its input and current state before reading or appending session state. Creation and activation also recheck the policy information they require. A malformed policy blocks all workflow operations. Validation or persistence errors leave the previous workflow state unchanged.

## Compact session status panel

In interactive TUI mode, the active workflow saved in the current session publishes one row in the shared panel above Pi's editor:

```text
Workflow: TuiBrainstorming · Generate and discuss TUI concepts
```

The row contains the workflow ID and active stage description. It never includes stage IDs or transitions. The shared separator and the complete Workflow row use Pi's dim color. Repeated spaces and terminal layout whitespace, including tabs and line breaks, collapse to one space before display. A trailing `.` is removed. The row is clipped to the terminal width and ends with `…` when content is hidden.

A completed workflow is still retained for rework, but its provider context uses `<completed_workflow>` and omits `<active_stage_guidelines>` until rework makes the workflow active again.

Creation, activation, stage editing, transition, session start, and branch changes replace the row with the saved active state. Changing the selected agent or its workflow allowlist does not hide this row or the saved active workflow. The agent's tool policy still controls provider-context availability. A branch without saved active workflow state removes only the `Workflow` row; other shared panel rows remain visible.

## Tool presentation

The default Pi tool shell renders workflow references instead of displaying internal success JSON. Collapsed `workflow_create` output also identifies the configured `app.tools.expand` binding:

```text
workflow_create
Workflow: task-delivery · Task-specific delivery workflow
Stage: implementation · Implement the approved change
Content: ctrl+o to show

workflow_activate
Workflow: delivery · Software delivery

workflow_get_stage: implementation
Description: Implement the approved change
Prompt: Implement and test the change
Thinking: medium
Initial: true
... (1 more line, 5 total, ctrl+o to expand)

workflow_edit_stage: implementation
Description: Implement the approved change -> Implement the corrected change
Prompt: Implement and test the change -> Follow the corrected requirements.
Thinking: medium -> high

workflow_transition
From: implementation · Implement the approved change
To: review · Review the implementation
```

Expanded `workflow_create` output shows catalog-shaped YAML. The workflow ID remains in the `Workflow` section because catalog files derive it from the file name:

```text
workflow_create
--- Workflow ---
task-delivery · Task-specific delivery workflow
--- Stage ---
implementation · Implement the approved change
--- Content ---
description: Task-specific delivery workflow
stages:
  - id: implementation
    description: Implement the approved change
    prompt: Implement and test the change
    model:
      thinking: medium
    initial: true
  - id: review
    description: Review the result
    prompt: Review the implementation
    model:
      thinking: high
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
```

Each stage attribute starts a separate semantic row. Collapsed mode normalizes source line breaks inside each attribute to spaces, wraps its value to the available width, and shows at most four content rows before Pi's expansion hint. Expanded mode renders every displayed attribute as a `--- Name ---` section and preserves source line breaks. An expanded `workflow_edit_stage` section contains the old value, a separate `->` row, and the new value. The edit tool shows only changed attributes; an edit with equal values shows `No changes.`. Collapsed attribute labels use Pi's bold `toolTitle` color, values use `toolOutput`, expanded section headers use `muted`, and change arrows use `success`. A failed call keeps the identity captured before execution and adds `Error: <message>`. Workflow and stage presentation data is stored in result `details`. Expanded creation YAML is reconstructed from the stored tool-call arguments. These stored sources keep the active screen and subagent session screen consistent.

## Provider context

The extension computes tool availability independently:
- `workflow_create` requires a valid catalog, including a valid empty catalog;
- `workflow_activate` requires at least one allowed activation option;
- `workflow_get_stage` and `workflow_edit_stage` require an active dynamic workflow created through `workflow_create`;
- `workflow_transition` requires a projected active state or at least one allowed catalog workflow.

The agent's `tools` policy remains a second gate. The extension never restores a tool removed by that policy.

`<workflow_guidelines>` contains only universal workflow rules. Context is projected while at least one workflow tool is active. The current active workflow also remains projected when the extension temporarily suppresses the last workflow tool granted by the agent policy. A policy reset that removes that tool permission stops the projection without deleting the saved workflow snapshot. `<workflow_activation_options>` is included only when `workflow_activate` is active and at least one option exists. An empty or self-closing activation-options element is not emitted.

An active workflow projects shared workflow guidance before the current stage guidance:

```xml
<active_workflow id="delivery" active_stage_id="implementation">
  <guidelines>
Follow these guidelines throughout the workflow.
  </guidelines>
  <active_stage_guidelines>
Implement only the approved scope.
Follow the project testing rules.
  </active_stage_guidelines>
  ...
</active_workflow>
```

The root workflow prompt is projected in `<guidelines>` for every active stage and omitted when absent. Only the active stage prompt is projected in `<active_stage_guidelines>`; a transition replaces it on the next context request. A completed workflow uses `<completed_workflow completed_stage_id="...">` and projects no stage prompt.

Catalog activation options are filtered through `workflows`. The current active state remains projectable and transitionable under every resolved policy, regardless of whether it came from catalog activation or `workflow_create`.

## Session snapshots

Catalog activation stores an `activated` snapshot with the validated workflow definition, route, and pre-workflow restoration settings. Dynamic creation stores the same data in a `created` snapshot. Stage edits store the stage ID and normalized replacement fields. Later transitions store only the updated route and preserve the workflow source and restoration settings. Completion stores a `completed` snapshot with the final route. Stored workflow definitions preserve stage triggers, but replaying snapshots never executes them.

The active branch reconstructs state on session start and branch changes:
- `activated` restores catalog-backed active state and its restoration settings;
- `created` restores dynamic active state and its restoration settings;
- `stage_edited` replaces `description`, `prompt`, and `model.thinking` in the preceding active dynamic snapshot;
- `transitioned` updates the route of the preceding snapshot;
- `completed` restores completed state and the persisted pre-workflow runtime settings without applying final-stage settings.

When tree navigation leaves an active workflow, the extension reconstructs the target branch model from `model_change` entries or assistant messages and its thinking level from `thinking_level_change` entries. Target branch entries override the abandoned workflow restoration snapshot independently, so a branch that changes only model or only thinking retains that explicit value.

The latest valid active snapshot remains available under every resolved policy after its catalog file is removed or the catalog becomes invalid. An invalid catalog prevents new creation and activation but does not block transitions of that saved active workflow. Earlier replaced dynamic workflows do not appear in activation options and cannot be reactivated.

## CLI flags

The workflow extension registers no CLI flags. The `--trigger <type>` flag is owned by the `algorithms` extension and runs a registered algorithm at startup; see `docs/extensions/algorithms.md`.
