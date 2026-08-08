# Analysis Results: Knowledge Accumulation Discards Oversized LLM Output

This analysis investigates why the `knowledge` extension rejects oversized LLM results, why knowledge stops accumulating, and which solution the repository owner approved. It informs the implementation plan for the `pi-package/extensions/knowledge` module.

## Scope

In scope:

- Merge and extraction algorithms of the knowledge extension.
- Token-limit enforcement and token counting.
- Retry mechanics and failure exits.
- Merge configuration structure (`merge` block).
- Manual trigger interfaces: CLI flag and slash command.
- Algorithm registry ownership.

Out of scope:

- Context-window estimation changes in shared modules.
- Custom-compaction behavior (only reusable primitives are referenced).
- Project identity, storage layout, and mutation coordination.
- Any code changes; this document is analysis only.

## Key definitions and abbreviations

- DEF-01: `tokenLimit` — configured per-scope file capacity (`globalTokenLimit` / `localTokenLimit`), default `5_000` tokens (`pi-package/extensions/knowledge/config.ts:37`).
- DEF-02: `retryCount` — number of retries after the initial request. Extraction default `1`, merge default `2` (`config.ts:38-39`).
- DEF-03: `over-limit` — `KnowledgeReplacementResult` kind returned when `tokenCount > tokenLimit` (`owner.ts:76-78`).
- DEF-04: `max-of-three fallback` — token count computed as `Math.max` over `o200k_base`, `cl100k_base`, `r50k_base` when the model encoding is unknown (`context-size.ts:186-195`).
- DEF-05: `incoming` — extraction output passed into the merge request inside `<incoming_knowledge>` tags (`algorithms.ts:464-466`).
- DEF-06: `FLR-01/02/03` — merge failure exits: retry exhaustion, context-window overflow, empty output.
- DEF-07: `A4 page fraction` — the user-approved size target unit expressed as a simple fraction of an A4 page, e.g. `2/3 страницы A4`.
- DEF-08: `algorithm registry` — planned shared registry of `{type, description, run}` algorithm entries.
- DEF-09: `session_start` — Pi extension lifecycle event emitted after all extensions load.

## Executive Summary

The merge path rejects oversized LLM output after a finite retry allowance, and retries themselves grow the model input. The dominant realistic failure is retry exhaustion (FLR-01); the context-window throw (FLR-02) is reachable only for extreme input/output combinations on a 128k window. Extraction output is not size-checked at all. The repository owner approved the following solution:

- Replace the size-repair retry loop with a no-history retry that resends the identical merge request with a reduced size target expressed as a fraction of an A4 page.
- Apply the same scheme to extraction.
- Write nothing when retries are exhausted; treat provider truncation (`stopReason: "length"`) as a defect.
- Count the knowledge limit with a single fixed tokenizer `o200k_base`.
- Split the `merge` config block into `mergeLocal` and `mergeGlobal` (breaking change).
- Introduce a central algorithm registry owned by a new extension; move the `--trigger` CLI flag out of the workflow extension and add a `/trigger:<тип>` slash command generated at `session_start`.

All facts were verified against source; two independent advisor reviews were completed; every review finding was resolved by an explicit user decision.

## Background and Context

The `knowledge` extension accumulates LLM-generated project knowledge into bounded Markdown files. Extraction converts the projected session into knowledge; merge consolidates stored and incoming knowledge into one replacement that must fit the token limit. The user reported that models frequently produce oversized merge output, the system rejects it, and knowledge does not accumulate. A confirmed aggravating mechanism: each retry appends the previous giant output to the message history, so the input grows by more than `tokenLimit` per attempt and can itself exceed the model context window.

## Method and Data Sources

