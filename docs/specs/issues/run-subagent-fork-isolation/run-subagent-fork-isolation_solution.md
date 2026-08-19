# Technical Solution: Pi fork isolation for subagent sessions

## Problem Statement

- PRB-01: Pi creates a root fork with a new session ID but copies `run-subagent` journal records with the previous owner IDs and child session file paths.
- PRB-02: Reconstruction preserves the previous keys, so inherited sessions are inaccessible through the subagent tools and management screen.
- PRB-03: Copying the complete current child file violates historical consistency when a child continuation occurred after the selected root fork point.
- CNS-01: The solution handles subagent sessions whose latest state is `terminal-success`. Sessions in `terminal-failure` or `terminal-aborted` are outside the approved scope.
- CNS-02: Compatibility with journals that do not contain a persisted `leafId` is not required.

## Proposed Solution

### Solution overview

- DEC-01: Use the approved O9-1 approach: persist `leafId` at terminal completion and recursively create branched child session files.
- SOL-01: Every `terminal-success` record stores `childLeafId`, obtained from the child Pi process through `get_entries`.
- SOL-02: The `session_start` handler uses the event `reason`. For `reason: "fork"`, it materializes an independent hierarchy before normal runtime reconstruction.
- SOL-03: For every inherited session, `SessionManager.createBranchedSession(childLeafId)` creates a new file and Pi session ID without changing the source file.
- SOL-04: After nested sessions are cloned, the new owner file receives an owner snapshot containing its direct child sessions with rebased identities.
- SOL-05: The root owner snapshot is appended last. Existing reconstruction, catalog, tools, and management projection then operate on the forked hierarchy.

### Data flow

- DGM-01:

```text
subagent terminal completion
  -> get_entries
  -> childLeafId
  -> terminal record in the owner journal

session_start reason=fork
  -> retained root branch journal
  -> recursive createBranchedSession(childLeafId)
  -> owner snapshots with forked identities
  -> normal SessionStore reconstruction
  -> forked session catalog
```

### Journal model

- ENT-01: `LogicalSession` gains `childLeafId`. The field is present when the latest session state is `terminal-success` and that state was created after this change.
- EVC-01: A `terminal` record requires `childLeafId` only when its state is `terminal-success`. Records for `terminal-failure` and `terminal-aborted` remain unchanged.
- EVC-02: A new owner snapshot record contains `ownerPiSessionId` and the complete list of that owner's direct `LogicalSession` values.
- EVC-03: During journal folding, the last owner snapshot replaces session state derived from earlier records. Normal records after the snapshot apply to that snapshot.
- EVC-04: The snapshot preserves `ownerLocalSessionId`, agent identity, task name, terminal invocation metadata, state, and `childLeafId`.
- EVC-05: The snapshot replaces `SessionKey.ownerPiSessionId`, `childPiSessionId`, `childSessionFile`, and `childSessionDir` with values from the forked hierarchy.
- EVC-06: The snapshot omits `ownerRuntimeLeaseId` because a completed hierarchy has no live relationship with the source owner process.

### Capturing the child session point

- ALG-01: `InvocationSupervisor` obtains `leafId` after the final child event while the child process remains available.
- STP-01: `InvocationSupervisor` calls the existing `get_entries` command.
- STP-02: `InvocationSupervisor` adds the returned `leafId` to the terminal invocation event.
- STP-03: `SubagentCoordinator` appends `childLeafId` with the `terminal` journal record.
- STP-04: `SessionStore.fold` updates `LogicalSession.childLeafId` only when the terminal record's `invocationId` matches the logical session's invocation ID.
- FLR-01: The coordinator does not append a `terminal-success` record without `childLeafId`. A checkpoint read failure uses the existing child runtime failure path.

### Recursive hierarchy cloning

- ALG-02: A focused hierarchy cloner receives the forked root `SessionManager` and materializes the new hierarchy from descendants to ancestors.
- STP-05: The cloner folds the retained branch journal for one owner.
- STP-06: For every direct child whose latest state is `terminal-success`, the cloner opens `childSessionFile` and calls `createBranchedSession(childLeafId)`. Sessions in other states are outside the cloning scope.
- STP-07: The cloner folds the new child branch and recursively clones its direct descendants.
- STP-08: After the descendants are prepared, the cloner appends the new child owner's snapshot.
- STP-09: The cloner creates the rebased direct `LogicalSession`, preserving the owner-local ID and replacing the child session identity and path.
- STP-10: After every direct child is prepared, the cloner appends the current owner's snapshot.
- STP-11: The cloner does not read or apply `maxDepth` while traversing retained sessions.

