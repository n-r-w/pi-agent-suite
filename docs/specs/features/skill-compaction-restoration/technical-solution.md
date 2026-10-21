# Technical Solution: Skill restoration after compaction

## Problem Statement

See `problem.md`. Requirements are in `requirements.md`; `solution.md` supplies the original design. This document records the checked delivery design without changing the agreed behavior.

## Proposed Solution

### Persistent restoration and request insertion

A separate skill-restoration extension owns one immutable restoration record per completed compaction. The record associates the compaction with ordered returned file contents and paths that did not fit. Pi persists custom entries but does not expose their data as model messages, so persistence and model delivery remain separate.

The extension selects the record associated with the latest compaction on the active branch. It validates persisted data when reconstructing state on session start and tree navigation. Malformed data produces no insertion. Its context handler inserts a stable custom message immediately after the corresponding compaction summary. Rebuilding each request produces one insertion, without queuing a turn or sending restoration contents to the summarizer. These mechanisms meet FRQ-01 for repeated compaction and reopened sessions.

### Effective selection and ownership

The latest compaction comes from the active branch, because Pi's completion-event lookup can identify an earlier equal summary. The branch prefix before that compaction can be projected into the effective pre-compaction context. Pi's projection preserves source entries while applying context-edit omissions and replacements.

The extension collects successful read loads and skill-command locations from that effective context, includes files tracked by the preceding restoration record, and excludes files loaded again in the retained suffix. It deduplicates by resolved path and prioritizes recent loads. Skill ownership comes from the skill command catalog's source paths. Default and metadata resource loading provide skill-file provenance; custom resource loaders remain responsible for the provenance they declare.

The path module shared with context-projection resolves read arguments and checks lexical directory containment. A descendant named ..notes.md qualifies, while a path to ../other.md does not. No new symlink ownership policy is introduced. These mechanisms meet FRQ-02.

### Content and budget

The extension reads selected files from disk when compaction completes. Missing files are skipped, and changed files contribute their current content. Stored contents remain stable until another compaction.

The available budget is the model context window minus model-specific reserve tokens, recent-work headroom, and the estimated post-compaction request. The estimate includes system instructions, active tools, summary, retained messages, restoration framing, and the absent-file list. The existing o200k_base estimator supplies token estimates. Files are considered most-recent-first; a file that does not fit remains on the absent-file list. With no room, the list is still delivered as FRQ-03 requires. The list itself has an irreducible size, so the no-room case is an explicit exception to fitting content within otherwise unavailable space.

The shared native-settings helper accepts the selected model and returns both reserve and keep-recent values. All callers migrate together. Compaction-trigger and footer retain their comparison and presentation behavior while using Pi's model-specific values. No new tolerance or headroom setting is introduced.

Stable content supports prompt-prefix reuse but does not guarantee a provider cache hit. Pi has both provider-usage and canonical-estimate accounting paths; the restoration budget uses its explicit request estimate rather than assuming every path counts injected content.

### Configuration, rendering, and loading

Suite storage resolves the enabled-only configuration. Missing configuration enables restoration. Invalid JSON, unknown keys, or an invalid value disable insertion and produce one warning per extension instance. No additional configuration parameter is introduced.

The extension registers a compact count/token summary and an expanded path list with Pi's entry renderer. Plain custom entries remain absent from the run-subagent conversation screen, as the original design specifies.

Package registration places skill-restoration after context-projection and before compaction-trigger. The former preserves source-message mapping before insertion; the latter can still block the entire request. Package-order tests pin this integration. Child Pi already receives the package path, so the same registration covers subagents.

The system-prompt edit removes the instruction to reread after compaction and preserves the truncation condition, satisfying FRQ-04. Tests check restoration logic, never prompt wording.

### Alternatives and costs

A design built from the start would keep instruction resources as first-class Pi context state. That requires changing Pi and is outside the approved task. The selected extension uses existing session and context hooks, so no dependency change is needed.

Appending contents to custom-compaction summaries does not cover native compaction. Sending custom messages can queue delivery or start extra turns. Context insertion with custom-state persistence covers both compaction kinds without either dependency.

Persisted contents increase session-file size and appear in raw session exports. The inserted request message is not a separate persisted transcript entry. consult-advisor continues to use canonical session replay and therefore does not receive the inserted restoration message.

### Dry-run coverage

| Scenario | Design outcome |
| --- | --- |
| Read of skill and asset | Effective read loads qualify under the listed directory and return when they fit. |
| Skill command | The effective user block supplies its skill path. |
| Second compaction | Previous returned and absent paths remain candidates; suffix loads replace earlier occurrences. |
| Native or custom summary | Both completion paths select the latest active-branch compaction. |
| Session reopen or tree switch | Branch-associated records replay without disk rereads. |
| Equal summary text | Branch IDs, rather than summary matching, identify the new compaction. |
| Context edits | Omitted and replaced effective messages determine selection. |
| Partial or zero room | Whole files that fit return; the remaining paths are listed. |
| Main or subagent | Explicit package loading provides the same context handler. |

## Overengineering and Overspecification Considerations

The persisted record serves reopening, branch replay, and repeat compaction. Boundary validation serves stored/configured external input. Budgeting and recent-work headroom serve FRQ-03. Configuration and rendering were approved in the original design. Shared path extraction prevents two ownership rules, and model-aware caller changes keep the threshold inputs aligned. No retry, compatibility format, provider-specific cache logic, or subagent-screen renderer is added.

The implementer selects module boundaries, record names, inserted-message markup, and exact TUI text within these contracts.

## Open Questions

None. Provider cache hits and model compliance with absent-file instructions remain external behavior, not implementation prerequisites.

## References

- `requirements.md`
- `solution.md`
- `facts.md`
- `target-picture.md`
