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

Each workflow requires:
- one initial stage and at least one final stage;
- a non-empty `prompt` for every stage; surrounding whitespace is removed when the catalog loads;
- an optional root `prompt` for guidelines that apply to every stage; surrounding whitespace is removed, and an omitted or empty result means that the workflow has no shared guidelines;
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
tools: [workflow_*]
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

The default Pi tool shell renders workflow references instead of displaying the internal success JSON. Collapsed mode removes display-only whitespace, wraps text to the available width, and shows at most four content rows per reference. Additional rows are replaced by Pi's standard expansion hint:

```text
workflow_activate
Workflow: delivery · Software delivery

workflow_transition
From: implementation · Implement the approved change
To: review · Review the implementation
```

Expanded mode shows every reference without collapsed-text normalization or line limits:

```text
workflow_activate
--- Workflow ---
delivery · Software delivery

workflow_transition
--- From ---
implementation · Implement the approved change
--- To ---
review · Review the implementation
```

A failed call keeps the semantic identity captured before execution and adds `Error: <message>`. Tool names and `Error:` use Pi's bright tool-title style. Collapsed references and expanded reference text use the standard tool-output style; section headings, expansion hints, and error messages use the muted style. Presentation evidence is stored in result `details`, so the active screen and subagent session screen render the same content in both modes. Model-visible success content remains `{"success":true}`.

Both tools run sequentially. They persist state in the Pi session tree only after all input and transition checks succeed.

The current main-agent or subagent policy must enable at least one workflow tool. Either `workflow_activate` or `workflow_transition` enables the complete workflow projection. The `workflows` policy must also allow at least one current catalog entry or the saved active snapshot. When either condition fails, the extension adds no workflow guidelines, activation options, active workflow, or other workflow data to that agent's provider context.

An active workflow projects shared workflow guidelines before the current stage guidelines:

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

The root workflow prompt is projected in `<guidelines>` for every active stage. The section is omitted when the prompt is absent or empty after trimming. Only the active stage prompt is projected in `<active_stage_guidelines>`; a transition replaces it with the target stage prompt on the next context request.

Activation options include only workflows allowed by `workflows`. A saved snapshot is projected and can transition only when the policy allows its ID. Both tools enforce this rule before appending session state or changing memory. Tool and workflow policies remain independent, and later main-agent policy changes apply to the next context request and tool call.

## Session snapshots

Activation stores the validated workflow definition with its route. Later transitions store only the updated route. The active branch reconstructs this state on session start and branch changes.

Snapshot recovery depends on the agent's `workflows` policy:
- When `workflows` is omitted, a valid saved snapshot remains available after its file is removed or the current catalog becomes invalid. An invalid catalog provides no activation options.
- With `workflows: []`, the snapshot remains persisted but is neither projected nor transitionable.
- A non-empty policy applies only when the current catalog is valid and still contains every listed ID. When the saved workflow ID remains present, changed file contents do not replace the validated definition stored in the snapshot. A removed ID or invalid catalog rejects fresh agent policy application instead of restoring through that explicit policy.

Without an allowed current catalog entry or an allowed valid snapshot, the extension adds no workflow context.
