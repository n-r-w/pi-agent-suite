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

### Catalog format versions

The catalog loader accepts `version: 1` and `version: 2` in YAML. When `version` is omitted, the loader selects format 1. For any other version value, the loader rejects the file with an error naming the value. For format 1, the validator rejects stage `goal` and transition `grounds` fields and explains that they require format 2.

Declaring `version: 1` is equivalent to omitting `version`: the validator produces identical normalized definitions. Both forms therefore have the same definition revision and model-facing records. `workflow_create` always creates format-2 workflows without a caller-supplied version selector.

In format 2, each stage requires a non-empty string in `goal`: the stage goal, or state that must hold when the stage ends. A transition can declare a `grounds` list. Each transition ground contains only a technical `id` and a non-empty string in `when` that describes its condition. Ground IDs follow the stage-ID rules and must be unique within their transition. Different transitions can reuse an ID.

Each `rework` transition requires at least one ground. If a stage has multiple outgoing `advance` transitions, each requires at least one ground. If a stage has only one outgoing `advance` transition, that transition can omit `grounds` or use an empty list; the transition is then unconditional.

```yaml
version: 2
description: Prepare a delivery
stages:
  - id: prepare
    description: Prepare the delivery
    goal: Delivery evidence is ready for review
    prompt: Collect and check the delivery evidence
    initial: true
  - id: review
    description: Review the delivery
    goal: The reviewer has approved the delivery
    prompt: Review the evidence and record the decision
    final: true
transitions:
  - from: prepare
    to: review
    type: advance
  - from: review
    to: prepare
    type: rework
    grounds:
      - id: evidence_missing
        when: The reviewer identifies missing delivery evidence
```

For goal and condition text, the validator removes surrounding whitespace and preserves internal line structure, as it does for stage prompts. When a goal is invalid, the validator names the stage in the error. When required grounds are missing or grounds are invalid, the validator names the source and target stages. The validator applies shared graph rules to both formats.

On activation of a format-2 workflow, the extension publishes the initial stage goal in a separate `<stage_goal>` element before `<stage_guidelines>` in the initial `<workflow_stage_activated>` record. When a transition has grounds, the extension includes `<ground id="...">condition</ground>` elements inside that transition in `<available_transitions>`. For transitions with no grounds, the extension uses self-closing `<transition ... />` elements. In the complete graph in `<workflow_activated>`, the extension lists transition endpoints and types only.

