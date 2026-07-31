# Workflow

The `workflow` extension gives the model a validated stage graph, one active stage, and only the transitions allowed by the completed route.

## Configuration

Create `.yaml` files under:

```text
~/.pi/agent/agent-suite/workflow/workflows/
```

When `PI_AGENT_SUITE_DIR` is set, the extension uses `<PI_AGENT_SUITE_DIR>/workflow/workflows/` instead. The file name without `.yaml` is the workflow ID.

```yaml
description: Use for software delivery
stages:
  - id: implementation
    description: Implement the approved change
    initial: true
  - id: review
    description: Review the implementation
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
  - from: review
    to: implementation
    type: rework
```

Each workflow requires:
- one initial stage and at least one final stage;
- unique stage IDs and valid transition endpoints;
- an acyclic `advance` graph in which every stage is reachable;
- no outgoing `advance` from final stages;
- at least one outgoing `advance` from non-final stages;
- `rework` transitions only to strict `advance` ancestors.

One invalid `.yaml` file rejects the current catalog. Workflow IDs must also be unique case-insensitively. The catalog is read when the extension loads.

### Agent workflow policy

Main-agent and subagent frontmatter can restrict workflow access independently from `tools`:

```yaml
---
description: Delivery agent
type: main
tools: [workflow_activate, workflow_transition]
workflows: [delivery, review]
---
```

- Omit `workflows` to allow every current workflow and any valid saved snapshot.
- Use `workflows: []` to deny every workflow.
- Use a non-empty list to allow only those workflow IDs. Names resolve case-insensitively and require a valid current catalog that still contains each ID; runtime metadata uses the catalog's exact IDs.

Duplicate names, unknown names, and case-insensitive catalog ID collisions reject the policy before the agent changes model or runtime state. A non-empty policy also fails when the current catalog is invalid; omitted and empty policies remain valid.

For child Pi processes, the launcher transports the resolved policy in `PI_SUBAGENT_WORKFLOW_IDS`. This variable is owned by the launcher and should not be configured manually.

## Prompt overrides

Optional prompt overrides belong in `~/.pi/agent/agent-suite/workflow/config.json`, or the corresponding `PI_AGENT_SUITE_DIR` path:

```json
{
  "extensionDescriptionPromptFile": "/absolute/path/extension-description.md",
  "activateDescriptionPromptFile": "/absolute/path/activate-description.md",
  "transitionDescriptionPromptFile": "/absolute/path/transition-description.md"
}
```

Each configured path must be absolute and reference a readable, non-empty file. Unknown fields and invalid files reject the prompt configuration.

## Tools

- `workflow_activate` activates one workflow listed in `workflow_activation_options`. Activation replaces prior workflow state.
- `workflow_transition` moves the active workflow to one target listed in `available_transitions`.

Both tools run sequentially. They persist state in the Pi session tree only after all input and transition checks succeed.

The current main-agent or subagent policy must enable at least one workflow tool. Either `workflow_activate` or `workflow_transition` enables the complete workflow projection. The `workflows` policy must also allow at least one current catalog entry or the saved active snapshot. When either condition fails, the extension adds no workflow guidelines, activation options, active workflow, or other workflow data to that agent's provider context.

Activation options include only workflows allowed by `workflows`. A saved snapshot is projected and can transition only when the policy allows its ID. Both tools enforce this rule before appending session state or changing memory. Tool and workflow policies remain independent, and later main-agent policy changes apply to the next context request and tool call.

## Session snapshots

Activation stores the validated workflow definition with its route. Later transitions store only the updated route. The active branch reconstructs this state on session start and branch changes.

Snapshot recovery depends on the agent's `workflows` policy:
- When `workflows` is omitted, a valid saved snapshot remains available after its file is removed or the current catalog becomes invalid. An invalid catalog provides no activation options.
- With `workflows: []`, the snapshot remains persisted but is neither projected nor transitionable.
- A non-empty policy applies only when the current catalog is valid and still contains every listed ID. When the saved workflow ID remains present, changed file contents do not replace the validated definition stored in the snapshot. A removed ID or invalid catalog rejects fresh agent policy application instead of restoring through that explicit policy.

Without an allowed current catalog entry or an allowed valid snapshot, the extension adds no workflow context.
