# Technical Solution: Pi fork isolation for subagent sessions

## Problem Statement

- PRB-01: Pi creates a root fork with a new session ID but copies `run-subagent` journal records with the previous owner IDs and child session file paths.
- PRB-02: Reconstruction preserves the previous keys, so inherited sessions are inaccessible through the subagent tools and management screen.
- PRB-03: Source file references make the original and forked child hierarchies share mutable state.
- CNS-01: The solution includes only subagent sessions whose latest state is `terminal-success`. Active, `terminal-failure`, and `terminal-aborted` sessions are excluded.
- CNS-02: A copied child can include history later than the selected root fork point because materialization copies its current source branch.

## Proposed Solution

### Solution overview

- DEC-01: At `session_start` with `reason: "fork"`, materialize the retained hierarchy before normal root runtime reconstruction.
- SOL-01: For every included child, open its source `SessionManager`, obtain its current leaf with `getLeafId`, and call `createBranchedSession` with that leaf.
- SOL-02: Materialize terminal-success descendants before their owner, then append an owner snapshot containing the owner's complete rebased direct logical sessions.
- SOL-03: Preserve each session's `ownerLocalSessionId`. Rebase owner and child Pi session IDs, child session files, and child session directories to the independent copied hierarchy.
- SOL-04: Append the forked root owner snapshot last. Existing reconstruction, catalog, tools, and management projection then operate on the forked hierarchy.

### Data flow

- DGM-01:

```text
session_start reason=fork
  -> retained root branch journal
  -> source SessionManager.getLeafId
  -> source SessionManager.createBranchedSession
  -> descendant-first owner snapshots with rebased identities
  -> normal SessionStore reconstruction
  -> forked session catalog
```

### Journal model

- EVC-01: An owner snapshot contains `ownerPiSessionId` and the complete rebased direct `LogicalSession` list for that owner.
- EVC-02: During journal folding, the last owner snapshot is a boundary. Folding clears earlier logical sessions and reconciliation records, applies the snapshot, then applies ordinary records after the snapshot.
- EVC-03: A rebased logical session preserves `ownerLocalSessionId`, agent identity, task name, terminal invocation metadata, and terminal state.
- EVC-04: A rebased logical session replaces `SessionKey.ownerPiSessionId`, `childPiSessionId`, `childSessionFile`, and `childSessionDir` with copied-hierarchy values.
- EVC-05: The snapshot omits `ownerRuntimeLeaseId` because the copied hierarchy has no live relationship with the source owner process.

### Recursive hierarchy materialization

- ALG-01: A focused hierarchy materializer receives the forked root `SessionManager` and processes descendants before owners.
- STP-01: The materializer folds the retained branch journal for one owner.
- STP-02: For every direct child whose latest state is `terminal-success`, the materializer opens the source child manager, gets its current leaf through `getLeafId`, and creates an independent branch through `createBranchedSession`.
- STP-03: The materializer folds each copied child branch and recursively materializes its terminal-success descendants.
- STP-04: After descendants are prepared, the materializer appends the copied owner's snapshot with rebased direct logical sessions.
- STP-05: The materializer does not read or apply `maxDepth` while traversing retained sessions.

### Current-history semantics

- SOL-05: The selected root branch selects direct children whose latest state is `terminal-success` for materialization.
- SOL-06: Each copied child's current source branch recursively selects its direct terminal-success descendants for materialization.
- SOL-07: Every selected child is copied from its active source root-to-leaf branch at materialization time. Child history later than the selected root fork point is included when it is present on that branch.

### Affected components

- CMP-01: `domain.ts` and `journal-codec.ts` define and validate the owner snapshot record.
- CMP-02: `persistence.ts` applies the owner snapshot as the new base state for an owner.
- CMP-03: A focused module recursively materializes current source branches through public `SessionManager` APIs.
- CMP-04: `index.ts` passes the `session_start` event and invokes materialization only for `reason: "fork"`.

### Verification

- ACC-01: A behavior test creates isolated root and child sessions through public `SessionManager` APIs, emits `session_start` with `reason: "fork"`, and verifies access through preserved owner-local IDs.
- ACC-02: A test proves that a root fork can include child history later than the selected root fork point.
- ACC-03: A nested terminal-success hierarchy test proves that every inherited level has a new Pi session ID and an independent file.
- ACC-04: A test with `maxDepth: 0` proves that the complete retained hierarchy is inherited.
- ACC-05: `subagent_steer`, `subagent_wait`, and `subagent_query` do not return `not_owner` for an inherited direct session.
- ACC-06: `subagent_start` assigns an owner-local ID after the maximum inherited direct ID.
- ACC-07: Continuing the source child does not change the forked file, and continuing the inherited child does not change the source file.
- ACC-08: Codec and fold tests prove that the last owner snapshot replaces earlier owner state and ordinary later records apply to it.
- DOD-01: The change passes `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify`.

## Overengineering and Overspecification Considerations

- TRD-01: The solution uses public `SessionManager` branch operations and does not rewrite JSONL directly.
- TRD-02: Each owner stores its own snapshot. No external registry or nested access to root state is required.
- TRD-03: The solution copies only terminal-success sessions and does not add compatibility for previous journals.
- TRD-04: The solution does not add transaction support, orphan cleanup, fallback source references, or other cross-file recovery behavior.

## Open Questions

None.

## References

- REF-01: `docs/specs/issues/run-subagent-fork-isolation/run-subagent-fork-isolation_problem.md` - Approved problem statement.
- REF-02: `docs/specs/issues/run-subagent-fork-isolation/domain-glossary.md` - Domain definitions.
- REF-03: `docs/specs/issues/run-subagent-fork-isolation/run-subagent-fork-isolation_prd.md` - Approved requirements.
- REF-04: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1077-1169` - `createBranchedSession` behavior.
- REF-05: `pi-package/extensions/run-subagent/persistence.ts:262-432` - Journal folding and recursive reconstruction.
- REF-06: `pi-package/extensions/run-subagent/index.ts:263-332` - `session_start` handling.