See [`workflow_transition`](#workflow_transition) for ground selection and validation.

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

At runtime, an `advance` transition appends its target to the recorded route. A `rework` transition is available only when its target is already in that route. Being a strict `advance` ancestor satisfies graph validation but does not make an unvisited stage available for `rework`. If an alternative `advance` path skipped the target stage, the workflow must first return to a visited stage and then enter the skipped stage through `advance`. A successful `rework` truncates the recorded route after its target stage.

Surrounding prompt whitespace is removed. An omitted or empty root prompt means that the workflow has no shared guidance.

Catalog YAML model settings use independently optional `id` and `thinking` fields. `id` accepts either `provider/model` or an alias from `model-aliases/config.json`. The effective values are resolved independently with stage settings taking priority over workflow settings, followed by the selected agent and the current Pi runtime value. When a level omits `thinking`, the alias default thinking of that level's model applies. When the selected agent is unavailable, such as in child subagent processes or sessions without a selected agent, the pre-workflow restoration snapshot supplies the model and thinking for stages that omit them at the stage, workflow, and agent levels. Unknown models and thinking levels unsupported by the resolved model fail before workflow state is persisted. Settings are applied during activation, stage transitions, and session synchronization. Manual model changes in Pi or main-agent changes are not automatically overwritten.

Workflow activation and dynamic creation persist the current runtime model identifier and thinking level as a restoration snapshot. When a successful agent run settles on a final stage, the extension restores that snapshot and marks the workflow completed. A run ending with `stopReason: "aborted"` or `stopReason: "error"` leaves the final stage active with its runtime settings and instructions unchanged. This lifecycle handling uses `turn_end` and `agent_settled` and does not require TUI or user interaction, so it also applies to subagents, RPC sessions, and print mode.

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
  "transitionDescriptionPromptFile": "/absolute/path/transition-description.md"
}
```

`reminderToolCallInterval` defaults to `50` and measures the activity units defined below. It accepts safe integers greater than or equal to `0`. A value of `0` disables periodic reminders. Each configured prompt path must be absolute or home-prefixed and reference a readable file with non-empty content after trimming. Home-prefixed paths accept `~`, `$HOME`, or `${HOME}`, either alone or followed by `/...`. Other environment variables are not expanded. Unknown fields, invalid intervals, and invalid files reject the complete workflow configuration atomically.

`extensionDescriptionPromptFile` supplies one `promptGuidelines` contribution on each workflow tool. The system prompt formatter normalizes duplicate contributions, so the guidance appears once while any workflow tool is active. The other files replace the Pi tool description for the corresponding tool.

With the default shared guidance, the agent completes a stage only when its goal state holds. When every available transition has grounds and none of their conditions holds, the agent takes no transition and describes the situation in its reply. Transitions without grounds remain unconditional.

If you set `extensionDescriptionPromptFile`, the extension uses your file in place of the entire default shared guidance. Include the goal, task, completion, and transition guidance in your file so the agent receives it.

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

Each stage requires a `goal` describing the state that must hold when the stage ends. The stage task consists of the actions that reach this state. The agent must achieve this state to complete the stage. Put actions and instructions in `prompt`, and transition conditions in `grounds`. The required-grounds rules are the same as for format-2 catalog workflows.

On a successful call, the extension validates the whole graph, stores one format-2 `created` snapshot including goals and grounds, and immediately activates the initial stage. The initial stage activation record includes its goal. See [Session snapshots](#session-snapshots) for restoration of format-2 workflows and older unversioned definitions.

The extension replaces an active workflow when the new workflow has a different ID. A replaced dynamic workflow cannot be reactivated. The new ID must not match a catalog ID or the active dynamic ID after NFC normalization and exact case comparison. Reusing the active dynamic ID is rejected without resetting its route.

The `workflow_create` TypeBox schema adds LLM-facing length and collection-size budgets. It leaves exact single-line and identifier rules to domain validation so providers do not need to compile nested regex constraints. YAML catalog definitions use the same domain text rules without the tool-specific budgets. `workflow_create` requires a closed `model` object on every stage. Every stage model requires `thinking`. The allowed values are `low`, `medium`, and `high`. Root model settings, `model.id`, and other thinking levels are rejected.

`workflow_create` remains available with a missing or empty catalog when the agent's `tools` policy permits it. A catalog error blocks creation because ID collisions cannot be checked against an incomplete namespace. Dynamic workflows are never written to YAML.

### `workflow_activate`

`workflow_activate` activates one ready-made workflow listed in `<workflow_activation_options>`. Activation replaces prior workflow state. Only the exact active workflow ID after NFC normalization is excluded from options. The tool is unavailable when policy filtering and that exclusion leave no activation options.

### `workflow_get_stage`

`workflow_get_stage` is available only while a workflow created through `workflow_create` is active. It accepts only `stageId` and reads that stage from the current workflow. It does not accept `workflowId` and cannot read catalog workflows.

For a format-2 stage, the JSON result contains `id`, `description`, `goal`, `prompt`, `model.thinking`, `initial`, and `final`. For a restored format-1 dynamic workflow, the result omits `goal`. When the inspected stage has no thinking override, the tool returns `model: {}`. The tool reads stage data without changing workflow state. It rejects an unknown stage.

### `workflow_edit_stage`

`workflow_edit_stage` has the same dynamic active-workflow availability rule. It requires one closed replacement object:

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

For format 2, the tool requires and replaces `description`, `goal`, `prompt`, and `model.thinking`. If the goal is missing, empty after trimming, or invalid, the tool rejects the edit before changing state. For a restored format-1 dynamic workflow, omit `goal`. If the call supplies `goal`, the tool rejects the edit with an error stating that a stage goal requires format version 2. The shared tool schema keeps `goal` optional so it can serve both formats; the domain validator enforces the workflow's format rules.

The tool preserves `id`, `initial`, `final`, `triggers`, transitions, workflow fields, route, status, source, and restoration settings. `model.thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The extension appends a `stage_edited` session entry with the normalized replacement fields. For format 2, it trims surrounding goal whitespace before saving. For example, `"  The corrected implementation passes its checks  "` is stored and restored as `"The corrected implementation passes its checks"`. For format 1, the extension omits the goal key. During replay, the extension applies the saved fields through the same stage-edit validation.

If validation or persistence fails, the extension preserves workflow state and publishes no stage update. If persistence fails after the extension applies the active stage's thinking level, it rolls back the runtime settings. On success, the extension publishes the edited stage's description, goal when present, and complete prompt in `<workflow_stage_updated>` for the next provider request. It sets `active="true"` for an active-stage edit and `active="false"` for an inactive-stage edit.

