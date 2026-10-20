# Technical Solution: Workflow Format Version 2

## Problem Statement
See [problem.md](problem.md) and the agreed requirements in [prd.md](prd.md). Terms are defined in [terms.md](terms.md).
- PRB-01: A reuse entry gives the agent no stage goal, and the workflow format has no goal element that the extension could render.
- PRB-02: The list of available transitions gives the agent no conditions of transitions, and the workflow format has no element for them.
- PRB-03: Existing catalog files and saved sessions have no format version and must keep their behavior.

## Proposed Solution

### SOL-01: Format version as an optional part of the workflow definition
Requirements: FRQ-01, FRQ-02, FRQ-11, NRQ-01.

The workflow definition gets an optional format version. The catalog boundary and the saved-snapshot boundary read it from the root of the definition. The shared domain validator selects the format rules as described in SOL-11. An absent version means format version 1, and the selected rules determine the stage and transition fields that the parser accepts:
- format version 1 accepts exactly the fields that it accepts now, so a goal or grounds in such a file fail the existing closed-field validation; the error message names format version 2 as the version that defines these fields;
- format version 2 additionally accepts the stage goal and transition grounds and applies their rules from SOL-02 and SOL-04;
- any other value fails validation with an error that names the value.

A definition of format version 1 keeps no version value in memory, also when its file states version 1 explicitly. The reason: lifecycle records carry a SHA-256 revision of the serialized definition, and current-format compatibility of a saved session requires a matching revision. If format version 1 definitions gained a stored version, every resumed session would get a mismatching revision and one extra repair checkpoint. Without a stored version, definitions of format version 1 serialize as before, their revision does not change, and their records keep their text.

An invalid file follows the existing catalog behavior: the catalog reports it as invalid and loads the other files.

### SOL-02: Stage goal
Requirements: FRQ-03.

In format version 2, each stage has a required goal with the same text validation as other stage text. The goal is a separate field of the stage, so the extension renders it without parsing the prompt. A stage without a goal fails validation with an error that names the stage.

### SOL-03: Goal in model-facing records
Requirements: FRQ-04, FRQ-05.

The record renderer uses the goal in the validated stage definition. When the stage has a goal, the renderer emits it as its own element:
- before the stage prompt in the inline entry, in the active-stage part of the checkpoint after compaction, and in the stage update record;
- together with the available transitions in the reuse entry, which still omits the stage prompt.

Stages of format version 1 have no separate goal, so the renderer emits the same records as before. The renderer depends on the presence of the goal in the domain model; format selection belongs to the domain validator in SOL-11.

Alternative considered: prepend the goal as text to the stage prompt in the records with the complete stage text. It was rejected because the reuse entry needs the goal as a separate element anyway, and two forms of the same goal would make the records of one stage inconsistent.

### SOL-04: Transition grounds and their validation
Requirements: FRQ-06.

In format version 2, a transition can hold a list of grounds. Each ground has a technical identifier that is unique within its transition and a non-empty condition text. The format-2 validation rules use the outgoing transitions of each stage to check required grounds:
- each `rework` transition has at least one ground;
- when a stage has more than one `advance` transition, each of them has at least one ground;
- the only `advance` transition of a stage can have no grounds.

A violation fails validation with an error that names the transition by its source and target stages. Graph invariants shared by both formats, including reachability, acyclicity, and rework ancestry, remain in the shared graph validator.

### SOL-05: Grounds in the list of available transitions
Requirements: FRQ-07.

The renderer of `<available_transitions>` is shared by the stage entry records, the checkpoint, and the completion record. For a transition with grounds, it renders each ground with its ID and condition text inside the transition element. A transition without grounds keeps its current self-closing form, so records of format version 1 keep their text.

The transition graph in the activation record stays without grounds. The reason: the activation record lists all transitions of the workflow once, and the stage entry that it contains, as well as each later stage entry, already shows the grounds of the transitions available from that stage. Grounds in the graph would repeat the same text for every transition.

