# Workflow

The `workflow` extension gives the model a validated stage graph, one active stage, and only the transitions allowed by the completed route. Workflows can come from the YAML catalog or be created for the current Pi session.

## Configuration

Create ready-made `.yaml` files under:

```text
~/.pi/agent/agent-suite/workflow/workflows/
```

When `PI_AGENT_SUITE_DIR` is set, the extension uses `<PI_AGENT_SUITE_DIR>/workflow/workflows/` instead. The NFC-normalized file name without `.yaml` is the workflow ID. Workflow IDs may use any Unicode language, internal spaces, and punctuation. They must be non-empty, trimmed, and single-line.

### Format 3

Use format version 3 for new workflows. Declare `version: 3` in catalog files. `workflow_create` always creates format-3 workflows without a caller-supplied version selector. Formats 1 and 2 retain their schemas and always replace the running chain. Existing unversioned files follow the [legacy format-1 rules](#legacy-compatibility-format-1).

Format 3 adds optional `nested`, a boolean that defaults to false. With `nested: true`, a start appends the workflow to the running chain. Each parent waits at its current stage, and only the top accepts transitions, inspection, or edits. An ordinary exit of the top resumes its parent in the same agent run without running stage-entry triggers. A nested workflow can start without a parent. Without the flag, a start replaces the entire chain. An ID already anywhere in the chain is rejected before state or model changes. Workflow IDs use NFC-normalized, case-sensitive identity.

Before the first start, `<workflow_activation_options>` marks nested entries with `nested="true"`. The default shared guidance explains nested return and ordinary replacement. The `workflow_exit` description and a hint on entry into a final stage explain explicit exit. Agent workflow allowlists apply to nested catalog activation too.

### Transition-bound workflows

A format-3 transition can name a catalog workflow in `workflow`. The named workflow must declare `nested: true`. Both `advance` and `rework` transitions support this binding, in catalog definitions and `workflow_create`:

```yaml
- from: implementation
  to: review
  type: advance
  workflow: stage-check
```

When the agent requests this transition, the extension validates the target, basis, and ground before starting `stage-check`. The parent stays on `implementation` while the check becomes the top workflow. The check owns a pending transition until it exits. Agent workflow policy does not apply to the check, because the author of the running workflow bound it; the check's ID must be absent from the whole running chain. `<available_transitions>` names the check in attribute `workflow` of the transition, for example `<transition to="review" type="advance" workflow="stage-check" />`, and the default `workflow_transition` description explains that such a transition starts the named workflow first. A rejected start leaves the route, models, journal, and context unchanged and reports the reason.

At any stage of the check, `workflow_exit` requires boolean `allow`. With `{"basis":"The stage is ready","allow":true}`, exit removes the check and enters `review` in the same call, applying only the target stage's effective settings and running its entry triggers. With `allow: false`, exit resumes `implementation` without entry triggers and reports that the transition did not happen. Requesting the same transition again starts a new check. Missing or non-boolean permission rejects the pending exit. For ordinary workflows, exit ignores a supplied boolean `allow`.

The catalog loader validates bindings after validating individual files. For each declared binding, the catalog loader skips the workflow and emits a warning if the named catalog workflow is absent or does not declare `nested: true`. It also skips workflows that bind a skipped workflow, until no invalid bindings remain. Valid siblings remain available. `workflow_create` checks bindings against the loaded catalog before changing state. Formats 1 and 2 reject transition `workflow` fields. Mutually bound nested definitions can load; the runtime rejects an attempt to start an ID already running.

A check can start further nested workflows, including bound checks. An ordinary nested return preserves the pending transition of the waiting check. Starting a non-nested replacement drops the old chain and all its pending transitions. Reload, branch navigation, compaction, and child-status projection preserve the pending requests and resolve permitted exits consistently.

### Workflow kinds

Authors can define kinds separately in `<suite root>/workflow/kinds.yaml`. The suite root is `PI_AGENT_SUITE_DIR`, or `~/.pi/agent/agent-suite` by default. The file is an ordered YAML sequence:

```yaml
- id: task
  description: Processes for a whole task
- id: review
  description: Processes that check work
```

Each entry contains only `id` and `description`. Both are non-empty, trimmed, single-line strings. Kind IDs are NFC-normalized, unique, and case-sensitive. A missing file defines no kinds; `[]` defines an empty catalog. An unreadable or invalid kinds file rejects the catalog.

A format-3 catalog workflow or `workflow_create` argument can name a kind with `kind: task`. The loader skips a workflow with an unknown kind and warns without excluding valid siblings. Dynamic creation rejects an unknown kind before state, model, or persistence changes. Formats 1 and 2 reject the `kind` field. Saved workflow snapshots retain their kind after kinds are edited or removed.

Activation options contain only allowed workflows whose IDs are absent from the running chain. The renderer groups classified options in kinds-file order, with each kind's description, and places unclassified options in a separate group. Empty groups are omitted. Without a kinds file, unclassified options use the previous flat presentation. Kind affects presentation only; it changes no nesting, replacement, policy, transition, model, replay, restoration, or tool-availability rule. Shared streamed-create YAML includes kind on main and subagent screens in compact and expanded modes.

The following format-3 example uses the `task` kind defined above:

```yaml
version: 3
kind: task
description: Use for software delivery
prompt: |
  Follow these guidelines throughout the workflow.
model:
  id: openai/gpt-5
  thinking: high
stages:
  - id: implementation
    description: Implement the approved change
    goal: The implementation passes the required checks
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
    goal: The reviewer has approved the implementation
    prompt: Review the implementation and report evidence-backed findings
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
  - from: review
    to: implementation
    type: rework
    grounds:
      - id: evidence_missing
        when: The reviewer identifies missing implementation evidence
```

Each stage requires a non-empty string in `goal`: the stage goal, or state that must hold when the stage is complete. Put the actions for reaching that state in `prompt`. A transition can declare a `grounds` list. Each transition ground contains only a technical `id` and a non-empty string in `when` that describes its condition. Ground IDs follow the stage-ID rules and must be unique within their transition. Different transitions can reuse an ID.

Each `rework` transition requires at least one ground. If a stage has multiple outgoing `advance` transitions, each requires at least one ground. If a stage has only one outgoing `advance` transition, that transition can omit `grounds` or use an empty list; the transition is then unconditional.

The catalog loader accepts only versions 1, 2, and 3. The loader rejects root `nested` and `kind`, and transition `workflow`, in formats 1 and 2. For any other version value, it rejects the file with an error naming the value.

For goal and condition text, the validator removes surrounding whitespace and preserves internal line structure, as it does for stage prompts. When a goal is invalid, the validator names the stage in the error. When required grounds are missing or grounds are invalid, the validator names the source and target stages. The validator applies shared graph rules to all formats.

On activation of a format-2 or format-3 workflow, the extension publishes the initial stage goal in a separate `<stage_goal>` element before `<stage_guidelines>` in the initial `<workflow_stage_activated>` record. When a transition has grounds, the extension includes `<ground id="...">condition</ground>` elements inside that transition in `<available_transitions>`. For transitions with no grounds, the extension uses self-closing `<transition ... />` elements. In the complete graph in `<workflow_activated>`, the extension lists transition endpoints and types only.

See [`workflow_transition`](#workflow_transition) for ground selection and validation.

Additional validation rules for catalog definitions and newly created workflows:
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

At runtime, an `advance` transition appends its target to the recorded route. A `rework` transition is available only when its target is already in that route. Being a strict `advance` ancestor satisfies graph validation but does not make an unvisited stage available for `rework`. If an alternative `advance` path skipped the target stage, the workflow must first return to a visited stage and then enter the skipped stage through `advance`. A successful `rework` truncates the recorded route after its target stage.

Surrounding prompt whitespace is removed. An omitted or empty root prompt means that the workflow has no shared guidance.

Catalog YAML model settings use independently optional `id` and `thinking` fields. `id` accepts either `provider/model` or an alias from `model-aliases/config.json`. The effective values are resolved independently with stage settings taking priority over workflow settings, followed by the selected agent and the current Pi runtime value. When a level omits `thinking`, the alias default thinking of that level's model applies. When the selected agent is unavailable, such as in child subagent processes or sessions without a selected agent, the pre-workflow restoration snapshot supplies the model and thinking for stages that omit them at the stage, workflow, and agent levels. Unknown models and thinking levels unsupported by the resolved model fail before workflow state is persisted. Settings are applied during activation, stage transitions, and session synchronization. Manual model changes in Pi or main-agent changes are not automatically overwritten.

Workflow activation and dynamic creation persist the pre-workflow model identifier and thinking level as a restoration snapshot. A nested start captures the current runtime model and thinking without changing any parent's snapshot. A nested exit reapplies its parent's effective current-stage settings. The last exit restores the root snapshot. A replacement first restores the root snapshot of the entire chain, then captures the new snapshot and applies the new initial-stage settings. For example, if workflow B replaced original model A with model B, starting a replacement without model settings returns to A and saves A for its exit. Model changes and workflow persistence form one transaction: a persistence failure restores the previous runtime settings and leaves the workflow unchanged. These rules apply in main agents, subagents, RPC sessions, and print mode.

A string anywhere in a catalog workflow can hold a file reference `{{path}}`. The extension replaces each reference with the text of the file without surrounding whitespace when it reads the catalog. A relative path starts from the workflow directory. For example, `prompt: "Shared rules:\n{{rules/review.md}}"` with file `workflows/rules/review.md` that holds `1. A criterion without facts is unmet.` gives the shared guidance `Shared rules:` followed by this rule on the next line. YAML reads a plain value that starts with `{` as a mapping, so quote such a value or write it as a block scalar. A reference inside a referenced file stays as text. A workflow that references a missing or unreadable file is invalid. Workflows that `workflow_create` makes get no substitution.

Each invalid or unreadable `.yaml` file is excluded independently, while valid sibling workflows remain available. At session start, Pi shows one warning that lists every excluded file and its validation issue when UI notifications are available. Catalog IDs must be unique after NFC normalization and remain case-sensitive. An unreadable workflow directory or an NFC-equivalent catalog ID collision rejects the catalog. A missing or empty workflow directory is a valid empty catalog. The catalog is read when the extension loads.

### Legacy compatibility: format 1

Format 1 remains supported for existing catalog files and saved sessions. When `version` is omitted, the loader selects format 1. Declaring `version: 1` produces the same normalized definition and model-facing records as omitting the version.

Format 1 has stage prompts and transitions without separate stage goals or declared grounds. The validator rejects `goal` and `grounds` fields and explains that they require format 2. Calls to `workflow_transition` for a format-1 workflow supply the target stage ID and a nonempty free-text `basis`.

Saved format-1 dynamic workflows remain readable and editable. Their `workflow_get_stage` results omit `goal`, and `workflow_edit_stage` requires a replacement without `goal`. New dynamic workflows use format 3.

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
- A resolved policy does not hide or block the current active workflow. Each workflow tool still requires its own tool permission.
- A policy does not limit a workflow that a bound transition starts, so a check that only transitions start can stay out of the list and out of activation options.

If your main-agent or subagent `tools` allowlist explicitly names only the older workflow tools, add `workflow_exit` so the agent can leave a workflow or resume its parent. A `workflow_*` pattern already includes it. The extension does not grant tools excluded by the agent's policy.

NFC-equivalent duplicates, unknown names, and NFC-equivalent catalog ID collisions reject the policy before the agent changes model or runtime state. A non-empty policy also fails when the catalog is invalid; omitted and empty policies remain valid.

For child Pi processes, the launcher transports the resolved catalog policy in `PI_SUBAGENT_WORKFLOW_IDS`. This variable is owned by the launcher and should not be configured manually.

## Workflow configuration

Workflow settings and optional prompt overrides belong in `~/.pi/agent/agent-suite/workflow/config.json`, or the corresponding `PI_AGENT_SUITE_DIR` path:

```json
{
  "reminderToolCallInterval": 50,
  "extensionDescriptionPromptFile": "/absolute/path/extension-description.md",
  "createDescriptionPromptFile": "/absolute/path/create-description.md",
  "activateDescriptionPromptFile": "/absolute/path/activate-description.md",
  "getStageDescriptionPromptFile": "/absolute/path/get-stage-description.md",
  "editStageDescriptionPromptFile": "/absolute/path/edit-stage-description.md",
  "transitionDescriptionPromptFile": "/absolute/path/transition-description.md",
  "exitDescriptionPromptFile": "/absolute/path/exit-description.md"
}
```

`reminderToolCallInterval` defaults to `50` and measures the activity units defined below. It accepts safe integers greater than or equal to `0`. A value of `0` disables periodic reminders. Each configured prompt path must be absolute or home-prefixed and reference a readable file with non-empty content after trimming. Home-prefixed paths accept `~`, `$HOME`, or `${HOME}`, either alone or followed by `/...`. Other environment variables are not expanded. Unknown fields, invalid intervals, and invalid files reject the complete workflow configuration atomically.

`extensionDescriptionPromptFile` supplies one `promptGuidelines` contribution on each workflow tool. The system prompt formatter normalizes duplicate contributions, so the guidance appears once while any workflow tool is active. The other files replace the Pi tool description for the corresponding tool.

With the default shared guidance, the agent completes a stage only when its goal state holds and each completion condition that its stage guidelines state holds. The default transition description tells the agent to take `advance` only after each check that the stage guidelines require before leaving the stage allows the move, and to run no such check on `rework`. When every available transition has grounds and none of their conditions holds, the agent takes no transition and describes the situation in its reply. Transitions without grounds remain unconditional.

If you set `extensionDescriptionPromptFile`, the extension uses your file in place of the entire default shared guidance. Include the goal, task, stage-completion, active-stage, nested-return, and ordinary-replacement guidance in your file. Update overrides that describe automatic completion or forbid nested starts before a final stage. A transition or exit description override replaces only the description of that tool. The description of parameter `allow` explains the exit of a bound check, and the hint on entry into a final stage tells the agent to call `workflow_exit`.

## Tools

All workflow tools run sequentially. Mutating tools return model-visible success content `{"success":true}`. `workflow_get_stage` returns the requested stage as JSON.

After creation, activation, advance, or rework persists the entered stage, its triggers run sequentially in listed order. Duplicate triggers are preserved. A reported or thrown trigger failure stops the remaining stage triggers but does not change workflow success. Restoring an active stage during session start or branch reconstruction runs no triggers. Returning to an unchanged waiting parent also runs no triggers. A bound exit with `allow: true` enters the pending target and runs that target's triggers.

A final stage stays active after `agent_settled`, regardless of the run's outcome. Its model settings, instructions, reminders, and route-dependent rework transitions remain active until an explicit exit or replacement.

### `workflow_create`

`workflow_create` accepts one complete definition with optional `nested` and `kind`:

```json
{
  "id": "task-delivery",
  "description": "Task-specific delivery workflow",
  "prompt": "Follow the approved scope.",
  "stages": [
    {
      "id": "implementation",
      "description": "Implement the change",
      "goal": "The implementation passes the required checks",
      "prompt": "Implement and test the change.",
      "model": {
        "thinking": "medium"
      },
      "initial": true
    },
    {
      "id": "review",
      "description": "Review the result",
      "goal": "The reviewer has approved the implementation",
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

Each stage requires a `goal` describing the state that must hold when the stage is complete. The stage task consists of the actions that reach this state. The agent must achieve this state to complete the stage. Put actions and instructions in `prompt`, and transition conditions in `grounds`. The required-grounds rules are the same as for format-2 and format-3 catalog workflows.

On a successful call, the extension validates the whole graph, stores one format-3 `created` snapshot including goals and grounds, and immediately activates the initial stage. The initial stage activation record includes its goal. See [Session snapshots](#session-snapshots) for restoration of the whole chain, including earlier workflow formats.

With `nested: true`, creation appends the workflow above the current top; otherwise it replaces the whole chain. A replaced or exited dynamic workflow cannot be reactivated. The new ID must not match any catalog ID or any running chain ID after NFC normalization and exact case comparison. Reusing a waiting parent's ID is rejected without changing the chain.

The `workflow_create` TypeBox schema adds LLM-facing length and collection-size budgets. It leaves exact single-line and identifier rules to domain validation so providers do not need to compile nested regex constraints. YAML catalog definitions use the same domain text rules without the tool-specific budgets. `workflow_create` requires a closed `model` object on every stage. Every stage model requires `thinking`. The allowed values are `low`, `medium`, and `high`. Root model settings, `model.id`, and other thinking levels are rejected.

`workflow_create` remains available with a missing or empty catalog when the agent's `tools` policy permits it. A catalog error blocks creation because ID collisions cannot be checked against an incomplete namespace. Dynamic workflows are never written to YAML.

### `workflow_activate`

`workflow_activate` activates one ready-made workflow listed in `<workflow_activation_options>`. A nested activation appends to the chain; an ordinary activation replaces the entire chain. Every running workflow ID after NFC normalization is excluded from options. The extension first offers the tool when at least one activation option exists. Once offered, the tool remains offered in the session unless the agent's tool policy excludes it. When no activation options remain, a call fails because the requested workflow cannot be activated.

### `workflow_get_stage`

`workflow_get_stage` first becomes applicable while a workflow created through `workflow_create` is active. Once offered, it remains offered in the session, subject to the agent's tool policy. When no workflow remains or the top is catalog-backed, the tool rejects the call. When exit resumes a dynamic parent, the tool reads that parent's stages, even if the arguments were originally intended for the exited child. The tool accepts only `stageId`; it accepts no `workflowId` to identify an exited child and cannot read catalog workflows.

For a format-2 or format-3 stage, the JSON result contains `id`, `description`, `goal`, `prompt`, `model.thinking`, `initial`, and `final`. For a restored format-1 dynamic workflow, the result omits `goal`. When the inspected stage has no thinking override, the tool returns `model: {}`. The tool reads stage data without changing workflow state. It rejects an unknown stage.

### `workflow_edit_stage`

`workflow_edit_stage` has the same dynamic active-workflow applicability rule as `workflow_get_stage`. Once offered, it remains offered subject to tool policy. When no dynamic workflow is on top, calls fail without editing state. When exit resumes a dynamic parent, the tool edits that parent's stages, even if the arguments were originally intended for the exited child. It requires one closed replacement object:

```json
{
  "stageId": "implementation",
  "description": "Implement the corrected change",
  "goal": "The corrected implementation passes its checks",
  "prompt": "Follow the corrected requirements.",
  "model": {
    "thinking": "high"
  }
}
```

For formats 2 and 3, the tool requires and replaces `description`, `goal`, `prompt`, and `model.thinking`. If the goal is missing, empty after trimming, or invalid, the tool rejects the edit before changing state. For a restored format-1 dynamic workflow, omit `goal`. If the call supplies `goal`, the tool rejects the edit with an error stating that a stage goal requires format version 2. The shared tool schema keeps `goal` optional so it can serve all formats; the domain validator enforces the workflow's format rules.

The tool preserves `id`, `initial`, `final`, `triggers`, transitions, workflow fields, route, source, and restoration settings. `model.thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The extension appends a `stage_edited` session entry with the normalized replacement fields. For formats 2 and 3, it trims surrounding goal whitespace before saving. For example, `"  The corrected implementation passes its checks  "` is stored and restored as `"The corrected implementation passes its checks"`. For format 1, the extension omits the goal key. During replay, the extension applies the saved fields through the same stage-edit validation.

If validation or persistence fails, the extension preserves workflow state and publishes no stage update. If persistence fails after the extension applies the active stage's thinking level, it rolls back the runtime settings. On success, the extension publishes the edited stage's description, goal when present, and complete prompt in `<workflow_stage_updated>` for the next provider request. It sets `active="true"` for an active-stage edit and `active="false"` for an inactive-stage edit.

When you edit the active stage, the extension applies its thinking level immediately. When you edit an inactive stage, the extension preserves the active stage's runtime thinking. When a later transition enters the edited stage, the extension applies that stage's thinking level. During editing, the extension preserves the route and runs no stage-entry triggers.

### `workflow_transition`

`workflow_transition` requests the target stage named by `stageId` in `<available_transitions>`. An unbound transition enters it immediately; a bound transition starts its check first, as described in [Transition-bound workflows](#transition-bound-workflows). Permission for `workflow_create` does not grant transition permission.

Every call requires a free-text `basis` stating the facts that justify the transition, for every workflow format. The runtime rejects an absent, non-string, empty, or whitespace-only basis before changing or persisting state. The extension checks that the statement contains non-whitespace text; the agent evaluates its content. Surrounding whitespace and line breaks are accepted. For example, `{"stageId":"review","basis":"Implementation is complete and all tests passed."}` can take an available transition without grounds.

When the selected transition has more than one ground, supply one of its declared IDs in `ground`. When it has exactly one ground, `ground` is optional: a call without it selects that ground. If the ID is missing where it is required, or undeclared on that transition, the extension rejects the call with an error that lists each ground of that transition with its ID and condition. The extension validates the ID; the agent evaluates whether the selected ground's condition holds. For example, when `review` is active in the [catalog configuration example](#format-3), the extension accepts `{"stageId":"implementation","ground":"evidence_missing","basis":"The review found no test evidence for the error path."}`.

For a transition without grounds, including every format-1 transition, omit `ground`. If a call supplies `ground` for such a transition, the extension rejects the call.

Every tool rechecks its input and current state before reading or appending session state. Creation and activation also recheck the policy information they require. A malformed policy blocks all workflow operations. Validation or persistence errors leave the previous workflow state unchanged.

### `workflow_exit`

`workflow_exit` is the explicit way to finish the active workflow at any stage. Call it with a nonempty free-text `basis`, for example `{"basis":"The final report was delivered and no stage work remains."}`. The runtime rejects absent, non-string, empty, or whitespace-only basis before changing the route, publishing messages, or applying model settings. Multiline text and surrounding whitespace are accepted. The agent evaluates the basis; the extension checks only that it contains non-whitespace text.

For an ordinary workflow, exit ignores a supplied boolean `allow`. For a bound workflow, the runtime requires `allow` and resolves the pending transition as described in [Transition-bound workflows](#transition-bound-workflows).

On success, exit removes the top and persists the exit. When an unchanged parent resumes, the extension reapplies its effective stage settings and appends a return record with that stage's requirements and transitions. The agent continues the parent's same stage in the current loop. When no parent remains, exit restores the original root model and thinking snapshot and publishes an empty chain. A persistence failure rolls back model changes and preserves the active workflow. When the chain is empty, calls that require an active workflow return `no workflow is active`, including calls to previously offered transition or stage tools. Exit presentation uses the same saved workflow reference in compact and expanded views on both main and subagent screens.

## Compact session status panel

In interactive TUI mode, the active workflow saved in the current session publishes one row in the shared panel above Pi's editor:

```text
Workflow: TuiBrainstorming · Generate and discuss TUI concepts
```

The row contains the workflow ID and active stage description. It never includes stage IDs or transitions. The shared separator and the complete Workflow row use Pi's dim color. Repeated spaces and terminal layout whitespace, including tabs and line breaks, collapse to one space before display. A trailing `.` is removed. The row is clipped to the terminal width and ends with `…` when content is hidden.

A final stage remains visible while its workflow runs. After `workflow_exit`, both the main session panel and the subagent status reader show the resumed parent, or no active workflow when the chain is empty.

Creation, activation, stage editing, transition, session start, and branch changes replace the row with the saved active state. Exit updates the row to the parent or removes it when the chain is empty. Changing the selected agent or its workflow allowlist does not hide this row or the saved active workflow. The agent's tool policy still controls provider-context availability. A branch without saved active workflow state removes only the `Workflow` row; other shared panel rows remain visible.

## Tool presentation

The default Pi tool shell renders workflow references instead of displaying internal success JSON. While `workflow_create` arguments stream, each received type-compatible `kind`, `nested`, `description`, `prompt`, `stages`, or `transitions` field appears as YAML. The initial stage row appears as soon as its stage data arrives. Collapsed mode shows up to three visual YAML lines after the separate `Content:` label. When more YAML lines exist, the standard hint reports the hidden line count and the configured `app.tools.expand` binding:

```text
workflow_create
Workflow: task-delivery · Task-specific delivery workflow
Stage: implementation · Implement the approved change
Content:
description: Task-specific delivery workflow
prompt: Follow the approved scope.
stages:
... (18 more lines, 21 total, ctrl+o to expand)

workflow_activate
Workflow: delivery · Software delivery

workflow_get_stage: implementation
Description: Implement the approved change
Goal: The implementation passes the required checks
Prompt: Implement and test the change
Thinking: medium
... (2 more lines, 6 total, ctrl+o to expand)

workflow_edit_stage: implementation
Description: Implement the approved change -> Implement the corrected change
Goal: The implementation passes the required checks -> The corrected implementation passes its checks
Prompt: Implement and test the change -> Follow the corrected requirements.
Thinking: medium -> high

workflow_transition
From: implementation · Implement the approved change
To: review · Review the implementation
```

When the YAML has three or fewer visual lines, collapsed mode shows every line and omits the hidden-content hint. In expanded mode, the extension displays the submitted creation content as YAML and keeps the workflow ID in the separate `Workflow` section. When creation arguments contain a boolean `nested`, the YAML preview includes it in compact and expanded views on both screens, including while arguments stream. The display contains no `version` field because `workflow_create` accepts no caller-supplied version selector. Before saving the displayed content as a catalog file, add `version: 3` and name the file after the workflow ID with a `.yaml` extension.

```text
workflow_create
--- Workflow ---
task-delivery · Task-specific delivery workflow
--- Stage ---
implementation · Implement the approved change
--- Content ---
description: Task-specific delivery workflow
prompt: Follow the approved scope.
stages:
  - id: implementation
    description: Implement the approved change
    goal: The implementation passes the required checks
    prompt: Implement and test the change
    model:
      thinking: medium
    initial: true
  - id: review
    description: Review the result
    goal: The reviewer has approved the implementation
    prompt: Review the implementation
    model:
      thinking: high
    final: true
transitions:
  - from: implementation
    to: review
    type: advance
```

For format-2 and format-3 stage inspection, the renderer places `Goal` between `Description` and `Prompt`: a labeled row in collapsed (compact) mode and a `--- Goal ---` section in expanded mode. The renderer uses these attributes for live calls and replay on both main and subagent screens. When saved stage content has no goal, the renderer omits the `Goal` attribute.

When a user views a stored `workflow_get_stage` block whose valid presentation metadata contains `model: {}`, the renderer omits `Thinking`. It displays `Description`, `Prompt`, and any saved `Goal`, `Initial`, and `Final` attributes within the compact budget or as expanded sections. This applies on both main and subagent screens, including replay without the source workflow active. A restored format-1 dynamic stage without a model override also produces `model: {}` for inspection. When the metadata contains thinking, the renderer displays that value. The presentation parser requires a model object and validates provided thinking as a non-empty string; it also validates the remaining stage fields.

When saved edit metadata contains a new thinking value and no prior thinking value, the renderer shows only the new value. For example, `model: {}` followed by `model: { thinking: "high" }` produces `Thinking: high` in compact mode and a `--- Thinking ---` section containing `high` in expanded mode. The renderer adds no comparison arrow for this attribute. When the replacement thinking value is absent, the renderer omits `Thinking` and displays any other captured changes. When two known thinking values differ, it shows the old-to-new comparison; when they are equal, it omits `Thinking`. These presentation rules leave workflow state and runtime model settings unchanged.

For stage edits, the renderer places the goal change between the description and prompt changes, using the same row and section conventions. If only the goal changes, the renderer displays only the old and replacement goal. Before comparing goals, the renderer trims surrounding whitespace from the replacement. If the normalized replacement equals the saved goal, the renderer omits the goal change row. If all editable values compare equal, it shows `No changes.`. The renderer reads saved presentation evidence during deferred rendering, so the first replay render shows the same changes as the live call.

The renderer keeps the shared collapsed attribute budget of four visual lines. The tool title and expansion hint are outside this budget. When computing the hint, the renderer counts all wrapped attribute lines, including the goal. In the compact inspection example above, each attribute fits on one line, so the renderer shows four of six attribute lines and reports two hidden lines.

For example, an expanded format-2 inspection includes:

```text
workflow_get_stage: implementation
--- Description ---
Implement the approved change
--- Goal ---
The implementation passes the required checks
--- Prompt ---
Implement and test the change
--- Thinking ---
medium
--- Initial ---
true
--- Final ---
false
```

For a grounded transition, the extension appends `Ground` after `From` and `To`. Compact mode shows only the selected condition:

```text
Ground: A finding needs units that inspection did not cover.
```

Expanded mode shows the selected ID, ` · `, and condition:

```text
--- Ground ---
finding_needs_uncovered_units · A finding needs units that inspection did not cover.
```

The extension captures the selected ID and validated `when` text from the matching source-to-target transition before execution changes the route; for a call without `ground` to a transition with one ground, it captures that ground. It saves this pair with the endpoints in tool-result `details`. During replay, the renderer reads these saved values on the first render, even when the source workflow is inactive or its definition has changed. Main and subagent screens use one shared renderer; neither screen has a separate copy of the transition rendering logic.

For unconditional transitions, including every format-1 transition, the renderer omits `Ground`. When saved presentation metadata has no ground, the renderer retains the saved `From` and `To` display. It neither reconstructs a ground from workflow history nor displays a ground ID without condition text. Each ground in a validated definition requires an ID and non-empty `when` text. Only the earlier tool-result presentation metadata omitted the selected ground. Workflow-state transition records remain separate: each contains `journalVersion: 2`, `kind: "transitioned"`, and the updated `route`.

For `Ground`, the shared reference renderer normalizes source line breaks to spaces in compact mode. The wrapping helper reserves space for `Ground:` and one separating space on the first row, then uses the shell-provided content width for continuation rows. If the label fills or exceeds the content width, the helper truncates the label and starts the value on the next row. If the label and separator leave no capacity for the value, or the first value character cannot fit the remaining slot, the helper keeps the label and separator on the first row and wraps the complete value on continuation rows. This allocation assumes that each value character fits within the full content width.

The renderer shows at most four visual lines for `Ground`, independently of the `From` and `To` budgets. It excludes the tool title and hidden-line hint from this budget. When more lines exist, the hint reports the hidden and total line counts. Expanded mode preserves source line breaks and uses Pi's `Text` wrapping at the content width, with no line-count limit.

For a transition bound to a nested workflow, the extension appends `Nested workflow` with the ID and description of this workflow. The exit of such a workflow appends `Transition` with the requested stage and the outcome:

```text
workflow_transition
From: implementation · Implementation stage
To: review · Review stage
Nested workflow: stage-check · Check the stage result
workflow_exit
Workflow: stage-check · Check the stage result
Transition: review · allowed
```

With `allow: false`, the last row reads `Transition: review · refused`.

Compact `Workflow:`, `Stage:`, `From:`, `To:`, `Ground:`, `Nested workflow:`, `Transition:`, and `Content:` labels use Pi's bold `toolTitle` color. Reference values and YAML use `toolOutput`. Each stage attribute starts a separate semantic row. Collapsed mode normalizes source line breaks inside each attribute to spaces, wraps its value to the available width, and applies the collapsed attribute budget described above. Expanded mode renders every displayed attribute as a `--- Name ---` section and preserves source line breaks. An expanded `workflow_edit_stage` section contains the old value, a separate `->` row, and the new value. The edit tool shows only changed attributes; an edit with equal values shows `No changes.`. Collapsed attribute labels also use Pi's bold `toolTitle` color, expanded section headers use `muted`, and change arrows use `success`. A failed call keeps the identity captured before execution and adds `Error: <message>`. Workflow and stage presentation data is stored in result `details`. Expanded creation YAML is reconstructed from the stored tool-call arguments. These stored sources keep the active screen and subagent session screen consistent.

## Provider context

The extension first offers each tool when it becomes applicable:
- `workflow_create` requires a valid catalog, including a valid empty catalog;
- `workflow_activate` requires at least one allowed activation option;
- `workflow_get_stage` and `workflow_edit_stage` require an active dynamic workflow created through `workflow_create`;
- `workflow_transition` and `workflow_exit` require an active workflow or at least one allowed catalog workflow.

Once offered, a workflow-owned tool remains offered in the session even after its operation stops applying. An inapplicable call returns an explicit error, for example `no workflow is active` after the last exit. After a nested exit, calls operate on the resumed parent when applicable.

The agent's `tools` policy remains a second gate. The extension never restores a tool removed by that policy.

Workflow state entries remain authoritative for runtime reconstruction. Model-facing workflow data uses hidden, persistent messages with `customType: "workflow"` and `display: false`. Lifecycle records use `deliverAs: "steer"` to enter the next provider request during a tool loop. Initial activation options use the message returned by `before_agent_start`; Pi appends that message with the new user input without a steering queue. The extension does not register a `context` handler or rewrite messages already sent to a provider.

The journal is append-only:
- Activation appends `<workflow_activated>` with root guidance, stage descriptions, and the complete transition graph. The same message then appends `<workflow_stage_activated guidelines="inline">` for the initial stage.
- First entry into a stage appends its prompt with `guidelines="inline"`.
- Repeated entry into a known unchanged stage uses `guidelines="reuse"` and does not repeat the prompt.
- In formats 2 and 3, the extension includes `<stage_goal>` in every stage activation, including reuse entries. In inline entries, the goal precedes `<stage_guidelines>`. In reuse entries, the extension omits `<stage_guidelines>`.
- Every stage activation includes current outgoing `<available_transitions>`. Route-dependent `rework` options are recalculated for each entry. For each transition with grounds, the extension includes all declared ground IDs and condition texts.
- `workflow_edit_stage` appends `<workflow_stage_updated>` with the complete replacement description and prompt. For formats 2 and 3, it includes the replacement `<stage_goal>` before `<stage_guidelines>`.
- Entry into a final stage includes guidance to finish the stage's work and call `workflow_exit`.
- A return appends the resumed parent's stage activation, using known instructions only when their unchanged definition remains known in the current segment. Stage knowledge is scoped by workflow identity and stage definition.
- The last exit appends `<workflow_exited />`, `<workflow_state active="false" />`, and an empty `<workflow_chain />`. The next provider request receives this record without changing earlier messages.
- Every lifecycle record describes the current chain with the top and waiting workflow/stage identities.
- Periodic publication appends `<workflow_reminder id="workflow-id" active_stage_id="stage-id" />`. The reminder marker contains XML-escaped top workflow and active stage IDs, followed by the current chain.
- An empty transition set is represented by `<available_transitions />`.

While a workflow is active, the extension counts activity from each completed `turn_end` event. A turn contributes the greater of its completed tool-call count and one reasoning unit. A final assistant message has one reasoning unit when any `thinking` block contains text, a `thinkingSignature`, or `redacted: true`. Multiple reasoning blocks in one turn still contribute one unit. When the count reaches `reminderToolCallInterval`, the extension appends one reminder and resets the count to zero. A tool turn uses `deliverAs: "steer"` so the reminder reaches the next request in the tool loop. A reasoning-only turn uses `deliverAs: "nextTurn"` so the reminder reaches the next user-triggered request without starting an extra request. One parallel tool batch produces at most one reminder, and activity beyond the threshold is discarded. If every finalized result in a non-empty batch has `terminate: true`, that activity remains counted but the extension suppresses the reminder decision for that turn. A later zero-activity turn does not release the deferred reminder. A reasoning-only turn can release it through `nextTurn`, and the next ordinary non-empty tool batch can release it through `steer`. A mixed batch with at least one non-terminating result follows ordinary reminder counting. Workflow activation, stage entry, current-stage editing, checkpoint publication, and reminder publication reset the count. If one of these records is published during a turn, the extension does not count that turn's activity. Session start and branch changes also reset the runtime count. After a nested exit, reminders concern the resumed parent. When no workflow is active, or the interval is `0`, the extension produces no reminders.

Activation availability uses separate `<workflow_activation_options>` records. Session start, branch navigation, and `/agent` policy changes do not publish these records. Before each new run, the extension reads the selected branch after its latest compaction or branch summary and publishes only availability that differs from the last persisted value. Several idle selections therefore produce at most one record for the final selection. An initial empty result publishes no record. `<workflow_activation_options />` publishes only to replace an earlier non-empty value in that context segment. Preparing a message that Pi does not persist cannot suppress publication at the next run start. Workflow tool execution still publishes availability changes required by its lifecycle.

Activation-options updates default to `triggerTurn: false`. Pi appends updates after tool execution without queuing a steering message. Updates therefore neither delay reminders in `one-at-a-time` steering mode nor request another provider turn after a terminating tool batch.

Already published records remain unchanged and retain their order. Replacement means appending another record, not modifying an earlier record. Main-agent selection during a run is deferred as described in [main-agent-selection](main-agent-selection.md).

Before publishing a checkpoint, the extension inspects `buildSessionProjection().entries`. A model-visible activation record or a checkpoint with `details.includesGraph: true` establishes graph visibility for the same workflow ID. When no such record is visible, the extension includes `<stages>` and `<transitions>` from the saved workflow definition and marks the checkpoint with `includesGraph: true`. Otherwise, it sets `includesGraph: false` and omits the graph. This applies to every active workflow, including one on a final stage. For example, when compaction keeps the activation record or an earlier graph checkpoint, the new checkpoint omits the graph. When compaction summarizes both, the new checkpoint restores it with saved stage edits.

In a format-2 or format-3 checkpoint, the extension places `<stage_goal>` before `<active_stage_guidelines>`, then lists available transitions with their declared grounds.

After `session_compact`, the extension resets journal deduplication for the new provider-visible segment. It appends one `<workflow_checkpoint>` when workflow state exists, independently of activation options. During a running session, it also publishes non-empty activation options for the continuing run with `triggerTurn: false`. Manual compaction while Pi is idle leaves activation-options publication to the next `before_agent_start`. After the last exit, compaction appends a no-workflow record. After a nested exit, compaction appends a checkpoint for the resumed chain. Without workflow state, the extension applies the same activation-options rule without an active-stage checkpoint. A repair checkpoint outside compaction preserves activation-options deduplication. Other stage definitions become unknown. The first later entry into another stage therefore uses `guidelines="inline"`.

Every new workflow-state entry uses `journalVersion: 2`. Roots without a journal version retain the legacy warning and are ignored with their subsequent operations. Version-1 roots and their unversioned subsequent entries remain readable. On session start and branch navigation, the extension scans `custom_message` workflow entries after the latest `compaction` or `branch_summary` entry. Current-format compatibility requires the saved lifecycle record to match the whole chain, including waiting definitions, routes, and restoration snapshots. A current-format state receives one checkpoint when the current segment has no compatible lifecycle record or the projection lacks a graph for any workflow in the chain. Checkpoints include missing waiting-workflow graphs as well as the top's current requirements and transitions. A session compacted by an earlier version therefore receives one graph checkpoint on its first resume. Later resumes preserve that checkpoint and append nothing while its state remains compatible and its graph remains visible.

Catalog activation options are filtered through `workflows`. A resolved agent policy can hide every workflow tool without deleting the saved workflow state. When a later compatible policy restores `workflow_transition`, the saved route remains available for continuation.

## Session snapshots

Every new entry contains `journalVersion: 2`. Catalog activation stores an `activated` snapshot with `mode: "push"` for a nested start or `mode: "replace"` otherwise, the validated definition, route, and pre-workflow restoration settings. Dynamic creation stores the same data in a `created` snapshot. Stage edits store the stage ID and normalized replacement fields. Transitions store `kind: "transitioned"` and the updated `route`. A bound catalog start also stores `pendingTransition` with `stageId` and optional `ground`. Exit stores `kind: "exited"` and removes the active workflow from the chain. The runtime has no completed workflow status. Ordinary transition entries omit ground and basis; tool-call arguments retain both. Bound start entries retain the selected ground in their pending request so replay can resolve permission. Replay preserves stage triggers without running them.

For supported journal versions 1 and 2, the validator applies the format-version rules to saved catalog and dynamic definitions. For format-2 and format-3 definitions, the extension restores the version, stage goals, transition grounds, and saved route. Format-3 snapshots also retain the nested flag and kind. Replay validates the saved kind's format without requiring membership in the currently installed kinds catalog. It also restores legacy format-1 definitions and their routes, treating an omitted version as format 1. The workflow format version is independent of `journalVersion`.

The active branch reconstructs state on session start and branch changes:
- `activated` and `created` append or replace according to the saved start mode, preserving every waiting workflow's definition, route, edits, and restoration snapshot;
- for a format-2 or format-3 `stage_edited` entry, the extension replaces `description`, `goal`, `prompt`, and `model.thinking` in the preceding active dynamic snapshot. Legacy format-1 edits omit `goal`;
- `transitioned` updates the route of the preceding snapshot;
- `exited` requires `journalVersion: 2` and removes the top. For a pending transition, the same entry requires boolean `allow`; true also changes the parent's route to the pending target, while false preserves its route. The extension applies the resulting stage's effective settings, or the original root snapshot when no parent remains;
- unversioned `completed` entries following a supported version-1 root also remove the workflow and restore its snapshot. If an old unversioned rework transition already follows that completion in saved data, replay restores the resulting active route and stage settings. This compatibility applies only to historical replay; new exits cannot be reworked.

On session start and branch navigation, replay handles mixed version-1 and version-2 operations in order. When no workflow remains, the extension restores the snapshot from the exit or legacy completion. Later branch model and thinking entries override that snapshot independently. When navigating to a branch without workflow history, its model and thinking entries override the abandoned workflow's restoration snapshot. Branch overrides leave the original restoration snapshot unchanged, so visiting a sibling branch does not change the fallback for branches without settings. This restoration also works after the runtime chain has become empty.

An earlier package version cannot read journal version 2. If you downgrade, the earlier extension reports an unsupported journal version and cannot restore workflow state from the new entries. Workflow definition formats 1, 2, and 3 are supported.

Bound starts and checkpoints name pending transitions alongside their owning workflows. Their structured metadata includes `pendingTransitions`; refusal return records include `refusedTransition`. Records are appended without changing earlier messages. One journal2 exit entry stores permission and the resulting transition atomically. Replay validates closed entry keys and restores the target without requiring a second transition entry. The child-status reader shows the resulting top stage.

The latest valid active snapshot remains available under every resolved policy after its catalog file is removed or the catalog becomes invalid. An invalid catalog prevents new creation and activation but does not block unbound transitions of that saved active workflow. A bound transition still requires its check in the loaded catalog. An already-running bound check resolves from saved definitions even if catalog files have changed. Earlier replaced dynamic workflows do not appear in activation options and cannot be reactivated.

## CLI flags

The workflow extension registers no CLI flags. The `--trigger <type>` flag is owned by the `algorithms` extension and runs a registered algorithm at startup; see `docs/extensions/algorithms.md`.
