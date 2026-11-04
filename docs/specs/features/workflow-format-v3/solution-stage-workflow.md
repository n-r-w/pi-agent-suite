# Technical Solution: Workflows started at stage entry

## Problem Statement
An agent can do the work of a stage without the nested workflow that the stage prompt names for this work. Problem: [problem-stage-workflow.md](problem-stage-workflow.md). Requirements FRQ-01 to FRQ-03 and critical scenarios: [prd-stage-workflow.md](prd-stage-workflow.md). This solution extends [solution.md](solution.md) and [solution-transition-workflow.md](solution-transition-workflow.md).

## Proposed Solution
A stage of a format 3 catalog workflow gets an optional field `workflow` with the ID of a nested catalog workflow. After each stage entry, the extension starts this workflow as an ordinary nested start of the author: without a pending transition and without the `workflows` policy of the agent, as for a bound workflow.

### Format and validation
- The field requires format 3 and a catalog file. Formats 1 and 2 and `workflow_create` reject it as an unsupported key, because no requirement needs it outside catalog stages.
- The catalog loader checks stage workflows by the rule of transition bindings: the named workflow exists and has `nested: true`, and a file that names a skipped workflow is skipped too.

### Start at stage entry
- Each stage entry first publishes its record as before: the activation record of the workflow, the stage-activation record after a transition, or the stage-activation record after an exit with permission. The stage triggers run next. Then the extension starts the stage workflow and publishes its activation record, so the agent reads the stage prompt before the stage workflow.
- A start enters the initial stage of the stage workflow, so the same rule applies to it, and a chain of such starts ends when an entered stage names no workflow.
- An ordinary exit of the stage workflow resumes the waiting stage without a new start (FRQ-02).

### Rejection
Before the first change of state of an entry, the extension computes the chain that the entry and its stage workflows would give and rejects the entry when a stage workflow is absent from the catalog or already runs in the chain (FRQ-03). The check runs for activation, for a transition, also a bound one, whose target stage it checks before the bound workflow starts, for the start of a bound workflow, and for an exit with permission, where the catalog can differ from the one at the request after a reload.

### Saved state
The start of a stage workflow is an ordinary `activated` entry of journal version 2, and the stage field is part of the saved definition. Replay, restoration, and `workflow-status.ts` need no change.

### Critical scenarios
| Scenario | Methods that run it |
|---|---|
| SCN-01 | `workflow_activate`, start of the stage workflow after the activation record, ordinary `workflow_exit` |
| SCN-02 | `workflow_transition` with `rework`, `workflow_exit` with `allow: true` |
| SCN-03 | Check of the projected chain before any change of state |

## Overengineering and Overspecification Considerations
- No support in `workflow_create`: no requirement needs it.
- No mark of the stage workflow in the stage record: the activation record of the stage workflow follows it in the same tool result.
- No static check of cycles between stage workflows: the runtime rejection covers them, as for bound transitions.

## Open Questions
No open questions.

## References
- [solution.md](solution.md)
- [solution-transition-workflow.md](solution-transition-workflow.md)
- `pi-package/extensions/workflow/` - the workflow extension that this solution changes.
