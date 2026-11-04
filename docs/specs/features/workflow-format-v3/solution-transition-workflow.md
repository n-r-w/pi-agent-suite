# Technical Solution: Checks bound to transitions

## Problem Statement
An agent can take a transition without its stage exit check, also when the check exists as a nested workflow of format 3, and a workflow author describes such a check in two places. Problem: [problem-transition-workflow.md](problem-transition-workflow.md). Approved requirements FRQ-01, FRQ-02, FRQ-06 and critical scenarios: [prd-transition-workflow.md](prd-transition-workflow.md). This solution extends the solution of format 3 ([solution.md](solution.md)) and uses its chain of running workflows, `workflow_exit`, and journal version 2. Terms: [terms.md](terms.md) and [terms-transition-workflow.md](terms-transition-workflow.md).

## Proposed Solution
A transition of format 3 can name a bound workflow. The request of such a transition starts the bound workflow on top of the chain and keeps the requested transition in the element of the bound workflow as a pending transition. The exit from the bound workflow carries permission to continue, and with permission the extension performs the pending transition on the new top in the same tool call.

### Data: pending transition in the chain
The element of the chain that a bound transition started keeps its pending transition: the target stage and the ground of the request. An element that the agent started itself has no pending transition. The pending transition belongs to the bound workflow and leaves the chain with it, so the replacement of the chain by an unmarked workflow drops it without a separate rule.

The invariants of the chain of format 3 keep the pending transition valid until the exit: only the top moves, and the parent waits on the stage from which the agent requested the transition. So the transition that was available at the request is still available at the exit.

### Format and validation
A transition of format 3 gets an optional field `workflow` with the ID of a catalog workflow, for transitions of both types (FRQ-01). Like `nested` and `kind`, the field requires format 3, so files of formats 1 and 2 keep their current validation.

The extension checks a binding where a definition enters, as the format-3 solution checks kinds:
- The catalog loader validates each file alone now. After it has validated all files, it checks the binding of each transition against the loaded workflows: the named workflow exists and has `nested: true`. A file with a broken binding is skipped with a warning, as a file with any other validation error is skipped now, and so is a file that binds a skipped workflow.
- `workflow_create` accepts the field in its transition schema and checks it against the loaded catalog by the same rule. A bound workflow is always a catalog workflow, because the extension starts a workflow by its ID only from the catalog.

Rejected method: a check of the binding only at the request of the transition. A broken binding would then show only when an agent reaches the transition, and every request of it would fail.

### Request of a bound transition
`workflow_transition` validates the request as now: the basis, the target stage, and the ground. For a bound transition, the extension then starts the bound workflow after the rejection of an ID that is already in the chain. The `workflows` policy of the agent definition does not apply: it limits the workflows that the agent starts itself, and the author of the running workflow chose the bound one. Each check runs before any change of state, and a failed check rejects the transition with its own reason, for example that the workflow is already active, so the agent stays on its stage and learns why (FRQ-06). When the start succeeds, the extension appends the bound workflow with its pending transition, takes its snapshot of model settings, and applies the settings of its initial stage, as at any nested start. The parent stays on its stage (FRQ-01).

The extension resolves the bound workflow in the catalog directly, without the activation options. The activation options filter by policy, which does not apply to the bound start, and by the chain. A lookup through them would also give one reason, "not available", for every failed check.

### Exit and permission to continue
`workflow_exit` gets an optional boolean field `allow`. The tool schema stays fixed during a session, as all workflow tool schemas are now, and the extension decides at the call what the field means (FRQ-02):
- The top has a pending transition, and `allow` is absent: the extension rejects the exit, and the bound workflow keeps running. Without the statement, the extension cannot decide the transition.
- The top has a pending transition, and `allow` is `true`: the extension removes the top and performs the pending transition on the new top, as `workflow_transition` performs a transition, with the entry into the target stage and its triggers.
- The top has a pending transition, and `allow` is `false`: the extension removes the top, and the parent is the top on its stage, as at any return of format 3, without the triggers of the stage.
- The top has no pending transition: the extension ignores `allow`, and the exit works as in format 3.

The extension accepts `allow` at any stage of the bound workflow, so the agent can follow an instruction of the user to skip the check or to stop (FRQ-02).

