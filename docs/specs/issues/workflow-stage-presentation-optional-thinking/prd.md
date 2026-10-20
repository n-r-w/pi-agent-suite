# Idea: Stage Presentation with Optional Thinking

## Definitions
See [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md).

## Goal
Let users read the available stage attributes in stored inspection and edit blocks when thinking is absent.

## Scenarios
- A user views a stored `workflow_get_stage` block with valid presentation metadata containing a model object without thinking.
- A user inspects a restored format-1 dynamic stage with no model override.
- A user replays saved stage attributes, including an optional goal, without the source workflow active.
- A user views an edit with a known new thinking value and no saved prior value.
- A user replays edit details whose replacement thinking value is absent.

## Scope and Non-Scope
Scope: presentation parsing, attribute selection, regression tests, and documentation. Workflow state, runtime model settings, tool schemas, domain validation, and dependencies are outside scope.

## Requirements

### Functional Requirements
- [X] FRQ-01: When a user views a stored stage inspection block with valid presentation metadata containing a model object without thinking, the renderer shall display `Description`, `Prompt`, and any saved `Goal`, `Initial`, and `Final` attributes on the first render. It shall apply the shared compact budget or expanded sections and omit `Thinking`.
  - Origin: source. [Problem statement](problem.md), Observed Problem and Impact.
  - Goal: Keep the remaining stage attributes visible when thinking is absent.
  - Goal achievement: Full. The user can read the available attributes within the selected display mode.
  - Feasibility: Confirmed. The renderer can select the other saved attributes independently of thinking.
- [X] FRQ-02: When inspection metadata contains a non-empty string thinking value, the renderer shall display that value. The presentation parser shall reject malformed provided thinking values and malformed remaining stage fields.
  - Origin: source. User-approved constraint: accept omitted thinking while validating provided values and remaining attributes.
  - Goal: Preserve display of known thinking values and validation of saved attributes.
  - Goal achievement: Full. Optional thinking leaves validation of supplied values in place.
  - Feasibility: Confirmed. The presentation parser checks supplied values separately from omitted thinking.
- [X] FRQ-03: When saved edit metadata contains a new thinking value and no prior value, the renderer shall display only the new value, without a comparison arrow. When two known values differ, it shall display their old-to-new comparison. When they are equal or the replacement value is absent, it shall omit `Thinking` and preserve the display of other captured changes.
  - Origin: source. [Problem statement](problem.md), Observed Problem and Desired State.
  - Goal: Display edit details using only captured values.
  - Goal achievement: Full. The user sees the known thinking change and other captured changes without an invented prior value.
  - Feasibility: Confirmed. The renderer can distinguish an absent value from a known value when selecting edit attributes.
- [X] FRQ-04: For live results and replay on main and subagent screens, the renderer shall use Pi's default tool shell, the shared compact budget, and terminal-width wrapping. The first render after result delivery shall include the available saved attributes without requiring an expansion toggle.
  - Origin: source. Project rules for consistent main and subagent presentation.
  - Goal: Make optional-thinking display consistent across screens and display modes.
  - Goal achievement: Full. Each screen uses the saved attributes on its first render within the selected mode and terminal width.
  - Feasibility: Confirmed. Main and subagent adapters share the stage renderer, which reads saved attributes when rendering rows.

For FRQ-01, when metadata contains description `Saved stage`, prompt `Saved instructions`, `model: {}`, `initial: true`, `final: false`, and no goal, the renderer displays these compact rows if each row fits on one line:

```text
Description: Saved stage
Prompt: Saved instructions
Initial: true
Final: false
```

If the metadata also contains a goal, the renderer places `Goal` between `Description` and `Prompt` and applies the compact budget. Expanded mode includes all saved attributes as labeled sections. Both modes omit `Thinking`.

For FRQ-03, when the prior metadata contains `model: {}` and the replacement contains `model: { thinking: "high" }`, the renderer displays `Thinking: high` in compact mode. Expanded mode contains a `--- Thinking ---` section with `high` and no comparison arrow. When the prior value is `medium` and the replacement is `high`, the renderer displays `Thinking: medium -> high` in compact mode.

### Non-Functional Requirements
- [X] NRQ-01: The renderer shall use only captured thinking values for display and shall leave workflow state and runtime model settings unchanged.
  - Origin: source. User-approved presentation-only scope.
  - Goal: Keep UI presentation separate from workflow and model state.
  - Goal achievement: Full. Displaying a block neither selects a thinking default nor applies a model setting.
  - Feasibility: Confirmed. The presentation renderer reads captured attributes independently of workflow execution.
- [X] NRQ-02: Before production edits, regression tests shall fail for the missing presentation behavior. Tests shall use Pi's public tool component and isolated fixtures; replay fixtures shall have no active source workflow. Assertions shall check non-prompt attributes and the prompt section's structure while excluding prompt prose.
  - Origin: source. Project testing rules and the replay scenario in the problem statement.
  - Goal: Verify optional-thinking presentation without relying on real sessions or prompt content.
  - Goal achievement: Full. The checks exercise the displayed attributes through the tool component using controlled inputs.
  - Feasibility: Confirmed. Isolated tool-component fixtures can supply saved presentation metadata and render it on fresh screens.
- [X] NRQ-03: `bun run verify` shall exit successfully with zero failing checks. The implementation shall use the declared dependencies and pass linting without suppressions.
  - Origin: source. Project validation rules.
  - Goal: Preserve package validation while correcting presentation.
  - Goal achievement: Partial. Package checks cover regressions and static constraints; FRQ-01 through FRQ-04 define the displayed behavior.
  - Feasibility: Confirmed. The shared renderer and declared dependencies provide the required presentation behavior.

## Open Questions
None.

## Technical Supplement
The regression matrix covers main and subagent adapters, compact and expanded modes, and widths of 22 and 100 terminal columns. Tests supply omitted thinking through restored format-1 stage inspection and through independent presentation metadata. Parser cases include empty strings, null, numbers, booleans, and arrays as thinking values, a null model, and an empty description.

## References
- [Workflow extension](../../../extensions/workflow.md)
- [Technical solution](solution.md)