### SOL-06: Choice of a ground in `workflow_transition`
Requirements: FRQ-08, FRQ-12.

`workflow_transition` gets an optional ground parameter. It is optional in the tool schema because the same schema serves workflows of format version 1 and unconditional transitions, where no ground exists. The domain transition function checks the grounds of the validated transition together with the target stage. It uses these domain values for both catalog and dynamic workflows:
- a transition with grounds requires a ground ID of this transition, and a missing or unknown ID fails with an error that lists the ground IDs of this transition;
- a transition without grounds fails when the call names a ground.

For FRQ-12, the presentation runtime captures the selected ground ID and validated `when` text from the matching source-to-target transition before execution changes the route. The extension saves this pair alongside the endpoints in tool-result `details`. Workflow-state transition records remain separate: each contains only `kind: "transitioned"` and the updated `route`.

The shared transition renderer appends `Ground` after `From` and `To`. Compact mode displays only the condition, for example `Ground: A finding needs units that inspection did not cover.` Expanded mode displays `--- Ground ---` followed by the selected ID, ` · `, and condition, for example `finding_needs_uncovered_units · A finding needs units that inspection did not cover.`

In `pi-package/extensions/workflow/tool-rendering.ts`, `renderReference` uses the shared labeled wrapping helper for compact rows. The helper reserves space for the label and one separating space on the first row, then uses the shell-provided content width for continuation rows. If the label fills or exceeds the content width, the helper truncates the label and starts the value on the next row. If the label and separator leave no capacity for the value, or the first value character cannot fit the remaining slot, the helper keeps the label and separator on the first row and wraps the complete value on continuation rows. This allocation assumes that each value character fits within the full content width.

The renderer normalizes source line breaks to spaces and shows up to four visual lines per reference, including `Ground`. Each reference has its own budget, excluding the tool title and hidden-line hint. The hint reports the hidden and total line counts. Expanded mode uses Pi's `Text` wrapping at the content width, preserves source line breaks, and displays all lines. Both modes use Pi's default tool shell and the reference styles described in [workflow.md](../../../extensions/workflow.md), section "Tool presentation".

The presentation parser restores the optional ground pair after JSON serialization. The result renderer places the saved values in shared call/result state, and the deferred call renderer reads that state on its first render. Therefore, replay uses the saved condition even when the source workflow is inactive or its definition has changed. Main and subagent screens use one shared renderer, with no screen-specific copies of the transition rendering logic.

For unconditional transitions, the renderer omits `Ground`. When saved presentation metadata has no ground, the renderer displays the saved endpoints. It neither reconstructs a ground from workflow history nor displays an ID-only ground. The domain validator requires an ID and non-empty `when` text for each declared ground; only the earlier tool-result presentation metadata omitted the selected ground.

### SOL-07: Dynamic workflows
Requirements: FRQ-10.

The `workflow_create` boundary always produces a definition of format version 2: its stage schema requires a goal, and its transition schema accepts grounds. Unlike format version 1, the created definition stores its version, so a saved `created` snapshot restores as format version 2 through SOL-08.

- `workflow_get_stage` provides read-only stage inspection:
  - For format version 2, the tool returns `goal` together with the other stage fields in JSON. For a restored format-1 dynamic workflow, it omits `goal`.
  - The tool reads stages only from the active dynamic workflow and leaves workflow state unchanged.
  - The shared renderer places `Goal` between `Description` and `Prompt` in collapsed rows and expanded sections. It uses these attributes for live calls and replay on both main and subagent screens.
  - The extension stores the optional goal in presentation evidence. When saved stage content has no goal, the renderer omits the `Goal` attribute. The collapsed attribute budget remains four visual lines, excluding the title and expansion hint.
  - When saved presentation metadata contains a model object without thinking, the renderer omits `Thinking` and displays the remaining stage attributes. For an edit with only a known new thinking value, the renderer displays that value without a comparison arrow. When two known thinking values differ, it displays their comparison. These presentation rules leave workflow state and runtime model settings unchanged. See the [optional-thinking presentation solution](../../issues/workflow-stage-presentation-optional-thinking/solution.md).
  - When a result contains saved presentation evidence, Pi constructs the call component before invoking the result renderer. The result renderer restores that evidence in the shared render state. Like the transition renderer, the stage renderer reads that state inside its deferred row callback, so the first render after result delivery includes saved attributes without an expansion toggle.