When you edit the active stage, the extension applies its thinking level immediately. When you edit an inactive stage, the extension preserves the active stage's runtime thinking. When a later transition enters the edited stage, the extension applies that stage's thinking level. During editing, the extension preserves the route and runs no stage-entry triggers.

### `workflow_transition`

`workflow_transition` enters the target stage named by `stageId` in `<available_transitions>`. Permission for `workflow_create` does not grant transition permission.

When the selected transition has grounds, supply one of its declared IDs in `ground`. If the ID is missing or undeclared on that transition, the extension rejects the call with an error listing all allowed ground IDs for that transition. The extension validates the ID; the agent evaluates whether the selected ground's condition holds. For example, when `review` is active or completed in the format-2 workflow above, the extension accepts `{"stageId":"prepare","ground":"evidence_missing"}`.

For a transition without grounds, including every format-1 transition, omit `ground`. If a call supplies `ground` for such a transition, the extension rejects the call.

Every tool rechecks its input and current state before reading or appending session state. Creation and activation also recheck the policy information they require. A malformed policy blocks all workflow operations. Validation or persistence errors leave the previous workflow state unchanged.

## Compact session status panel

In interactive TUI mode, the active workflow saved in the current session publishes one row in the shared panel above Pi's editor:

```text
Workflow: TuiBrainstorming · Generate and discuss TUI concepts
```

The row contains the workflow ID and active stage description. It never includes stage IDs or transitions. The shared separator and the complete Workflow row use Pi's dim color. Repeated spaces and terminal layout whitespace, including tabs and line breaks, collapse to one space before display. A trailing `.` is removed. The row is clipped to the terminal width and ends with `…` when content is hidden.

A completed workflow is still retained for rework. Its latest journal record uses `<workflow_completed>` and contains no completed-stage prompt. Rework appends a new `<workflow_stage_activated>` record.

Creation, activation, stage editing, transition, session start, and branch changes replace the row with the saved active state. Changing the selected agent or its workflow allowlist does not hide this row or the saved active workflow. The agent's tool policy still controls provider-context availability. A branch without saved active workflow state removes only the `Workflow` row; other shared panel rows remain visible.

## Tool presentation

The default Pi tool shell renders workflow references instead of displaying internal success JSON. While `workflow_create` arguments stream, each received type-compatible `description`, `prompt`, `stages`, or `transitions` field appears as YAML. The initial stage row appears as soon as its stage data arrives. Collapsed mode shows up to three visual YAML lines after the separate `Content:` label. When more YAML lines exist, the standard hint reports the hidden line count and the configured `app.tools.expand` binding:

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

When the YAML has three or fewer visual lines, collapsed mode shows every line and omits the hidden-content hint. In expanded mode, the extension displays the submitted creation content as YAML and keeps the workflow ID in the separate `Workflow` section. The display contains no `version` field because `workflow_create` accepts no caller-supplied version selector. Before saving the displayed content as a catalog file, add `version: 2` and name the file after the workflow ID with a `.yaml` extension.

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

For format-2 stage inspection, the renderer places `Goal` between `Description` and `Prompt`: a labeled row in collapsed (compact) mode and a `--- Goal ---` section in expanded mode. The renderer uses these attributes for live calls and replay on both main and subagent screens. When saved stage content has no goal, the renderer omits the `Goal` attribute.

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

The extension captures the selected ID and validated `when` text from the matching source-to-target transition before execution changes the route. It saves this pair with the endpoints in tool-result `details`. During replay, the renderer reads these saved values on the first render, even when the source workflow is inactive or its definition has changed. Main and subagent screens use one shared renderer; neither screen has a separate copy of the transition rendering logic.

For unconditional transitions, including every format-1 transition, the renderer omits `Ground`. When saved presentation metadata has no ground, the renderer retains the saved `From` and `To` display. It neither reconstructs a ground from workflow history nor displays a ground ID without condition text. Each ground in a validated definition requires an ID and non-empty `when` text. Only the earlier tool-result presentation metadata omitted the selected ground. Workflow-state transition records remain separate: each contains only `kind: "transitioned"` and the updated `route`.

For `Ground`, the shared reference renderer normalizes source line breaks to spaces in compact mode. The wrapping helper reserves the width of `Ground:` and one separating space on the first value row, then uses the shell-provided content width for continuation rows. If the label fills or exceeds the content width, the helper truncates the label and starts the value on the next row. The renderer shows at most four visual lines for `Ground`, independently of the `From` and `To` budgets. It excludes the tool title and hidden-line hint from this budget. When more lines exist, the hint reports the hidden and total line counts. Expanded mode preserves source line breaks and uses Pi's `Text` wrapping at the content width, with no line-count limit.

