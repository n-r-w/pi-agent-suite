# Idea: Stable Skill Restoration Between Compactions

## Definitions
See [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md).

## Goal
After a compaction, the agent works with restored skills as if it had read them itself, and does not reread them before the next compaction.

## Scenarios
- The request grows after a compaction up to Pi's compaction threshold.
- A skill file changes or disappears on disk between two compactions.
- The user reopens the session with `/resume` or navigates the session tree.
- The model, system prompt, or tool declarations change between two compactions.

## Scope and Non-Scope
Scope: the selection of restored files, its storage, insertion into requests, entry rendering, tests, and documentation. Candidate collection, configuration, and package order are outside scope.

## Requirements

### Functional Requirements
- [X] FRQ-01: On the first request after a compaction that contains the compaction summary, `skill-restoration` shall read the candidate files from disk and select the whole files that fit below `contextWindow - reserveTokens - keepRecentTokens`, considering files most-recent-first. Readable files that do not fit go to the absent-file list.
  - Origin: source. User decision: decide once after compaction what fits together with the headroom.
  - Goal: Restore as many skills as the context holds without triggering the next compaction at once.
  - Goal achievement: Full. The selection uses the complete first request.
  - Feasibility: Confirmed. The `context` event supplies the complete request.
- [X] FRQ-02: `skill-restoration` shall save the selection in the session: the compaction ID, the path and contents of each restored file, and the absent paths.
  - Origin: source. User decision: store the contents in the session like an ordinary `read` result.
  - Goal: Keep the same restored skills after `/resume` and tree navigation.
  - Goal achievement: Full. The session holds everything the insertion needs.
  - Feasibility: Confirmed. `pi.appendEntry` persists custom entries.
- [X] FRQ-03: In every request after the selection and before the next compaction, `skill-restoration` shall insert the saved files and absent-file list right after the latest compaction summary, whatever the request size, model, prompt, tools, or files on disk.
  - Origin: source. User decision: files placed in the context stay there until the next compaction.
  - Goal: Stop rereads and keep the start of the request unchanged between compactions.
  - Goal achievement: Full. The inserted message depends only on the saved selection.
  - Feasibility: Confirmed. The `context` event can replace request messages.

For FRQ-01 and FRQ-03, when a compaction tracks 19 files and 15 fit on the first request, every later request carries the same 15 files and the same 4 absent paths, also at 340,000 tokens with a 332,000-token limit.

### Non-Functional Requirements
- [X] NRQ-01: Before production edits, behavior tests shall fail for the missing behavior. `bun run verify` shall exit successfully.
  - Origin: source. Project testing and validation rules.
  - Goal: Verify the change through package checks.
  - Goal achievement: Full. The tests check selection, reuse, reopening, and the next compaction.
  - Feasibility: Confirmed. The existing restoration harnesses drive the extension.

## Open Questions
None.

## References
- [skill-restoration](../../../extensions/skill-restoration.md)
- [Technical solution](solution.md)
