# Technical Solution: Stable Skill Restoration Between Compactions

## Problem Statement
See [problem.md](problem.md) and [prd.md](prd.md). Definitions are in [terms.md](terms.md).

## Proposed Solution

### SOL-01: Selection on the first request
For FRQ-01, the `context` handler in `pi-package/extensions/skill-restoration/index.ts` looks up the path record and the selection record of the latest branch compaction through `findBranchRestoration`. When the path record exists and the selection record does not, the handler calls `selectRestoration` in `restoration.ts`. This function reads the candidate files from disk and fits them against the complete request estimate. It returns no selection for a request without a compaction summary, so the handler tries again on the next request.

### SOL-02: Selection record
For FRQ-02, the handler saves the selection with `pi.appendEntry` as a `skill-restoration-selection` entry with the fields `compactionId`, `files` (`path` and `content`), and `absent`. `parseSelectionRecord` validates the entry when the extension reads it back: absolute unique paths, string contents, and exactly these fields. When a selection record is malformed, `findBranchRestoration` reports no selection, and the handler selects again and saves a new record.

### SOL-03: Insertion from the record
For FRQ-03, `insertSelection` in `restoration.ts` inserts one message with the saved files and absent paths right after the latest compaction summary. It performs no size check, so the inserted message stays the same for every request until the next compaction. After `/resume` or tree navigation, the handler finds the selection record of the latest compaction on the branch and inserts it without reading the disk.

### SOL-04: Rendering
The selection record replaces the in-memory delivery metadata of the entry renderer. The extension registers one renderer for path records, which shows tracked paths, and one renderer for selection records, which shows restored and absent counts, the token estimate of the inserted message, and, in expanded mode, the restored and absent paths.

## Overengineering and Overspecification Considerations
- The selection record is the only state that keeps the restored files after `/resume`; the extension holds no in-memory copy.
- The path record stays separate because a second compaction can follow before any request, and the next candidate collection needs the previous candidates.
- Record validation is required because persisted session data has the type `unknown` when the extension reads it back.

## Open Questions
None.

## References
- `pi-package/extensions/skill-restoration/index.ts`: the `context` handler and entry renderers.
- `pi-package/extensions/skill-restoration/restoration.ts`: `selectRestoration`, `insertSelection`, `findBranchRestoration`, and `parseSelectionRecord`.