- Full reads with line references of `pi-package/extensions/knowledge/{algorithms,owner,config,index,coordinator,context}.ts`.
- Full reads of `pi-package/shared/{context-size,auxiliary-llm,auxiliary-llm-session,knowledge-runtime,workflow-trigger-runtime}.ts`.
- Full reads of `pi-package/extensions/workflow/index.ts` and `pi-package/extensions/custom-compaction/adaptive-compaction-reduction.ts`.
- Pi runtime sources: `node_modules/@earendil-works/pi-coding-agent/dist/{core/agent-session.js,core/extensions/{loader,runner}.js}` and `node_modules/@earendil-works/pi-tui/dist/autocomplete.js`.
- Empirical measurement scripts run with the real `js-tiktoken` package on representative knowledge Markdown samples.
- Input-growth quantification validated bit-for-bit against the real `estimateSerializedInputTokens`/`estimateTextTokens` functions.
- Two independent `consult_advisor` reviews; all raised gaps resolved by user decisions.

## Observations

- OBS-01: `owner.ts:71` — `const tokenCount = estimateTextTokens(text, undefined, undefined);` inside `KnowledgeOwner.replace()`; over-limit returns `{kind:"over-limit", tokenCount, tokenLimit}` without touching the filesystem (`owner.ts:76-78`).
- OBS-02: `estimateTextTokens(text, undefined, undefined)` always executes the max-of-three fallback because `getKnownEncoding(undefined, undefined)` returns `undefined` (`context-size.ts:219`, fallback at `context-size.ts:186-195`).
- OBS-03: The merge model is resolved at runtime (`algorithms.ts:370-380`) and used for the input context-window check (`auxiliary-llm.ts:119-127`), but is never passed to the output limit check (`algorithms.ts:292-295`; `owner.ts:65-83`).
- OBS-04: On over-limit, `mergeAttempt` appends the previous assistant response and a feedback user message to `context.messages` (`algorithms.ts:302-307`) and `completeText` resends the full history (`algorithms.ts:322-326`).
- OBS-05: A fresh UUIDv7 `sessionId` is created per request (`auxiliary-llm.ts:100-102`, `auxiliary-llm-session.ts:4-6`); provider conversation state is never reused, so `context.messages` is the only history carrier (`compat.js:184-198`, `openai-completions.js:834`).
- OBS-06: Measured input growth per retry equals `previous output tokens + 34` (feedback text plus two message reserves). With default `tokenLimit=5000` and `merge.retryCount=2`, the last attempt input can exceed the first by more than `2 × 5000` tokens.
- OBS-07: Quantified attempt inputs (fallback counting, stored file at its 5000 cap): `attempt0 ≈ 5941 + incoming`; the 9-cell matrix (incoming 2k/10k/50k × persistent output 6k/10k/50k) exceeds a 128k window in exactly one cell (incoming=50k, output=50k at attempt 2: 156,039). No measured cell exceeds 200k or 1M.
- OBS-08: FLR-02 (context-window throw, `algorithms.ts:327-334`) at the initial merge needs extraction output above ~122k (128k window), ~194k (200k), ~994k (1M). Via retry growth it is reachable only for incoming ≥ ~22k AND persistent output ≥ ~50k on a 128k window at attempt 2. The dominant realistic failure is FLR-01.
- OBS-09: `extractKnowledgeAttempt` checks only exact `rawText === "NOT_FOUND"` (`algorithms.ts:225`) and non-empty trimmed text (`algorithms.ts:228`); no token-size check exists on extraction output (`algorithms.ts:218-243`).
- OBS-10: Extraction output flows verbatim into the merge request as `<incoming_knowledge>` (`algorithms.ts:148,464-466`).
- OBS-11: The extraction request contains the whole projected session as `<summary_source>`; it is not truncated in this pipeline (`context-projection.ts:751-780`).
- OBS-12: The 200-line (extraction) and 400-line (merge) limits exist only as prompt text (`prompts/extraction-system.md:15`, `prompts/merge-system.md:40`); no code enforces line counts.
- OBS-13: The retry feedback number N is the max-of-three fallback count (`algorithms.ts:305`; `owner.ts:71`), not the merge model's own tokenizer count.
- OBS-14: Measured tokenizer spread on 7 representative knowledge-Markdown samples: `r50k_base` was the largest count in all 7 samples, 7.6%–102% above the smallest; on a ~40k-char mixed sample `r50k = 10948` vs `o200k = 8816` (+24%). At the 5000 limit the fallback rejects content in the ~4026–5000 o200k-token band (~19.5% of the limit).
- OBS-15: `stopReason: "length"` is not handled in `completeText` (`algorithms.ts:348-357`); a provider-truncated output that fits the limit is written as knowledge.
- OBS-16: No truncation, partial write, or fallback exists in the knowledge extension; `takeTextTokenPrefix` (`context-size.ts:72-95`) is used only by custom-compaction (`adaptive-compaction-reduction.ts:408`).
- OBS-17: On any failure exit, local accumulation discards the in-memory extraction result permanently (`algorithms.ts:143-154`); global accumulation keeps the local file with a stale digest and re-attempts next run (`algorithms.ts:168-204`).
- OBS-18: One `merge` config block is consumed at both call sites: local `algorithms.ts:137` and global `algorithms.ts:179` (`config.ts:16-17,138-147`).
- OBS-19: `WORKFLOW_TRIGGER_SCHEMA` is a static `StringEnum` with two literals (`workflow/index.ts:95-104`); `WORKFLOW_TRIGGER_TYPES` mirrors the union (`shared/workflow-trigger-runtime.ts:23-27`).
- OBS-20: `--trigger` CLI flag is registered and handled inside the workflow extension (`workflow/index.ts:472-477,479-510`); the handler validates via `isWorkflowTriggerType`, runs the runner, then calls `ctx.shutdown()`.
- OBS-21: `pi.registerCommand` binds `sourceInfo` to the registering extension (`loader.js:223-229`); commands are resolved by exact `invocationName` (`runner.js:441-445`); duplicate names are rewritten to `:1`/`:2` (`runner.js:403-436`).
- OBS-22: TUI autocomplete without a space filters registered command names by fuzzy match (`pi-tui/dist/autocomplete.js:205-226`); skills appear as `skill:<name>` entries (`agent-session.js:1833-1835`).
- OBS-23: `WORKFLOW_TRIGGER_TYPES` is a closed array; adding an algorithm requires editing the union, the array, and the runner registration.

