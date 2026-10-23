# Technical Solution: Skill restoration after compaction

> D11 in `decisions.md` supersedes the per-request disk reads and fitting described here. The extension selects files once per compaction and saves them in the session: see `docs/specs/issues/skill-restoration-rereads/solution.md`.

## Problem Statement

See `problem.md` and `requirements.md`. The user requires skill file contents to come from disk and prohibits saving those contents in restoration session records.

## Proposed Solution

### Path-only persistence and disk-backed delivery

A separate skill-restoration extension stores one immutable custom session entry per completed compaction. It associates the latest compaction on the active branch with an ordered list of candidate paths. The entry contains no file contents or saved model message. Paths retain recovery information across repeated compaction and session reopening.

On each context event, the extension reads candidate files from disk, estimates the current complete request, and inserts whole files that fit immediately after the compaction summary. File contents exist only in the request being prepared. The extension does not append them to session history, compaction summaries, diagnostic entries, or persisted delivery decisions.

The extension validates stored path records on session start and tree navigation. A malformed record produces no insertion. Reopening selects the latest compaction's path record on the active branch and reads current files for the next request. There is no content snapshot or persisted fit-decision phase.

### Effective selection and ownership

Pi's completion event can identify an earlier equal summary. The extension therefore selects the latest compaction from the current branch and projects the preceding branch prefix to reconstruct effective pre-compaction messages with context edits.

Successful read loads and skill-command locations supply candidate paths. The preceding path record contributes earlier candidates, including those previously absent from context. Effective successful loads in the retained suffix are excluded. Deduplication preserves most-recent-first priority. These mechanisms meet FRQ-01.

The skill command catalog supplies directory provenance for FRQ-02. Default and metadata loading use skill-file paths; custom resource loaders remain responsible for their declared provenance. The shared skill-path module resolves read arguments and checks lexical containment. A descendant named ..notes.md qualifies, while ../other.md outside the directory does not. No additional symlink policy is introduced.

### Current request budget

For each context event, the available budget is the selected model's context window minus its reserveTokens, keepRecentTokens headroom, and the estimated current request. The estimate includes the runtime system prompt, active tools, summary, retained messages, new input, inserted file framing, and absent-file list. The existing o200k_base estimator supplies token estimates.

Pi hides system messages from ordinary context handlers and can replace the system head after those handlers finish. The extension obtains the merged native head through public session projection and retains the public before_agent_start options object by reference. Later prompt handlers update that same object, so the extension can select Pi's actual native or forced-head transformation, including an empty forced prompt. The reference survives compaction within a run and is replaced at the next run. Numeric regression checks measure the fake provider's final input, rather than reconstructing the estimator's own input.

Files are considered most-recent-first. Files that do not fit remain on the explicit absent-file list. When no file fits, the list is still delivered as FRQ-03 requires. Its irreducible size is an explicit exception to fitting file content within otherwise unavailable space.

A missing file is skipped for the current request; its tracked path remains available if the file reappears. A changed file contributes its current disk contents. If request size, model, tools, or file contents change, the next request can contain a different fitting subset. The absent-file list reflects that request. With identical inputs, selection and message content remain deterministic. Provider cache hits remain provider-dependent.

### Prompt timing evidence

Pi may compact before before_agent_start applies runtime prompt contributions. The initial synthetic timing probe established only that timing difference. A later isolated real AgentSession check loaded the actual package system-prompt extension with a fake provider and large skill fixture. After idle manual compaction, the old implementation selected a file that produced a first-request estimate of 50,874 tokens against a 49,800-token budget; without restoration, the request estimated 3,821 tokens. No actual provider rejection or user-session failure is claimed.

Reading and packing in the current context event uses the runtime prompt and actual request messages. This addresses the measured estimate error without saving file contents or an extra decision entry.

### Configuration, rendering, and package order

Suite storage resolves an enabled-only configuration. Missing configuration enables restoration. Invalid JSON, unknown keys, or an invalid value disable insertion and produce one warning per extension instance.

The path entry renderer uses the latest in-memory delivery metadata for compact counts and expanded returned/absent paths. Before a request has been prepared, it shows tracked paths rather than claiming files have already been restored. Session reopening reconstructs tracked paths; delivery counts become available after the next context event. No file contents enter TUI metadata. Plain custom entries remain excluded from the run-subagent conversation screen.

Package registration places skill-restoration after context-projection and before compaction-trigger. Projection preserves session-message correspondence before insertion, and the trigger can still block the resulting request. The selected-model settings helper already supplies reserveTokens and keepRecentTokens, and existing caller comparison semantics remain unchanged.

Child Pi loads the package explicitly, so the same extension covers subagents. The system-prompt edit removes the post-compaction reread condition and preserves the truncation condition, satisfying FRQ-04. Tests never assert prompt wording.

### Alternatives and costs

Persisting file contents and two-phase snapshot/selection records are rejected by the user's storage constraint. Persisting paths and loading from disk is both smaller and consistent with disk being authoritative. In-memory content caching is unnecessary for this design.

Per-request reads add filesystem work, and file edits can change restored instructions between requests. Repacking can change the inserted subset as request size grows. The extension lists absent paths so the model can identify instructions that are no longer present. No immutable-content or provider-cache guarantee is made.

Restoration records and their raw exports contain paths only. Ordinary read results already present in history remain ordinary session history; restoration adds no new copies of their texts. consult-advisor retains its canonical replay behavior and does not receive the request-only restoration message.

### Dry-run coverage

| Scenario | Outcome |
| --- | --- |
| Read of skill and asset | Effective successful loads become tracked paths; current contents return when they fit. |
| Skill command | The effective location attribute supplies its skill path. |
| Repeated compaction | Earlier tracked paths survive with their priority, including paths previously absent. |
| Native or custom summary | Both paths select the latest active-branch compaction ID. |
| Reopen before any next request | Saved paths allow fresh disk reads without a missing snapshot phase. |
| Tree navigation | The selected branch determines the latest path record. |
| Equal summary text | Branch IDs identify the new compaction. |
| Context edits and retained reloads | Effective messages determine candidates and exclusions. |
| Changed or missing file | Current content is used, or the missing file is skipped. |
| Changed runtime prompt or model | Packing uses the current complete request and selected-model budget. |
| Partial or zero room | Fitting whole files return; remaining readable paths are listed. |

## Overengineering and Overspecification Considerations

One path-only entry serves repeated compaction and reopening. Boundary validation serves external stored/configured data. Current-request packing serves FRQ-03 and the measured timing discrepancy. Shared path rules, selected-model settings, configuration, and TUI behavior remain within the approved scope. No content cache, snapshot phase, fit-decision entry, retry, compatibility format, or provider-specific cache logic is added.

The implementer selects module boundaries, identifiers, message markup, and exact TUI text within these contracts.

## Open Questions

None. The user approved this revised D9 design and resumption with final_only acceptance through O5-1.

## References

- `requirements.md`
- `solution.md`
- `facts.md`
- `target-picture.md`
- `decisions.md`, D9