- `workflow_edit_stage` uses the applicable format rules to require a replacement goal for a stage of format version 2 and to reject a goal for a dynamic workflow of format version 1, which can come from a session saved before the change. A format-2 `stage_edited` entry stores the replacement goal, and replay applies it through the same stage-edit validation.
- The description of the stage prompt in the `workflow_create` schema no longer asks for a goal line and a rework-rules section, because the goal and the transition conditions now have their own fields.

Cost: the input of `workflow_create` and `workflow_edit_stage` changes. Agents receive the current schema with each session, so no stored data depends on the old input.

### SOL-08: Restoration of saved sessions
Requirements: FRQ-11.

Saved snapshots are already revalidated against the definition contract on session start and branch navigation. The same version rules from SOL-01 apply there:
- a snapshot without a version restores as format version 1, also a dynamic snapshot from an earlier `workflow_create`;
- a snapshot with format version 2 restores with its goals and grounds.

The journal version of workflow state stays unchanged, because the format version lives inside the saved definition and the snapshot structure around it does not change.

### SOL-09: Agent guidance
Requirements: FRQ-09.

The default prompt that every workflow tool contributes as its shared guidance gets the explanation of the stage goal and the stage task and the rule for a situation that fits no ground. The rule refers only to transitions that list grounds. Transitions of format version 1 and unconditional transitions list none, so a rule about "no fitting ground" without this limit would stop an agent in every workflow of format version 1.

The description of the goal field in the `workflow_create` schema gives authors the same explanation of goal and task with one example of a goal.

Costs:
- The shared guidance reaches agents of every workflow, also of format version 1. It changes the tool guidance and leaves the workflow records of NRQ-01 unchanged. The explanation of goal and task applies to format version 1 as well, because its stage prompts start with a goal by convention.
- A user who replaced the default prompt through `extensionDescriptionPromptFile` does not get the new text until the user updates that file. The documentation states this.

### SOL-09.1: Common formatter delivery prerequisite
Requirements: FRQ-09.

The common system-prompt formatter delivers per-tool shared guidance through `{{toolGuidelines}}`. Workflow agents need this delivery to receive the guidance of FRQ-09. Pi supplies per-tool guidance in `options.toolGuidelines`, keyed by tool name, and global guidance in `options.promptGuidelines`.

In `pi-package/extensions/system-prompt/index.ts`, the `before_agent_start` handler registered by `systemPrompt` reconciles runtime policy and selects tools from `pi.getActiveTools()`. `formatToolGuidelines` reads their contributions in active-tool order, excludes names in `options.hiddenTools`, and appends global guidance. It trims contributions, drops empty results, and retains the first occurrence of each normalized value as one bullet. Individual workflow tool descriptions reach the model separately through the provider tool payload.

The [system-prompt-tool-guidelines solution](../../issues/system-prompt-tool-guidelines/solution.md), SOL-01 and SOL-02, describes formatter delivery and its checks. Synthetic unit fixtures check selection, ordering, normalization, and deduplication. Isolated real-Pi package cases check that a configured shared marker appears once in `before_agent_start.systemPrompt` when workflow tools are active and is absent when policy excludes them. The common formatter covers all tools that supply shared guidance, so a workflow-specific fallback would duplicate delivery logic.

### SOL-10: Documentation and tests
Requirements: all.

`docs/extensions/workflow.md` describes the format version, the stage goal, transition grounds, their place in the records, and the ground parameter of `workflow_transition`, with an example of format version 2.

