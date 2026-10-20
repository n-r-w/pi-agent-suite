# Idea: Workflow format version 2

## Definitions
Terms of this feature are defined in [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md). In short: a reuse entry gives the agent no stage goal, the list of available transitions gives the agent no conditions of transitions, and the workflow format has no elements for either that the extension could render.

## Goal
In a workflow that declares format version 2:
- on each entry into a stage, the agent receives the stage goal;
- the agent chooses each transition by its declared conditions, which it sees next to the transition.

Workflows without a declared version keep their current format and behavior. The agent guidance states the difference between a stage goal and a stage task.

## Scenarios
1. An author writes a catalog workflow with format version 2, a goal for each stage, and grounds for its transitions. The agent receives each goal on the first entry into its stage and again on each reuse entry, and it sees the grounds of each available transition.
2. An agent returns to a known stage through a rework transition. It names the ground of the transition, receives the goal of the stage, and sees the grounds of the transitions that lead out of it.
3. A situation fits no ground of any available transition. The agent stops and describes the situation in its reply.
4. An existing catalog workflow without a format version loads and runs as before.
5. An author adds a goal or grounds to a workflow without a format version. The catalog rejects the file and names the reason.
6. An agent creates a workflow through `workflow_create`. The created workflow has format version 2.
7. A user resumes a session that was saved before the change. The saved workflow continues with format version 1.

## Scope and Non-Scope
In scope:
- Format version of catalog workflow files.
- Stage goals and transition grounds in catalog workflows of format version 2 and in workflows created through `workflow_create`.
- Stage goals and transition grounds in model-facing workflow records.
- Choice of a ground in `workflow_transition`.
- Reading and editing a stage goal through `workflow_get_stage` and `workflow_edit_stage`.
- Restoration of saved sessions with and without a format version.
- Agent guidance on the difference between a stage goal and a stage task, and on a situation that fits no ground.

Non-scope:
- Conversion of existing catalog files to format version 2. Authors convert their files themselves.
- The periodic `<workflow_reminder>` record.
- A check that the stage prompt of format version 2 repeats neither the stage goal nor the conditions of transitions.
- A technical check of user approval, for example a confirmation dialog or a check of the user's words.
- A state of stage results that a rework transition makes outdated.

## Requirements

### Functional Requirements
- [X] FRQ-01: A catalog workflow file can declare its format version. A file without this declaration has format version 1. The catalog accepts versions 1 and 2 and rejects a file with any other value, with an error that names the value.
  - Origin: source. The user chose a format version as the way to add required elements without breaking existing catalog files.
  - Goal: Workflows without a declared version keep their current format and behavior.
  - Goal achievement: Full. A file declares the new format explicitly, so an undeclared file stays in the old format.
  - Feasibility: Confirmed. The catalog already validates each workflow file against a closed set of fields, so a new optional field and its allowed values fit this validation.
- [X] FRQ-02: A catalog workflow of format version 1 loads and produces the same model-facing records as before the change. A stage goal or a transition ground in a workflow of format version 1 makes the catalog reject the file, with an error that says that this element requires format version 2.
  - Origin: source. The user chose that format version 1 stays exactly as it is now.
  - Goal: Workflows without a declared version keep their current format and behavior.
  - Goal achievement: Full. Format version 1 has exactly one form, and a rejected file tells its author which version to declare.
  - Feasibility: Confirmed. The catalog already rejects fields that the format does not define.
- [X] FRQ-03: In a catalog workflow of format version 2, each stage has a non-empty stage goal. A stage without a goal makes the catalog reject the file, with an error that names the stage.
  - Origin: source. The user asked for a goal that format version 2 requires.
  - Goal: The agent receives the stage goal on each entry into a stage.
  - Goal achievement: Full. A workflow of format version 2 cannot load without a goal for each stage.
  - Feasibility: Confirmed. The catalog already rejects a stage without a required field, for example without a prompt.
- [X] FRQ-04: For a workflow of format version 2, each record that contains the complete stage prompt also contains the stage goal as a separate element before the prompt. These records are the inline entry, the checkpoint after compaction for the active stage, and the stage update after `workflow_edit_stage`.
  - Origin: formulated. The stage goal leaves the stage prompt in format version 2, so records with the complete stage text must show it separately.
  - Goal: The agent receives the stage goal on each entry into a stage.
  - Goal achievement: Full. Every record that shows a stage in full shows its goal.
  - Feasibility: Confirmed. The extension builds each of these records from the stage definition, which holds the goal in format version 2.
