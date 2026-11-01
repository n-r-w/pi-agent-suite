# Technical Solution: Workflow graph after compaction

## Problem Statement

See [problem statement](problem.md), [terms](terms.md), and the requirements and critical scenarios in [PRD](prd.md).

## Proposed Solution

The workflow extension adds the workflow graph to a checkpoint only when the context that the model will receive holds no graph of this workflow. The extension learns what the model will receive from Pi's session projection, and it publishes the checkpoint as before, as a new entry at the end of the session.

Two facts of Pi support this solution:
- `ctx.sessionManager.buildSessionProjection()` returns the entries that Pi sends to the model, with the compaction summary, the kept entries, and context edits applied. Other code of this package already uses it, for example `pi-package/extensions/skill-restoration/index.ts` and `pi-package/shared/prompt-composition.ts`.
- Pi appends the compaction entry to the session before it emits `session_compact`, so the projection in the handler already shows the context after the compaction.

### SOL-01: Graph in the checkpoint only when the model does not see it

Serves FRQ-01 and FRQ-02.

When the context that the model will receive holds no workflow graph of this workflow, the checkpoint holds `<stages>` and `<transitions>` in the same form as the activation record. Otherwise, the checkpoint holds no graph, as now. The extension renders the graph from the saved workflow state, so the graph includes stage edits. The same rule applies to active and completed workflows.

### SOL-02: Graph visibility from Pi's session projection

Serves FRQ-02.

Before it publishes a checkpoint, the extension reads the projected entries from `buildSessionProjection()`. The graph is visible when a projected workflow record with the same workflow ID has model-visible messages and is either an activation record or a checkpoint that holds the graph. The checkpoint marks in its `details` metadata that it holds the graph, so the check reads metadata only, as journal restoration does now.

The projection includes the kept entries. An activation record or an earlier checkpoint with the graph among the kept entries is therefore visible, and no copy appears. For the same reason, no copy appears after a branch summary: Pi keeps the shared part of the branch in the context, while the extension starts a new context segment at the branch summary.

### SOL-03: Restoration on session start and tree navigation

Serves FRQ-01 and FRQ-02.

The synchronizer of `session_start` and `session_tree` now publishes a checkpoint when the current context segment holds no compatible workflow record. It also publishes one when the model context holds no workflow graph by SOL-02. This checkpoint holds the graph by SOL-01.

In sessions that the new version compacts, the second condition does not hold, because the checkpoint after the compaction already holds the graph. It holds in sessions that the previous version compacted without the graph. Such a session receives one checkpoint with the graph on its first resume, and a later resume adds nothing, because the projection shows the graph.

### SOL-04: Append-only publication

Serves NRQ-01.

The checkpoint with the graph is published as before: as a new session entry at the end of the session. The extension changes no system prompt and uses no `context` event for the graph.

### Rejected methods

- The graph in every checkpoint without a visibility check: the graph appears twice when the activation record or an earlier graph stays among the kept entries. This breaks FRQ-02.
- Visibility from the extension's own context segment, that is, the entries after the latest compaction: this segment excludes the kept entries before the compaction entry. This breaks FRQ-02 in SCN-06 and SCN-07.
- A separate record that holds only the graph: it needs a new record kind with its own deduplication and restoration. SOL-01 covers the same scenarios inside the existing checkpoint.
- The graph in the system prompt, or in a transient message from the `context` event: it changes the beginning of later model requests and invalidates the prompt cache, as PRB-04 and PRB-05 of `tool-prompt-cache-duplication` describe. This breaks NRQ-01.

### Trade-off

In a session that the previous version compacted without the graph, SOL-03 repeats the goal and the guidelines of the active stage once on the first resume, although the old checkpoint already holds them. The graph itself appears once.

### Critical scenarios

- SCN-01: after the compaction, the activation record is not visible, so the extension appends a checkpoint with the graph. The next request holds the graph once, and earlier messages stay unchanged.
- SCN-02: the same for a completed workflow, with a completed checkpoint that holds the graph.
- SCN-03: on resume, the checkpoint with the graph is visible and compatible, so the extension adds no record. The request holds the graph once, and the history stays unchanged.
- SCN-04: on the target branch, its own checkpoint with the graph is visible, so the extension adds no record. When the branch has none, the extension adds one checkpoint with the graph.
- SCN-05: the extension renders the graph from the saved state with the stage edit, so the graph holds the new stage description.
- SCN-06: the activation record is among the kept entries, so the checkpoint holds no graph. The request holds the graph once.
- SCN-07: the earlier checkpoint with the graph is among the kept entries, so the new checkpoint holds no graph. The request holds the graph once.

### Documentation

Section "Provider context" of `docs/extensions/workflow.md` states when a checkpoint holds the graph.

## Overengineering and Overspecification Considerations

- Graph visibility check (SOL-02): FRQ-02 needs it. The case occurs: in 2 of 134 checkpoints in local session history, the activation record stayed among the kept entries.
- Graph mark in checkpoint metadata: SOL-02 needs it to recognize a checkpoint with the graph without parsing XML.
- Second restoration condition (SOL-03): FRQ-01 needs it for sessions that the previous version compacted. Such sessions exist: 54 sessions in local history hold such checkpoints.
- Left to the implementer: the name of the metadata field, the place of the graph elements inside the checkpoint, and the split of the code into functions.

## Open Questions

None.

## References

- [Problem statement](problem.md) - the problem and its evidence
- [Terms](terms.md) - terms of this issue
- [PRD](prd.md) - requirements and critical scenarios
- [Workflow extension documentation](../../../extensions/workflow.md) - section "Provider context"
- [Tool prompt cache duplication: technical solution](../tool-prompt-cache-duplication/technical-solution.md) - PRB-04 and PRB-05