Compact `Workflow:`, `Stage:`, `From:`, `To:`, `Ground:`, and `Content:` labels use Pi's bold `toolTitle` color. Reference values and YAML use `toolOutput`. Each stage attribute starts a separate semantic row. Collapsed mode normalizes source line breaks inside each attribute to spaces, wraps its value to the available width, and applies the collapsed attribute budget described above. Expanded mode renders every displayed attribute as a `--- Name ---` section and preserves source line breaks. An expanded `workflow_edit_stage` section contains the old value, a separate `->` row, and the new value. The edit tool shows only changed attributes; an edit with equal values shows `No changes.`. Collapsed attribute labels also use Pi's bold `toolTitle` color, expanded section headers use `muted`, and change arrows use `success`. A failed call keeps the identity captured before execution and adds `Error: <message>`. Workflow and stage presentation data is stored in result `details`. Expanded creation YAML is reconstructed from the stored tool-call arguments. These stored sources keep the active screen and subagent session screen consistent.

## Provider context

The extension computes tool availability independently:
- `workflow_create` requires a valid catalog, including a valid empty catalog;
- `workflow_activate` requires at least one allowed activation option;
- `workflow_get_stage` and `workflow_edit_stage` require an active dynamic workflow created through `workflow_create`;
- `workflow_transition` requires a saved workflow state or at least one allowed catalog workflow.

The agent's `tools` policy remains a second gate. The extension never restores a tool removed by that policy.

Workflow state entries remain authoritative for runtime reconstruction. Model-facing workflow data uses hidden, persistent messages with `customType: "workflow"` and `display: false`. Lifecycle records use `deliverAs: "steer"` to enter the next provider request during a tool loop. Initial activation options use the message returned by `before_agent_start`; Pi appends that message with the new user input without a steering queue. The extension does not register a `context` handler or rewrite messages already sent to a provider.

The journal is append-only:
- Activation appends `<workflow_activated>` with root guidance, stage descriptions, and the complete transition graph. The same message then appends `<workflow_stage_activated guidelines="inline">` for the initial stage.
- First entry into a stage appends its prompt with `guidelines="inline"`.
- Repeated entry into a known unchanged stage uses `guidelines="reuse"` and does not repeat the prompt.
- In format 2, the extension includes `<stage_goal>` in every stage activation, including reuse entries. In inline entries, the goal precedes `<stage_guidelines>`. In reuse entries, the extension omits `<stage_guidelines>`.
- Every stage activation includes current outgoing `<available_transitions>`. Route-dependent `rework` options are recalculated for each entry. For each transition with grounds, the extension includes all declared ground IDs and condition texts.
- `workflow_edit_stage` appends `<workflow_stage_updated>` with the complete replacement description and prompt. For format 2, it includes the replacement `<stage_goal>` before `<stage_guidelines>`.
- On `agent_settled` after a successful final-stage run, the extension appends `<workflow_completed>` with available rework transitions and their grounds. It omits the completed stage's goal and prompt. Settlement runs after the active agent loop ends, so the completion record reaches the next user-triggered provider request.
- Periodic publication appends `<workflow_reminder id="workflow-id" active_stage_id="stage-id" />`. The marker contains only XML-escaped workflow and active stage IDs.
- An empty transition set is represented by `<available_transitions />`.

While a workflow is active, the extension counts activity from each completed `turn_end` event. A turn contributes the greater of its completed tool-call count and one reasoning unit. A final assistant message has one reasoning unit when any `thinking` block contains text, a `thinkingSignature`, or `redacted: true`. Multiple reasoning blocks in one turn still contribute one unit. When the count reaches `reminderToolCallInterval`, the extension appends one reminder and resets the count to zero. A tool turn uses `deliverAs: "steer"` so the reminder reaches the next request in the tool loop. A reasoning-only turn uses `deliverAs: "nextTurn"` so the reminder reaches the next user-triggered request without starting an extra request. One parallel tool batch produces at most one reminder, and activity beyond the threshold is discarded. If every finalized result in a non-empty batch has `terminate: true`, that activity remains counted but the extension suppresses the reminder decision for that turn. A later zero-activity turn does not release the deferred reminder. A reasoning-only turn can release it through `nextTurn`, and the next ordinary non-empty tool batch can release it through `steer`. A mixed batch with at least one non-terminating result follows ordinary reminder counting. Workflow activation, stage entry, current-stage editing, checkpoint publication, and reminder publication reset the count. If one of these records is published during a turn, the extension does not count that turn's activity. Session start and branch changes also reset the runtime count. Completed workflows and an interval of `0` produce no reminders.

