# Implementation decisions

## D1: Preserve the approved design

Implement the separate skill-restoration extension and the adjacent changes already described in solution.md. No dependency, compatibility, or scope change is authorized by this decision.

## D2: Reconstruct effective pre-compaction history

Use the active branch before its latest compaction to obtain effective messages with context edits. Use the latest active-branch compaction ID rather than the event's summary-matched entry. This uses Pi's existing projection contract and needs no extra model turn.

## D3: Follow declared skill provenance

Use skill command source paths supplied by Pi. Default and metadata resource loading establish skill-file paths; custom resource-loader overrides own their supplied provenance. No new resource-loader integration or heuristic search is added.

## D4: Keep budget estimates explicit

Estimate the complete inserted message and post-compaction request with the shared estimator. Pi's provider usage and canonical estimates differ, so no universal accounting or cache-hit guarantee is assumed. When no files fit, deliver the absent-file list as FRQ-03 requires.

## D5: Preserve omitted paths across compactions

Previous records contribute both returned files and absent paths to candidate selection. Otherwise a second compaction would forget instructions that previously did not fit. Files loaded again in the retained suffix remain excluded.

## D6: Keep environment isolation outside project tests

Validation launched by a subagent omits inherited PI_SUBAGENT_* keys only from the spawned validation process's environment object. The full baseline passes with this isolation. Do not modify project tests or session-wide environment variables for this issue.

## D7: Document export and warning contracts precisely

Raw session exports include persisted restoration records. Only the inserted request message lacks a separate transcript entry. Invalid restoration configuration warns once per extension instance; neighboring configuration readers supply parsing patterns rather than a shared once-only warning contract.

## Open questions

None.
