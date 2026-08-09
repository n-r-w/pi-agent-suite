# Technical Solution: Non-blocking planning phase in custom-compaction

## Problem Statement
- PRB-01: During manual `/compact` on contexts ≥ ~500k tokens, the adaptive compaction planning phase blocks the Pi event loop for 30–90+ seconds: the spinner freezes, escape does not respond, and the progress message goes stale (session `019fdca2-fd41-71ae-b9ce-6cf5c836b807`; measured `calculateCommonNodeBudget` = 36.6–68.5 s of pure CPU with 0 heartbeat ticks).
- PRB-02: The planning phase is one synchronous stretch with only a single `setTimeout(0)` yield (`adaptive-compaction.ts:133`) between the "start" notification and the first LLM request.
- PRB-03: Planning repeatedly estimated identical complete rendered summary contexts during dry-run searches.

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

### SOL-04: Fixed tokenizer and request-local planning cache
- `pi-package/shared/context-size.ts` loads only `o200k_base`. Its token-count and token-prefix APIs do not accept model or provider parameters.
- `adaptiveCompactHistory` creates one `Map` for the invocation. `estimateSummaryInput` keys each entry by `JSON.stringify(context)`, the complete rendered summary context, and reuses its token estimate on an exact match.
- The map is reachable only through the invocation runtime options. A later or concurrent compaction creates a different map.

### TRD-01: Single-tokenizer counting
- `o200k_base` is the only tokenizer used for context input, standalone text, and token-prefix operations.
- Model and provider no longer influence token estimates.

### TRD-02: Planning result preservation
- Cache hits reuse the estimate computed for the same complete rendered context. They do not alter a budget calculation or request order.
- No worker thread, budget-algorithm change, global cache, or cross-compaction retention is introduced.

## Overengineering and Overspecification Considerations
- The change is limited to `context-size.ts` and custom-compaction planning.
- No worker threads, global cache, or budget-algorithm change is introduced.
- The step callback remains optional and throttled.

## Open Questions
No open questions.

## References
- `docs/specs/issues/pi-compact-hang/problem-statement.md` — Problem Statement, Domain Glossary.
- `docs/specs/issues/pi-compact-hang/prd.md` — REQ-01..REQ-04.
- pi dist: `agent-session.js:1397,1488-1491` — compaction abort wiring; `pi-tui loader.js` — spinner `setInterval(80ms)`.
