# Problem Statement

## Key definitions and abbreviations
See [terms.md](terms.md).

## Context
A user can view a stored `workflow_get_stage` block on the main or subagent screen. The renderer reads the saved stage attributes from presentation metadata in the tool result.

## Observed Problem
In the baseline renderer at commit `9e3cc94`, when a user replays a stored `workflow_get_stage` block whose valid presentation metadata contains `model: {}`, with no source workflow active, the renderer displays only the tool title. Under these replay conditions, it also drops captured edit details when the saved prior thinking value is absent.

## Affected Audience
Users viewing stage inspection or edit blocks on main and subagent screens, either after execution or during replay.

## Evidence
In `pi-package/extensions/workflow/tool-rendering.ts`, the baseline `parseStageContent` requires a non-empty thinking value. As a result, `parseStagePresentation` rejects otherwise valid saved stage attributes with `model: {}`. Without presentation attributes from an active source workflow, `renderWorkflowStageCall` falls back to a title-only display.

The isolated fixtures in `pi-package/extensions/workflow/tool-rendering.test.ts` cover inspection of a restored format-1 dynamic stage without a model override. Inspection returns `model: {}`. Separate fixtures supply saved presentation metadata containing an optional goal and no thinking.

## Impact
The user loses access to the saved description, prompt, and any saved goal or initial/final flags in the tool-call block. The renderer can also hide description and prompt changes from an edit whose prior thinking value is absent.

## Current State
In `pi-package/extensions/workflow/tool-rendering.ts`, `parseStageContent` accepts a model object without thinking. The renderer displays the remaining stage attributes and omits `Thinking`. See [solution.md](solution.md).

## Desired State
When a user views a stored block with valid presentation metadata and no thinking value, the renderer displays the remaining attributes. For an edit with only a known new thinking value, the renderer displays that value without inventing a prior value.

## Problem Boundary
The problem concerns human-readable stage inspection and edit display on main and subagent screens, in compact and expanded modes. Workflow state and runtime model settings are separate from this presentation behavior.

## Assumptions
No assumptions.

## Open Questions
None.
