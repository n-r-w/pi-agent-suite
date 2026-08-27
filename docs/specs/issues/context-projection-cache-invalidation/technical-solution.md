# Technical Solution: Projection Threshold Checkpoints

## Problem Statement

- PRB-01: Repeated projection discovery inside one active level can change old provider-context messages on consecutive requests.
- PRB-02: Usage reduction after projection can move remaining tokens above the crossed threshold and later cross it again.

## Proposed Solution

- SOL-01: Compute the active level from projection-aware remaining tokens on every `context` event.
- SOL-02: Store `appliedLevel` as `L1`, `L2`, or `L3` in the existing `context-projection` custom session entry.
- SOL-03: Run new projection discovery only when the active level is deeper than `appliedLevel`.
- SOL-04: Persist the crossed level even when its projection batch contains no entries.
- SOL-05: Replay existing replacements on every request without discovering new entries inside an applied level.
- SOL-06: When one request jumps across multiple thresholds, run one batch using the deepest reached level and persist that level.
- SOL-07: Keep `appliedLevel` monotonic until successful compaction. Usage moving above an applied threshold does not lower it.
- SOL-08: Reset level reconstruction at the latest `compaction` entry in the active branch.
- SOL-09: Reconstruct replacement mappings and `appliedLevel` on `session_start`, `session_tree`, and `session_compact`.
- SOL-10: Projection entries without `appliedLevel` continue to restore their replacements and do not claim a crossed threshold.
- ACC-01: Repeated L1 requests append no projection state after the first L1 checkpoint.
- ACC-02: A transition from L1 directly to L3 appends one L3 state entry and runs discovery with L3 criteria.
- ACC-03: A successful compaction permits the next reached level to run once in the new cycle.
- ACC-04: Switching branches restores the selected branch's checkpoint.

## Overengineering and Overspecification Considerations

- TRD-01: Runtime threshold checks compare two values and do not scan session history.
- TRD-02: Applied-level restoration adds one branch scan during `session_start`, `session_tree`, and `session_compact`. It adds no branch scan to `context` events.
- TRD-03: Each compaction cycle adds at most three small checkpoint entries.

## Open Questions

None.

## References

- REF-01: `pi-package/extensions/context-projection/index.ts` - Owns lifecycle state and threshold-transition discovery.
- REF-02: `pi-package/shared/context-projection.ts` - Parses and reconstructs projection session state.
- REF-03: `pi-package/extensions/context-projection/index.test.ts` - Covers repeated levels, direct jumps, branch restoration, and compaction reset.