## Analysis and Interpretations

- INT-01: The retry loop is a pure size-repair mechanism that relies on the model shrinking its output; each retry grows the input by roughly the previous output size because the conversation is stateless and the full history is resent (OBS-04 to OBS-06).
- INT-02: Retry exhaustion (FLR-01) is the dominant realistic discard path; the context-window throw (FLR-02) is a rare extreme case, not the primary defect (OBS-07, OBS-08).
- INT-03: Feedback about the previous output count is unusable in a no-history retry: the model cannot see its own output, so the reported number has no referent for the model.
- INT-04: A merge is fully defined by its source (stored + incoming), which stays in the request; the previous output is an unnecessary failed artifact. A tighter target is sufficient to regenerate a smaller merge (verified by advisor review).
- INT-05: The unbounded extraction output is the main input-side risk: it inflates both merge input and merge output and makes FLR-02 conceivable at a 128k window (OBS-09, OBS-10, OBS-07).
- INT-06: The max-of-three fallback is not required by any code contract; its only guarantee is that the count is >= each of the three encodings' counts (OBS-02). The repo already uses a single-encoding precedent (`countProjectionTextTokens`, `context-size.ts:98-99`).
- INT-07: The documented phrase "the model receives the actual tokenizer count" (`docs/extensions/knowledge.md:167`) refers to the max-of-three fallback result, not the model's own tokenizer (OBS-13).
- INT-08: The static workflow schema and the algorithm registry serve different purposes: workflow validates stage-declared triggers at `workflow_create` time; the registry powers manual runs. They do not need to share a source of truth (user decision DEC-08).

## Hypotheses and Tests

- HYP-01: A model can regenerate an in-limit merge from the immutable source (stored + incoming) with only a reduced size target and no view of its previous output.
  - What it means if true: the no-history reduced-target retry eliminates input growth and converges without resending history.
  - What it means if false: retries repeat the same oversized output; the agreed fallback (write nothing) applies, matching today's FLR-01 outcome without the input-growth side effect.
  - How to test: live validation with the target merge model, measuring retry success rate and output quality; requires user authorization for real model calls.
  - Expected signal: retry success rate high enough to justify the reduced target chain.
  - Falsification signal: repeated oversized output across the full retry chain.
  - Effort/cost: one instrumented run against the configured merge model.

