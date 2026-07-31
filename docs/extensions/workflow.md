# Workflow

The `workflow` extension gives the model a validated stage graph, one active stage, and only the transitions allowed by the completed route. Workflows can come from the YAML catalog or be created for the current Pi session.

## Configuration

Create ready-made `.yaml` files under:

```text
~/.pi/agent/agent-suite/workflow/workflows/
```

When `PI_AGENT_SUITE_DIR` is set, the extension uses `<PI_AGENT_SUITE_DIR>/workflow/workflows/` instead. The file name without `.yaml` is the workflow ID.

```yaml
description: Use for software delivery
prompt: |
  Follow these guidelines throughout the workflow.
stages:
  - id: implementation
    description: Implement the approved change
    prompt: |
      Implement only the approved scope.
      Follow the project testing rules.
    initial: true
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
- a non-empty `prompt` for every stage;
- an optional root `prompt` for guidance that applies to every stage;
- unique stage IDs and valid transition endpoints;
- an acyclic `advance` graph in which every stage is reachable;
- no outgoing `advance` from final stages;
- at least one outgoing `advance` from non-final stages;
- `rework` transitions only to strict `advance` ancestors.

Surrounding prompt whitespace is removed. An omitted or empty root prompt means that the workflow has no shared guidance.

One invalid `.yaml` file rejects the catalog atomically. Catalog IDs must be unique case-insensitively. A missing or empty workflow directory is a valid empty catalog. The catalog is read when the extension loads.

### Agent workflow policy

Main-agent and subagent frontmatter can restrict ready-made workflows independently from `tools`:

```yaml
---
description: Delivery agent
type: main
tools: [workflow_*]
workflows: [delivery, review]
---
```

- Omit `workflows` to allow every catalog workflow.
- Use `workflows: []` to deny every catalog workflow.
- Use a non-empty list to allow only those catalog IDs. Names resolve case-insensitively and runtime metadata uses the catalog's exact IDs.
- Dynamic workflow state is not filtered by `workflows`. Creation and transitions still require their respective tool permissions.

Duplicate names, unknown names, and case-insensitive catalog ID collisions reject the policy before the agent changes model or runtime state. A non-empty policy also fails when the catalog is invalid; omitted and empty policies remain valid.

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

A successful call validates the whole graph, stores one `created` snapshot, and immediately activates the initial stage. It replaces an active workflow with a different ID. The new ID must not match a catalog ID or the active dynamic ID case-insensitively. Reusing the active dynamic ID is rejected without resetting its route.

`workflow_create` remains available with a missing or empty catalog when the agent's `tools` policy permits it. A catalog error blocks creation because ID collisions cannot be checked against an incomplete namespace. Dynamic workflows are never written to YAML.

### `workflow_activate`

`workflow_activate` activates one ready-made workflow listed in `<workflow_activation_options>`. Activation replaces prior workflow state. The active workflow is excluded from options case-insensitively. The tool is unavailable when policy filtering and that exclusion leave no activation options.

### `workflow_transition`

`workflow_transition` moves the active workflow to one target listed in `<available_transitions>`. Permission for `workflow_create` does not grant transition permission.

Every tool rechecks its input, policy, and current state before appending a session entry. Validation or persistence errors leave the previous workflow state unchanged.

## Tool presentation

The default Pi tool shell renders workflow references instead of displaying internal success JSON:

```text
workflow_create
Workflow: task-delivery · Task-specific delivery workflow

workflow_activate
Workflow: delivery · Software delivery

workflow_transition
From: implementation · Implement the approved change
To: review · Review the implementation
```

Collapsed mode wraps references to the available width and shows at most four content rows per reference. Expanded mode shows the complete references. A failed call keeps the identity captured before execution and adds `Error: <message>`. Presentation evidence is stored in result `details`, so the active screen and subagent session screen render the same content.

## Provider context

The extension computes tool availability independently:
- `workflow_create` requires a valid catalog, including a valid empty catalog;
- `workflow_activate` requires at least one allowed activation option;
- `workflow_transition` requires a projected active state or at least one allowed catalog workflow.

The agent's `tools` policy remains a second gate. The extension never restores a tool removed by that policy.

`<workflow_guidelines>` contains only universal workflow rules. Context is projected while at least one workflow tool is active. An allowed active workflow also remains projected when the extension temporarily suppresses the last workflow tool granted by the agent policy. A policy reset that removes that tool permission stops the projection without deleting the saved workflow snapshot. `<workflow_activation_options>` is included only when `workflow_activate` is active and at least one option exists. An empty or self-closing activation-options element is not emitted.

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

Catalog activation options and catalog-backed active state are filtered through `workflows`. Dynamic active state remains projectable and transitionable independently from that catalog allowlist.

## Session snapshots

Catalog activation stores an `activated` snapshot with the validated workflow definition and route. Dynamic creation stores the same data in a `created` snapshot. Later transitions store only the updated route and preserve the workflow source.

The active branch reconstructs state on session start and branch changes:
- `activated` restores catalog-backed state;
- `created` restores dynamic state;
- `transitioned` updates the route of the preceding snapshot.

A valid catalog-backed snapshot remains available after its file is removed or the catalog becomes invalid when `workflows` permits its ID. A dynamic snapshot remains available regardless of `workflows`. An invalid catalog prevents new creation and activation but does not erase a valid dynamic snapshot or block its permitted transitions.