### Historical consistency

- SOL-06: The terminal record after answer A stores `childLeafId=A`.
- SOL-07: Continuation B modifies the source child file and later stores `childLeafId=B` in a new terminal record.
- SOL-08: A retained root branch selected before B contains `childLeafId=A`, so `createBranchedSession(A)` copies only the child branch through A.
- SOL-09: Nested journals are stored in child session branches, so the same algorithm applies recursively without a global mapping registry.

### Failure handling and integrity

- FLR-02: A missing source file, missing `childLeafId` for a `terminal-success` session, or `createBranchedSession` failure stops hierarchy materialization. Falling back to the source file's current leaf is prohibited because it would violate historical consistency.
- FLR-03: The parent owner snapshot is appended only after every descendant hierarchy is prepared. The journal never receives a parent reference to a partially prepared child hierarchy.
- LIM-01: `SessionManager` does not provide a transaction across multiple files. A process failure between child file creation and parent snapshot append can leave an unreferenced file but does not modify the source hierarchy.

### Affected components

- CMP-01: `invocation-contracts.ts`, `invocation-supervisor.ts`, and `coordinator.ts` carry `childLeafId` from child Pi to the terminal journal record.
- CMP-02: `domain.ts` and `journal-codec.ts` define and validate the checkpoint field and owner snapshot record.
- CMP-03: `persistence.ts` applies the owner snapshot as the new base state for an owner.
- CMP-04: A new focused module performs recursive cloning through the public `SessionManager` API.
- CMP-05: `index.ts` passes the `session_start` event and invokes cloning only for `reason: "fork"`.

### Verification

- ACC-01: A behavior test creates isolated root and child sessions through the public `SessionManager`, emits an actual `session_start` event with `reason: "fork"`, and verifies access through preserved owner-local IDs.
- ACC-02: An A/B test proves that the source child file contains A and B while a root fork selected before B contains only A.
- ACC-03: A nested `terminal-success` hierarchy test proves that every inherited level has a new Pi session ID and an independent file.
- ACC-04: A test with `maxDepth: 0` proves that the complete retained hierarchy is inherited.
- ACC-05: `subagent_steer`, `subagent_wait`, and `subagent_query` do not return `not_owner` for an inherited direct session.
- ACC-06: `subagent_start` assigns an owner-local ID after the maximum inherited direct ID.
- ACC-07: Continuing the source child does not change the forked file, and continuing the inherited child does not change the source file.
- ACC-08: Codec and fold tests prove that an owner snapshot excludes the previous owner keys.
- DOD-01: The change passes `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify`.

## Overengineering and Overspecification Considerations

- TRD-01: The solution stores one `leafId` string per terminal completion instead of a complete child session copy.
- TRD-02: The solution uses `SessionManager.createBranchedSession` and does not rewrite JSONL directly.
- TRD-03: Each owner stores its own snapshot. No external registry or nested access to root state is required.
- TRD-04: The solution does not clone `terminal-failure` or `terminal-aborted` sessions and does not add compatibility for previous journals.
- TRD-05: The solution does not add a cross-file transaction or orphan-file collector because neither is required for correctness within the approved scope.

## Open Questions

None.

## References

- REF-01: `docs/specs/issues/run-subagent-fork-isolation/run-subagent-fork-isolation_problem.md` - Approved problem statement.
- REF-02: `docs/specs/issues/run-subagent-fork-isolation/domain-glossary.md` - Domain definitions.
- REF-03: `docs/specs/issues/run-subagent-fork-isolation/run-subagent-fork-isolation_prd.md` - Approved requirements.
- REF-04: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1077-1169` - `createBranchedSession` behavior.
- REF-05: `pi-package/extensions/run-subagent/persistence.ts:262-432` - Journal folding and recursive reconstruction.
- REF-06: `pi-package/extensions/run-subagent/index.ts:263-332` - `session_start` handling.