## Options and Trade-offs

- OPT-01: **No-history reduced-target retry** — resend the identical merge request with a smaller size target; no previous output, no count feedback. Pros: zero input growth (~+26 tokens per retry), removes FLR-02 for realistic inputs, small change. Cons: relies on the model regenerating from source; requires live validation (HYP-01).
- OPT-02: Bounded-history retry — append the previous output truncated to `tokenLimit` plus feedback. Pros: model sees the head of its own output. Cons: input grows by ~5000 tokens per retry; truncation keeps only the head. Kept as fallback if HYP-01 fails.
- OPT-03: Full-history resend (current). Pros: model sees its entire previous output. Cons: confirmed input growth; dominant FLR-01 persists. Rejected.
- OPT-04: Deterministic truncation fallback on exhaustion. Pros: guarantees some knowledge is written. Cons: truncated knowledge is worse than absence per user decision (DEC-03); violates the bounded-file spirit if unchecked. Rejected.
- OPT-05: Quarantine storage of oversized extraction for later merge. Pros: avoids re-extraction. Cons: unbounded storage; later merge fails identically. Rejected as primary.
- OPT-06: Single fixed tokenizer `o200k_base` for the knowledge limit. Pros: simple, matches gpt-5-family targets, single-encoding precedent exists. Cons: changes the documented contract; limit becomes o200k-denominated (~24% more English text admitted than today). Chosen (DEC-04).
- OPT-07: Model-aware counting (pass runtime model to the limit check). Pros: count matches the model's own tokenizer for OpenAI-family models. Cons: adds model plumbing through the owner interface; non-OpenAI still uses the fallback. Subsumed by DEC-04 for this issue.
- OPT-08: Dynamic workflow trigger schema fed by the registry. Pros: single source of truth. Cons: loses fail-fast YAML validation; not needed since workflow and manual run are separate (DEC-08). Rejected.

## Recommendation

- REC-01: Replace the merge retry loop with the no-history reduced-target scheme: resend the identical request with a reduced A4-page fraction target; keep `tokenLimit` as the hard ceiling enforced by `owner.ts`.
- REC-02: Express the size target as a simple fraction of an A4 page with denominators up to 8 (never decimals); make the initial fraction and the reduction coefficient configurable; default initial fraction `2/3`, default coefficient `3/4` (chain `2/3 → 1/2 → 3/8`).
- REC-03: Apply the same fraction scheme to extraction; no separate extraction limit.
- REC-04: On retry exhaustion, write nothing (current storage behavior preserved).
- REC-05: Treat `stopReason: "length"` as a retryable defect; on exhaustion write nothing. Mirror `extractValidResponse` in custom-compaction (`adaptive-compaction-reduction.ts:642-677`).
- REC-06: Use a single fixed tokenizer `o200k_base` for the knowledge limit check only; leave the shared max-of-three fallback in `context-size.ts` untouched.
- REC-07: Split the `merge` config block into `mergeLocal` and `mergeGlobal`; update both call sites (`algorithms.ts:137,179`); remove the `merge` key (breaking change).
- REC-08: Add a central algorithm registry in a shared module with `registerTriggerAlgorithm(pi, {type, description, run})`, keyed by type with overwrite semantics; knowledge registers its two algorithms at load time.
- REC-09: Create a new owner extension for algorithms: it registers the CLI flag `--trigger` (moved out of workflow) and generates `/trigger:<тип>` slash commands at `session_start` by walking the registry.
- REC-10: Keep the workflow YAML trigger schema static; workflow remains a pure client of the runner.

## Action Plan