Tests follow the project rules on test layout, and they check the logic and the structure of records, never the text of prompts:
- parser tests: rejection of a goal or grounds in format version 1, a required goal in format version 2, the rule of required grounds, and an unknown version;
- domain tests: ground checks of transitions;
- record tests: presence of the goal and grounds in records of format version 2;
- tool tests: inputs of `workflow_create`, `workflow_edit_stage`, and `workflow_transition`;
- restoration tests: snapshots without a version, including dynamic ones, and format-2 snapshots followed by stage edits that replace the goal.

The existing tests of format version 1 records keep their expected records unchanged. This verifies NRQ-01.

### SOL-11: Version-specific validation and domain consumers
Requirements: FRQ-01, FRQ-02, FRQ-10, FRQ-11, NRQ-01. Design constraint: the user confirmed localized extension points for later format versions.

The workflow domain validator owns one mechanism for selecting format rules. Catalog loading, dynamic creation, and saved-session restoration use this mechanism. Stage editing uses the rules for the active definition's format. Format-specific parsing and validation stay with those rules, while shared text checks and graph invariants remain common to both formats.

Renderers and runtime operations consume the validated domain model. They use stage goals and transition grounds according to their domain meaning. Version-dependent acceptance rules stay in the domain validator. For example, the record renderer emits a stage goal when the validated stage contains one. Its output depends on these domain values.

Adding another format requires extending the central format selection and implementing its parsing and validation rules. Existing format rules retain their own behavior. If a later format introduces new semantics, its implementation also extends the domain model and the affected consumers.

For example, under SOL-01 a catalog definition with `version: 3` fails validation with an error naming 3. After format-3 support is implemented, catalog loading and saved-session restoration select its rules through the shared mechanism. Dynamic creation continues to produce format 2 until its contract is explicitly changed.

Alternatives considered:
- With versioning present from the start, every normalized definition could retain an explicit version. For this extension, preserving the format-1 representation from SOL-01 keeps saved definition revisions compatible.
- Version comparisons in individual boundaries and renderers would require reviewing each consumer when adding a version. The selected approach keeps format selection in the domain validator and uses the existing domain model for consumers.

Cost: the domain validator must keep common validation separate from format-specific rules. Both supported formats already require this distinction. Format 3 and a general plugin mechanism are outside this change.

## Overengineering and Overspecification Considerations
Elements beyond the smallest change:
- None. Each method above serves at least one agreed requirement or the confirmed extension constraint. Shared format selection serves the two supported formats at the catalog, creation, and restoration boundaries.

Deliberately left out:
- Selected-ground history in workflow-state journal entries. These entries retain their route-only transition representation.
- The activation graph has no grounds, because each stage entry shows the grounds of its available transitions.
- No migration tool converts catalog files to format version 2, because the conversion is out of scope.
- The periodic `<workflow_reminder>` record does not change, because it is out of scope.

Left to the implementer:
- names of the record elements and of the ground parameter;
- length limits of the goal and of the condition text;
- wording of error messages and of the guidance text;
- organization of format-specific rules within the workflow domain, with format selection kept in the shared mechanism of SOL-11.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/workflow/workflow.ts`: workflow definition types, closed-field parsing, graph validation, transitions, stage edits, and snapshot revalidation.
- REF-02: `pi-package/extensions/workflow/context.ts`: model-facing records, known stages, available transitions, and the definition revision.
- REF-03: `pi-package/extensions/workflow/index.ts`: tool schemas and execution of `workflow_create`, `workflow_get_stage`, `workflow_edit_stage`, and `workflow_transition`.
- REF-04: `pi-package/extensions/workflow/config.ts`: catalog loading and reporting of invalid files.
- REF-05: `pi-package/extensions/workflow/prompts/extension-description.md`: default shared guidance of workflow tools.
- REF-06: `docs/extensions/workflow.md`: current behavior of records and snapshots.