- [X] FRQ-05: For a workflow of format version 2, a reuse entry contains the stage goal and the available transitions, without the stage prompt.
  - Origin: source. The user chose to keep the reuse entry without the stage prompt and to remind the agent of the stage instead.
  - Goal: The agent receives the stage goal on each entry into a stage, and the context receives no copy of a stage prompt that it already holds.
  - Goal achievement: Full. A rework transition into a known stage shows its goal, and the record grows only by the goal text and the grounds of FRQ-07.
  - Feasibility: Confirmed. The reuse entry is built from the stage definition, and the stage definition of format version 2 holds the goal.
- [X] FRQ-06: In a workflow of format version 2, a transition can declare grounds. Each ground has an ID that is unique within its transition and a non-empty condition text. Grounds are required on each `rework` transition, and on each `advance` transition of a stage that has more than one `advance` transition. The only `advance` transition of a stage can have no grounds; then it is an unconditional transition. A transition without required grounds makes the catalog reject the file, with an error that names the transition.
  - Origin: source. The user proposed predefined grounds of transitions and chose that only the single `advance` transition of a stage can be unconditional.
  - Goal: The agent chooses each transition by its declared conditions.
  - Goal achievement: Full. Each transition where the agent must choose has its conditions in the format.
  - Feasibility: Confirmed. The catalog already validates each transition and the transition graph of a stage.
- [X] FRQ-07: For a workflow of format version 2, each record that lists the available transitions also lists the grounds of each transition with their IDs and condition texts. This includes the reuse entry.
  - Origin: formulated. The agent needs the conditions at the moment when it chooses a transition, and every stage entry record lists the available transitions.
  - Goal: The agent sees the conditions of transitions next to the transitions.
  - Goal achievement: Full. No record shows a transition without its conditions.
  - Feasibility: Confirmed. All these records render the available transitions from the workflow definition, which holds the grounds in format version 2.
- [X] FRQ-08: For a transition with grounds, `workflow_transition` requires the ID of one ground of this transition. A missing or unknown ID rejects the call, with an error that lists the ground IDs of this transition. For an unconditional transition, `workflow_transition` rejects a ground ID.
  - Origin: formulated. The agent takes a transition by naming the condition that holds, and the extension can check only an ID that the format declares.
  - Goal: The agent chooses each transition by its declared conditions.
  - Goal achievement: Partial. The extension checks that the named ground exists, and only the agent judges whether its condition holds.
  - Feasibility: Confirmed. `workflow_transition` already validates its target against the available transitions.
- [X] FRQ-09: While workflow tools are active, the agent guidance states, in at most four sentences:
  - a stage goal is the state that must hold when the stage ends;
  - a stage task is the actions that reach this state;
  - a stage is complete when its goal state holds, and finished actions alone do not complete it;
  - when the situation fits no ground of any available transition, the agent takes no transition and describes the situation in its reply.

  The description of the stage goal in `workflow_create` gives authors the same explanation of goal and task with one example of a goal.
  - Origin: source. The user stated that LLMs confuse a goal with a task and asked for a short and explicit explanation of the difference. The rule for a situation without a fitting ground follows the user's decision that the agent does not invent grounds.
  - Goal: The agent reads the stage goal as a state to reach and does not take a transition without a fitting condition.
  - Goal achievement: Partial. The explanation is visible to the agent, but whether the agent applies it depends on the model.
  - Feasibility: Confirmed. The extension already contributes shared guidance to each workflow tool and a description to each tool input.
- [X] FRQ-10: A workflow created through `workflow_create` has format version 2 and follows FRQ-03 and FRQ-06. `workflow_get_stage` returns the goal of the stage, and `workflow_edit_stage` replaces it together with the other stage fields.
  - Origin: source. The user chose that workflows that an agent creates also get the stage goal.
  - Goal: Workflows that an agent creates give the agent the same goals and conditions as catalog workflows.
  - Goal achievement: Full. A created workflow cannot have a stage without a goal or a transition without required grounds.
  - Feasibility: Confirmed. Each tool call receives the current tool schema, so a changed tool input breaks no saved file.