- ACN-01: Add configuration fields for the initial A4-page fraction and the reduction coefficient, with the defaults above.
- ACN-02: Add a fraction formatter producing simple fractions with denominators up to 8 and a rounding rule for out-of-set chain results.
- ACN-03: Rework `mergeAttempt` and `extractKnowledgeAttempt` to retry with a reduced target and no history; add `stopReason: "length"` defect handling in `completeText`.
- ACN-04: Change the knowledge limit check to `o200k_base`; update `docs/extensions/knowledge.md` and `docs/specs/features/knowledge/light-prd.md`; review `context-size.test.ts:11-16`.
- ACN-05: Split `merge` into `mergeLocal`/`mergeGlobal`; add a test asserting local uses `mergeLocal` prompts and global uses `mergeGlobal`.
- ACN-06: Implement the shared algorithm registry; register knowledge's two algorithms.
- ACN-07: Create the owner extension: move `--trigger` handling there, add `/trigger:<тип>` command generation at `session_start`, keep workflow untouched.
- ACN-08: Run live validation (HYP-01) before enabling the no-history retry in production.

## Assumptions

- ASM-01: `completeSimple` adds no provider conversation state beyond `sessionId`; the full history is carried by `context.messages` (OBS-05). Verification: code trace of `compat.js` and `openai-completions.js`.
- ASM-02: "A4 page" content anchor (e.g., ~500 words per page) must be embedded in the prompt as a fixed contract; without it, models interpret page fractions differently.
- ASM-03: The stored knowledge file is at its `tokenLimit` cap in the worst-case input estimates; smaller files only reduce input sizes.

## Open Questions

- QST-01: Empirical magnitude of retry success for the no-history reduced-target scheme on the real merge model.
  - Impact: decides whether the scheme converges in practice (HYP-01).
  - What the answer should look like: measured retry success rate and output quality over real sessions.
  - What was done: mechanism and thresholds are proven from code; live behavior requires authorized model calls.
  - How/when resolved: instrumented live run before production enablement.
- QST-02: Whether the "A4 page ≈ 500 words" anchor should be configurable or fixed.
  - Impact: prompt-level contract consistency across models.
  - What the answer should look like: a decision by the repository owner.
  - What was done: anchor not yet embedded in any prompt.
  - How/when resolved: during prompt drafting in implementation.

## References

- REF-01: `pi-package/extensions/knowledge/algorithms.ts` — merge/extraction algorithms, retry loops, `completeText`, `formatMergeRequest`.
- REF-02: `pi-package/extensions/knowledge/owner.ts` — count-before-write limit enforcement (64-83).
- REF-03: `pi-package/extensions/knowledge/config.ts` — defaults and `merge` block (16-17, 37-39, 138-147).
- REF-04: `pi-package/extensions/knowledge/index.ts` — trigger runner, failure notification (232-272).
- REF-05: `pi-package/shared/context-size.ts` — max-of-three fallback (186-195), `takeTextTokenPrefix` (72-95), `countProjectionTextTokens` (98-99).
- REF-06: `pi-package/shared/auxiliary-llm.ts` — sessionId per request (100-102), context-window check (119-127).
- REF-07: `pi-package/shared/workflow-trigger-runtime.ts` — trigger types and runner lookup.
- REF-08: `pi-package/shared/knowledge-runtime.ts` — WeakMap + event bus registration pattern.
- REF-09: `pi-package/extensions/workflow/index.ts` — static trigger schema (95-104), `--trigger` handling (472-510).
- REF-10: `pi-package/extensions/custom-compaction/adaptive-compaction-reduction.ts` — `executeSingleRequest` constant-input retry (542-574), `extractValidResponse` (642-677), `findUsefulBoundary` (427-439).
- REF-11: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` — command parsing (927-929), skill expansion (953-975), command list (1824-1835).
- REF-12: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{loader,runner}.js` — `registerCommand` sourceInfo (223-229), invocation resolution (403-445).
- REF-13: `node_modules/@earendil-works/pi-tui/dist/autocomplete.js` — command autocomplete (178-260).
- REF-14: `docs/extensions/knowledge.md`, `docs/specs/features/knowledge/light-prd.md` — documented counting and failure contracts.
- REF-15: `pi-package/extensions/knowledge/prompts/{merge-system,merge,extraction-system,extraction}.md` — advisory line limits.
