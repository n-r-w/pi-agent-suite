# Problem Statement

## Key definitions and abbreviations
See [terms.md](terms.md).

## Context
`skill-restoration` returns skill files to the model context after compaction. At commit `34cd849`, the extension persisted only candidate paths. For every request, it read the files from disk again and fitted them into the limit `contextWindow - reserveTokens - keepRecentTokens`.

## Observed Problem
In a subagent session of 2026-10-22 with `openai-codex/gpt-6.1-sol`, the context window was 372,000 tokens, `reserveTokens` 20,000, and `keepRecentTokens` 20,000. The restoration limit was therefore 332,000 tokens, and Pi compacted at about 352,000 tokens. While the request grew from 332,000 to 352,000 tokens, the extension moved files from the restored set to the absent-file list. The subagent then read them with `read`: 37 reads of candidate files over 37 compactions, all of them in requests of 330,000 to 347,000 tokens. Below 330,000 tokens, it never reread a candidate file.

## Affected Audience
Main agents and subagents whose requests approach Pi's compaction threshold after a compaction.

## Evidence
After the compaction at session entry 521, requests grew from 98,000 to 316,000 tokens without skill reads. At entry 567, the request reached 331,000 tokens, and the subagent read 13 skill files. Pi compacted at entry 597. The inserted message has no session entry, so the absent-file list is inferred from the match between the 332,000-token limit and the request size of each reread.

## Impact
Each reread adds skill text to the session history as an ordinary tool result. The reads bring the next compaction closer, and after it the extension restores the same files again. Any change of the inserted message also changes the request right after the summary, so the provider cannot reuse its cache for the rest of the request.

## Current State
`skill-restoration` selects the files once, on the first request after a compaction, and saves the selection with file contents in the session. See [solution.md](solution.md).

## Desired State
After a compaction, the agent receives the restored skills as if it had read them itself: the same files with the same contents stay in every request until the next compaction, also after `/resume`.

## Problem Boundary
The problem concerns the files that `skill-restoration` inserts between two compactions. Candidate collection and the order of package extensions stay as they are.

## Assumptions
No assumptions.

## Open Questions
None.
