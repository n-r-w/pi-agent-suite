# Implementation decisions

## D1: Preserve the approved design

Implement the separate skill-restoration extension and the adjacent changes already described in solution.md. No dependency, compatibility, or scope change is authorized by this decision.

## D2: Reconstruct effective pre-compaction history

Use the active branch before its latest compaction to obtain effective messages with context edits. Use the latest active-branch compaction ID rather than the event's summary-matched entry. This uses Pi's existing projection contract and needs no extra model turn.

## D3: Follow declared skill provenance

Use skill command source paths supplied by Pi. Default and metadata resource loading establish skill-file paths; custom resource-loader overrides own their supplied provenance. No new resource-loader integration or heuristic search is added.

## D4: Keep budget estimates explicit

Estimate the complete inserted message and current request with the shared estimator. D9 supersedes both compaction-time packing and the proposed D8 first-context finalization. Pi's provider usage and canonical estimates differ, so no universal accounting or cache-hit guarantee is assumed. When no files fit, deliver the absent-file list as FRQ-03 requires.

## D5: Preserve omitted paths across compactions

Previous records contribute both returned files and absent paths to candidate selection. Otherwise a second compaction would forget instructions that previously did not fit. Files loaded again in the retained suffix remain excluded.

## D6: Keep environment isolation outside project tests

Validation launched by a subagent omits inherited PI_SUBAGENT_* keys only from the spawned validation process's environment object. The full baseline passes with this isolation. Do not modify project tests or session-wide environment variables for this issue.

## D7: Document export and warning contracts precisely

Updated by D9. Raw exports include restoration path records, without file contents added by restoration. The inserted request message has no separate transcript entry. Invalid restoration configuration warns once per extension instance; neighboring readers supply parsing patterns rather than a shared once-only warning contract.

## D8: Capture at compaction and finalize against the first runtime request

Rejected by the user and superseded by D9. Never approved or implemented. Save ordered candidate contents when compaction completes. Finalize fitting at the first subsequent context event using its runtime prompt, tools, and messages, and persist a separate immutable selection entry. Selection references avoid duplicating contents. A session reopened before finalization still has the compaction-time file copies.

Pi performs pre-run compaction before runtime prompt contributions. The initial synthetic timing probe did not establish a package budget failure. A later isolated real AgentSession check loaded the actual package system-prompt extension and reproduced a first-request estimate of 50,874 tokens against a 49,800-token budget after idle manual compaction. Without restoration it estimated 3,821 tokens. This used a large skill fixture and fake provider; no real provider rejection or user-session failure is claimed. Keeping compaction-time packing can therefore overfill the first request. Finalizing only in memory would lose the stable decision after reopening; rereading files later would lose the compaction-time contents. Both alternatives are rejected.

The cost is storing candidate contents even when they do not fit, plus one small decision entry per compaction. The model receives a stable selection after finalization. No dependency or compatibility change is introduced.

## D9: Persist only paths and read contents from disk

The user explicitly prohibits saving skill file contents in restoration session records and requires reading contents from disk. This replaces the original content-bearing record design and rejects D8.

Persist one ordered candidate-path record per compaction. Read current file contents during every context event and pack against the actual runtime system prompt, tools, and messages. Do not persist contents, rendered restoration messages, content snapshots, or fit decisions. No content cache is introduced.

A session reopened later uses current disk contents. Missing paths remain tracked but contribute no content to that request. Changed files or request budgets can change the fitting subset. Renderer counts come from in-memory delivery metadata; before delivery it displays tracked paths. This changes the former stable-content guarantee and adds per-request filesystem reads, while obeying the user's storage constraint and current request budget.

## D10: Estimate Pi's actual final system head through public APIs

Use the public merged session head and the shared before_agent_start options reference to select the same native or forced system head that Pi sends. Preserve that reference through active-run compaction and replace it on the next run. Final-provider numeric tests cover preserved content, sections, tools, later forced prompts, empty forced prompts, next-run replacement, and automatic compaction with continuation.

Estimating only ctx.getSystemPrompt omitted preserved state; estimating only the native head omitted Pi's later forced-prompt transformation. Requiring both estimates would unnecessarily omit fitting files. Public event identity resolves the actual branch, so no dependency change, private access, conservative reserve, or new user-visible behavior is needed.

## Open questions

None. The user approved the D9 technical design and resumption with final_only acceptance through O5-1. D10 implements its existing complete-request budget contract.
