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
- an optional root `model` object and optional stage `model` objects in catalog YAML;
- unique stage IDs and valid transition endpoints;
- an acyclic `advance` graph in which every stage is reachable;
- no outgoing `advance` from final stages;
- at least one outgoing `advance` from non-final stages;
- `rework` transitions only to strict `advance` ancestors.

Surrounding prompt whitespace is removed. An omitted or empty root prompt means that the workflow has no shared guidance.

Catalog YAML model settings use independently optional `id` and `thinking` fields. `id` accepts either `provider/model` or an alias from `model-aliases/config.json`. The effective values are resolved independently with stage settings taking priority over workflow settings, followed by the selected agent and the current Pi runtime value. Unknown models and thinking levels unsupported by the resolved model fail before workflow state is persisted. Settings are applied during activation, stage transitions, and session synchronization. Manual model changes in Pi or main-agent changes are not automatically overwritten.

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
  "transitionDescriptionPromptFile": "/absolute/path/transition-description.md"
}
```

Each configured path must be absolute and reference a readable file with non-empty content after trimming. Unknown fields and invalid files reject the prompt configuration atomically.

`extensionDescriptionPromptFile` supplies universal active-workflow guidance. The other files replace the Pi tool description for the corresponding tool. Pi includes descriptions only for active tools, so tool-specific rules are not duplicated in `<workflow_guidelines>`.

## Tools

All workflow tools run sequentially and return model-visible success content `{"success":true}`.

After creation, activation, advance, or rework persists the entered stage, its triggers run sequentially in listed order. Duplicate triggers are preserved. A reported or thrown trigger failure stops the remaining stage triggers but does not change workflow success. Restoring an active stage during session start or branch reconstruction runs no triggers.

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
      "initial": true
    },
    {
      "id": "review",
      "description": "Review the result",
      "prompt": "Review the implementation.",
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

The `workflow_create` TypeBox schema adds LLM-facing length and collection-size budgets. YAML catalog definitions use the same structural text rules without those tool-specific budgets. The `workflow_create` schema remains unchanged and does not expose model settings; model settings are available only in catalog YAML.

`workflow_create` remains available with a missing or empty catalog when the agent's `tools` policy permits it. A catalog error blocks creation because ID collisions cannot be checked against an incomplete namespace. Dynamic workflows are never written to YAML.

### `workflow_activate`

`workflow_activate` activates one ready-made workflow listed in `<workflow_activation_options>`. Activation replaces prior workflow state. Only the exact active workflow ID after NFC normalization is excluded from options. The tool is unavailable when policy filtering and that exclusion leave no activation options.

### `workflow_transition`

`workflow_transition` moves the active workflow to one target listed in `<available_transitions>`. Permission for `workflow_create` does not grant transition permission.

Every tool rechecks its input and current state before appending a session entry. Creation and activation also recheck the policy information they require. A malformed policy blocks all workflow operations. Validation or persistence errors leave the previous workflow state unchanged.

## Compact session status panel

In interactive TUI mode, the active workflow saved in the current session publishes one row in the shared panel above Pi's editor:

```text
Workflow: TuiBrainstorming · Generate and discuss TUI concepts
```

The row contains the workflow ID and active stage description. It never includes stage IDs or transitions. The shared separator and the complete Workflow row use Pi's dim color. Repeated spaces and terminal layout whitespace, including tabs and line breaks, collapse to one space before display. A trailing `.` is removed. The row is clipped to the terminal width and ends with `…` when content is hidden.

Creation, activation, transition, session start, and branch changes replace the row with the saved active state. Changing the selected agent or its workflow allowlist does not hide this row or the saved active workflow. The agent's tool policy still controls provider-context availability. A branch without saved active workflow state removes only the `Workflow` row; other shared panel rows remain visible.

## Tool presentation

The default Pi tool shell renders workflow references instead of displaying internal success JSON. Collapsed `workflow_create` output also identifies the configured `app.tools.expand` binding:

```text
workflow_create
Workflow: task-delivery · Task-specific delivery workflow
Stage: implementation · Implement the approved change
Content: ctrl+o to show

workflow_activate
Workflow: delivery · Software delivery

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
    initial: true
  - id: review
    description: Review the result
    prompt: Review the implementation
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
```

Collapsed mode wraps references to the available width and shows at most four content rows per reference. Expanded mode shows complete references and creation YAML. A failed call keeps the identity captured before execution and adds `Error: <message>`. Workflow and stage references are stored in result `details`. Expanded creation YAML is reconstructed from the stored tool-call arguments. These two stored sources keep the active screen and subagent session screen consistent.

## Provider context

The extension computes tool availability independently:
- `workflow_create` requires a valid catalog, including a valid empty catalog;
- `workflow_activate` requires at least one allowed activation option;
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

The root workflow prompt is projected in `<guidelines>` for every active stage and omitted when absent. Only the active stage prompt is projected in `<active_stage_guidelines>`; a transition replaces it on the next context request.

Catalog activation options are filtered through `workflows`. The current active state remains projectable and transitionable under every resolved policy, regardless of whether it came from catalog activation or `workflow_create`.

## Session snapshots

Catalog activation stores an `activated` snapshot with the validated workflow definition and route. Dynamic creation stores the same data in a `created` snapshot. Later transitions store only the updated route and preserve the workflow source. Stored workflow definitions preserve stage triggers, but replaying snapshots never executes them.

The active branch reconstructs state on session start and branch changes:
- `activated` restores catalog-backed state;
- `created` restores dynamic state;
- `transitioned` updates the route of the preceding snapshot.

The latest valid active snapshot remains available under every resolved policy after its catalog file is removed or the catalog becomes invalid. An invalid catalog prevents new creation and activation but does not block transitions of that saved active workflow. Earlier replaced dynamic workflows do not appear in activation options and cannot be reactivated.

## CLI flags

| Flag | Type | Description |
| --- | --- | --- |
| `--trigger <type>` | String | Runs a workflow trigger at startup, then exits. The trigger type must match a value used in workflow YAML stage definitions. |

Available trigger types: `local_knowledge_accumulation`, `global_knowledge_accumulation`. When `--trigger` is set, the extension invokes the registered trigger runner at session start. After execution (success or failure), the session shuts down. An unknown trigger type or a missing trigger runner (for example, when the knowledge extension is disabled) produces an error on stderr and exits. The flag is ignored in child agent processes.