- [X] FRQ-11: A session saved before the change restores its workflow with format version 1 and continues on the saved route. A session saved after the change restores the format version, the stage goals, and the transition grounds of its workflow.
  - Origin: formulated. Saved sessions store the complete workflow definition, and the definitions saved before the change have no format version, stage goals, or transition grounds.
  - Goal: Existing users of the package continue their sessions after an update.
  - Goal achievement: Full. Each saved definition restores in the format in which it was saved.
  - Feasibility: Confirmed. Restoration already validates each saved definition, so a definition without a version follows the rules of format version 1.

- [X] FRQ-12: When `workflow_transition` selects a declared ground, its custom Pi UI appends `Ground` after `From` and `To`. Compact mode shows only the selected condition. Expanded mode shows `--- Ground ---` followed by the selected ID, ` · `, and condition. For example, the compact row is `Ground: A finding needs units that inspection did not cover.` and the expanded value is `finding_needs_uncovered_units · A finding needs units that inspection did not cover.` Main and subagent screens use one shared renderer to show the choice on the first live or replay render; screen-specific copies of the rendering logic are excluded.

  The extension captures the selected ID and validated condition from the matching source-to-target transition before execution changes the route. It saves the pair with the endpoints in tool-result `details` and restores it after JSON serialization. When the source workflow is inactive or its definition has changed, the renderer still uses the saved pair. For unconditional transitions, the renderer omits `Ground`. When saved presentation metadata has no ground, the renderer displays the saved endpoints without reconstructing a ground or showing an ID-only ground. Each ground in a validated definition requires an ID and non-empty `when` text; only the earlier presentation metadata omitted the selected ground.

  The renderer uses the shared reference wrapping and a separate four-visual-line compact budget for `Ground`, excluding the tool title and hidden-line hint. Expanded mode preserves source line breaks and displays all wrapped lines. Transition execution and tool input schemas remain unchanged. Workflow-state transition records contain only `kind: "transitioned"` and the updated `route`.
  - Origin: source. The user approved displaying the selected declared transition ground.
  - Goal: The user sees which declared condition the agent selected.
  - Goal achievement: Full. The UI displays the selected condition independently of active workflow state or later definition changes.
  - Feasibility: Confirmed. Transition presentation already captures endpoints before route mutation and restores them for replay.

### Non-Functional Requirements
- [X] NRQ-01: Each catalog workflow file that loads before the change loads after it, and each of its model-facing records has the same text as before the change. Verification: the existing workflow tests pass without changes of their expected records for workflows without a format version.
  - Origin: formulated. The user required backward compatibility for people who already use the package.
  - Goal: Workflows without a declared version keep their current format and behavior.
  - Goal achievement: Full. Unchanged records mean that agents of existing users see no change.
  - Feasibility: Confirmed. Format version 1 adds no field and no record element.

## Open Questions
None.

## Technical Supplement
Catalog YAML representation discussed with the user:

```yaml
version: 2
description: Example workflow
stages:
  - id: align_solution
    description: Agree technical solution
    goal: User confirmed `TECHNICAL SOLUTION` after seeing its text in message.
    prompt: |-
      Actions:
      1. Compose `TECHNICAL SOLUTION` from confirmed requirements.
      2. Show it to user and ask for confirmation.
    initial: true
  - id: implement
    description: Implement plan
    goal: Each unit of approved plan is done and committed.
    prompt: |-
      Actions:
      1. Assign each unit to its agent type.
    final: true
transitions:
  - from: align_solution
    to: implement
    type: advance
  - from: implement
    to: align_solution
    type: rework
    grounds:
      - id: approach_missing
        when: A unit needs an approach that `TECHNICAL SOLUTION` does not have, for example a fix of existing code that needs a new mechanism.
      - id: user_changed_approach
        when: User asks to change approach.
```

A reuse entry of stage `align_solution` and a transition call could look like this:

```xml
<workflow_stage_activated workflow_id="Example" stage_id="align_solution" guidelines="reuse">
  <stage_goal>User confirmed `TECHNICAL SOLUTION` after seeing its text in message.</stage_goal>
  <available_transitions>
    <transition to="implement" type="advance" />
  </available_transitions>
</workflow_stage_activated>
```

```text
workflow_transition(stageId: "align_solution", ground: "approach_missing")
```

The project rule on tests applies: tests check the logic of records, for example the presence of the goal element in a reuse entry of format version 2 and its absence in format version 1, and never the text of prompts.

## References
- [docs/extensions/workflow.md](../../../extensions/workflow.md), sections "Provider context" and "Session snapshots".