Activation availability uses separate `<workflow_activation_options>` records. Session start, branch navigation, and `/agent` policy changes do not publish these records. Before each new run, the extension reads the selected branch after its latest compaction or branch summary and publishes only availability that differs from the last persisted value. Several idle selections therefore produce at most one record for the final selection. An initial empty result publishes no record. `<workflow_activation_options />` publishes only to replace an earlier non-empty value in that context segment. Preparing a message that Pi does not persist cannot suppress publication at the next run start. Workflow tool execution still publishes availability changes required by its lifecycle.

Activation-options updates default to `triggerTurn: false`. Pi appends updates after tool execution without queuing a steering message. Updates therefore neither delay reminders in `one-at-a-time` steering mode nor request another provider turn after a terminating tool batch.

Already published records remain unchanged and retain their order. Replacement means appending another record, not modifying an earlier record. Main-agent selection during a run is deferred as described in [main-agent-selection](main-agent-selection.md).

In a format-2 active checkpoint, the extension places `<stage_goal>` before `<active_stage_guidelines>`, then lists available transitions with their declared grounds. In a completed checkpoint, the extension omits the stage goal and stage guidelines and lists available rework transitions with their grounds.

After `session_compact`, the extension resets journal deduplication for the new provider-visible segment. It appends one `<workflow_checkpoint>` when workflow state exists, independently of activation options. During a running session, it also publishes non-empty activation options for the continuing run with `triggerTurn: false`. Manual compaction while Pi is idle leaves activation-options publication to the next `before_agent_start`. Without workflow state, the extension applies the same activation-options rule without a checkpoint. A repair checkpoint outside compaction preserves activation-options deduplication. Other stage definitions become unknown. The first later entry into another stage therefore uses `guidelines="inline"`.

New `activated` and `created` workflow-state snapshots require `journalVersion: 1`. State without this field belongs to the old format, is ignored with a warning, and produces no repair checkpoint. On session start and branch navigation, the extension scans `custom_message` workflow entries after the latest `compaction` or `branch_summary` entry. Every lifecycle record carries a SHA-256 revision of the normalized workflow definition. Current-format compatibility requires matching workflow ID, status, route-tail stage, and definition revision. A current-format state without a compatible lifecycle record receives one checkpoint.

Catalog activation options are filtered through `workflows`. A resolved agent policy can hide every workflow tool without deleting the saved workflow state. When a later compatible policy restores `workflow_transition`, the saved route remains available for continuation.

## Session snapshots

Catalog activation stores an `activated` snapshot with the validated workflow definition, route, and pre-workflow restoration settings. Dynamic creation stores the same data in a `created` snapshot. Stage edits store the stage ID and normalized replacement fields. Transition snapshots contain only `kind: "transitioned"` and the updated `route`. The extension preserves the workflow source and restoration settings. It omits the selected ground from workflow-state snapshots. Completion stores a `completed` snapshot with the final route. Stored workflow definitions preserve stage triggers, but replaying snapshots never executes them.

For snapshots with `journalVersion: 1`, the validator applies the format-version rules to saved catalog and dynamic definitions. The extension restores unversioned definitions as format 1. For format-2 definitions, the extension restores `version: 2`, stage goals, and transition grounds. In both formats, the extension restores the saved route. The workflow format version is independent of `journalVersion`.

The active branch reconstructs state on session start and branch changes:
- `activated` restores catalog-backed active state and its restoration settings;
- `created` restores dynamic active state and its restoration settings;
- for a `stage_edited` entry, the extension replaces `description`, `prompt`, and `model.thinking` in the preceding active dynamic snapshot. For format 2, it also replaces `goal`;
- `transitioned` updates the route of the preceding snapshot;
- `completed` restores completed state and the persisted pre-workflow runtime settings without applying final-stage settings.

When tree navigation leaves an active workflow, the extension reconstructs the target branch model from `model_change` entries or assistant messages and its thinking level from `thinking_level_change` entries. Target branch entries override the abandoned workflow restoration snapshot independently, so a branch that changes only model or only thinking retains that explicit value.

The latest valid active snapshot remains available under every resolved policy after its catalog file is removed or the catalog becomes invalid. An invalid catalog prevents new creation and activation but does not block transitions of that saved active workflow. Earlier replaced dynamic workflows do not appear in activation options and cannot be reactivated.

## CLI flags

The workflow extension registers no CLI flags. The `--trigger <type>` flag is owned by the `algorithms` extension and runs a registered algorithm at startup; see `docs/extensions/algorithms.md`.
