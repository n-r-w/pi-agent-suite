# Technical Solution: Non-blocking planning phase in custom-compaction

## Problem Statement
- PRB-01: During manual `/compact` on contexts ≥ ~500k tokens, the adaptive compaction planning phase blocks the Pi event loop for 30–90+ seconds: the spinner freezes, escape does not respond, and the progress message goes stale (session `019fdca2-fd41-71ae-b9ce-6cf5c836b807`; measured `calculateCommonNodeBudget` = 36.6–68.5 s of pure CPU with 0 heartbeat ticks).
- PRB-02: The planning phase is one synchronous stretch with only a single `setTimeout(0)` yield (`adaptive-compaction.ts:133`) between the "start" notification and the first LLM request.
- PRB-03: For the non-OpenAI provider (`opencode-go`), every token count runs 3 synchronous tiktoken encodings (`context-size.ts:188-192`), multiplying the CPU cost.

## Proposed Solution

### SOL-01: Progress message at planning start (REQ-01)
- Add a new progress event `{ type: "planning" }` to `AdaptiveCompactionProgressEvent` (`adaptive-compaction.ts`).
- Emit it in `adaptiveCompactHistory` immediately before `calculateFinalSummaryBudget`.
- Format it in `formatProgressMessage` (`index.ts`) as `planning compaction budgets...`.
- Add `planning` to the event set in `reportProgress` that performs `yieldToEventLoop()` (`index.ts:732-740`), so the message is painted before the long synchronous phase.
- `planning` is not an `operation`, so it does not increment `modelRequests` statistics (REQ-04).

### SOL-02: Cooperative event-loop yields (REQ-02)
- Add an optional `onStep?: () => Promise<void>` field to `AdaptiveCompactionOptions`.
- `adaptiveCompactHistory` builds a throttled step implementation: always check `options.signal.throwIfAborted()`; yield via `yieldToEventLoop()` at most once per ~100 ms of elapsed time.
- Convert the following planning functions to `async` and `await options.onStep?.()` at their loop boundaries:
  - `calculateFinalSummaryBudget` — between its two main-input tokenizations.
  - `doesFinalRequestFit` — after the full-corpus tokenization.
  - `findLargestFeasibleNodeBudget` — each outer binary-search iteration.
  - `isNodeBudgetFeasible` — each inner `while` pass.
  - `findLargestFittingOriginalPrefix` (`adaptive-compaction-reduction.ts`) — each binary-search probe.
- All call sites (in `adaptive-compaction.ts`, `adaptive-compaction-budget.ts`, `adaptive-compaction-reduction.ts`) become `await` calls; computation order and values stay identical.
- Result: the 30–90 s block becomes a sequence of short steps; the spinner animates (its `Loader` interval is 80 ms) and the UI stays responsive.

### SOL-03: Cancel during planning (REQ-03)
- The step implementation calls `options.signal.throwIfAborted()`; an aborted signal (escape → `abortCompaction()` → `_compactionAbortController.abort()`, already wired by pi) throws `AbortError`.
- The `AbortError` propagates through the existing catch in `handleSessionBeforeCompact` (`index.ts`), which follows the same path as cancel during an LLM request (REQ-03: cancel works as on other stages).

### TRD-01: Residual single-tokenization block (decision: accepted)
- One full-corpus 3-encoding tokenization (~556k tokens ≈ 2.2 MB) is ~370 ms — a single irreducible step slightly above the ~200 ms target from REQ-02.
- Decision: accepted. The spinner briefly stutters (~4 missed frames) instead of freezing; this happens a handful of times at the start of planning and is far below the current 30–90 s freeze.
- The alternative (splitting the 3-encoding computation with yields between encodings, result-identical) would touch the shared `context-size.ts` module and is explicitly deferred.

### TRD-02: No algorithm or result change (REQ-04)
- Yields only interleave execution; no computation, ordering, or token-count value changes. No caching, worker threads, or tokenizer changes are introduced (KISS; per PRD out of scope).

## Overengineering and Overspecification Considerations
- The change is limited to the custom-compaction extension; the shared `context-size.ts` module is untouched.
- No worker threads, no token-count caching, no changes to the budget algorithm.
- The step callback is optional and throttled, so test callers without it keep identical behavior.

## Open Questions
No open questions.

## References
- `docs/specs/issues/pi-compact-hang/problem-statement.md` — Problem Statement, Domain Glossary.
- `docs/specs/issues/pi-compact-hang/prd.md` — REQ-01..REQ-04.
- pi dist: `agent-session.js:1397,1488-1491` — compaction abort wiring; `pi-tui loader.js` — spinner `setInterval(80ms)`.