Model settings after the exit follow the rule of format 3: the extension applies the settings of the stage that is active after the exit. With permission, this is the target stage, so the settings change once.

Rejected method: the extension derives permission from a final stage that the author of the bound workflow marks. The agent then cannot refuse on that stage, for example when the user tells it to stop, and an exit from a wrong stage decides the transition without a chance to correct it.

### Saved state
Journal version 2 of format 3 is not released yet: `pi-package/CHANGELOG.md` lists it under `Unreleased`, and no tag contains it. So this solution extends version 2 without a new journal version:
- the start entry of a bound workflow holds its pending transition;
- the exit entry of a bound workflow holds `allow`.

Replay applies an exit entry with `allow` equal to `true` as an exit followed by the pending transition of the removed element. One entry holds both steps, so a saved session never holds the exit without the transition that the agent allowed. Replay keeps its closed key sets and accepts the new fields only in these two entries.

Rejected method: an exit entry followed by an ordinary transition entry. Replay would need no new rule, but a session that ends between the two appends holds the exit without the allowed transition.

`pi-package/extensions/run-subagent/workflow-status.ts` reads these entries to show the stage of a child agent. It applies the pending transition at an exit entry with permission, so that the subagent screen shows the target stage.

### What the agent sees
The records follow the channel of format 3: hidden custom messages that `pi.sendMessage` appends to the session.
- The record of a bound start is the activation record of a nested start, and it also names the pending transition, so the agent knows that its exit decides this transition.
- The record of an exit with permission is the stage-activation record of the target stage, as after a transition. The record of an exit without permission is the stage-activation record of the parent stage, as after any return, and it also states that the transition did not happen.
- The checkpoint after compaction and session restoration names the pending transition next to the bound workflow.
- The bundled descriptions of `workflow_transition` and `workflow_exit` explain that a bound transition starts its bound workflow first, and that `allow` at the exit decides the transition. The descriptions are static, so they do not change the prompt prefix. Users who override these descriptions through `config.json` need the same explanation in their files.

### Critical scenarios
| Scenario | Methods that run it |
|---|---|
| SCN-01 | Bound start at the request of an `advance` transition, exit with `allow` true on the last stage, entry into the target stage |
| SCN-02 | Exit with `allow` false on a middle stage, return record that states the transition did not happen, second bound start at a repeated request |
| SCN-03 | Bound start at the request of a `rework` transition, exit with `allow` true on the initial stage |
| SCN-04 | Check of the running chain at the bound start before any change of state, rejection of the transition with the reason |

## Overengineering and Overspecification Considerations
- Pending transition in the element of the bound workflow: FRQ-01 and FRQ-02 need a transition that waits for the exit; a replacement drops it with the element.
- Field `allow` of `workflow_exit` and the rejection of an exit without it: FRQ-02. The field is ignored without a pending transition, so exits of other nested workflows stay as in format 3.
- Direct catalog lookup with separate checks: FRQ-06 requires the reason of the failure.
- Binding check at loading and creation: validation of external data where it enters; FRQ-06 keeps the runtime checks that depend on the agent.
- One exit entry for the exit and the transition, the pending transition in the start entry, and the change of `workflow-status.ts`: FRQ-11 of format 3, which [prd-transition-workflow.md](prd-transition-workflow.md) applies to the bound workflow.
- Extension of journal version 2 without a new version: version 2 is not released, so no reader of an older version 2 exists.
- Mark of the pending transition in the start record and the checkpoint: FRQ-14 of format 3, the agent learns the state of the chain after each change.
- No mark of bound transitions in the list of available transitions: the agent learns of the bound workflow from the record of its start, and no requirement needs the mark earlier.
- Left to the implementer: the names and XML form of the new parts of the records, the wording of the tool descriptions, and the structure of the pending transition in the journal entries.

## Open Questions
No open questions.

## References
- [solution.md](solution.md) - technical solution of format 3, which this solution extends.
- `pi-package/extensions/workflow/` - the workflow extension that this solution changes.
- `pi-package/extensions/run-subagent/workflow-status.ts` - reader of workflow state entries for subagent screens.
