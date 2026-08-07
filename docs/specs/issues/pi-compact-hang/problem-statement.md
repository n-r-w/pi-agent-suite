# Problem Statement

## Context
The `custom-compaction` extension (pi-agent-suite) replaces Pi's standard context compaction with adaptive summarization. On large contexts, after tool-result projection, the extension runs a budget-planning phase for the adaptive compaction.

## Problem Statement
Manual `/compact` on a context of ≥ ~500k tokens freezes the Pi TUI for tens of seconds to minutes: the spinner stops, cancel (escape) does not respond, and the user sees a stale progress message. The cause is synchronous CPU-bound tokenization in the adaptive compaction planning phase, which blocks the Pi event loop.

## Who is affected
Users of Pi with large contexts who run `/compact` manually. The whole Pi TUI is affected, not just the extension.

## Evidence
- Session `019fdca2-fd41-71ae-b9ce-6cf5c836b807`: two compactions; in both, after 14 tool-result projections there is a ~4.5-minute gap with zero completed model requests; the user observes a frozen spinner at `projecting compaction source: 13/14 tool results`.
- Benchmark: `calculateCommonNodeBudget` alone = 36.6–68.5 s of pure CPU; a 10 ms heartbeat timer received 0 ticks during the run → the event loop is fully blocked.
- Static analysis: the whole planning chain (`buildSummarySource` → `calculateFinalSummaryBudget` → `doesFinalRequestFit` → `calculateCommonNodeBudget` → dry-run binary search) is synchronous; there is no `await` between the single event-loop yield and the first LLM request.
- For provider `opencode-go` (not in the OpenAI family), every token count runs 3 tiktoken encodings and takes the maximum, about 3× slower than a known encoding (measured 2050 ms vs 627 ms for a 12 MB text).
- The Pi spinner is a `Loader` from pi-tui animated via `setInterval(80ms)`; a blocked event loop freezes it.

## Impact
- User time loss: 1–2 min of frozen UI per compaction on large contexts, plus ~3 min for the first large async request (during which the spinner animates).
- The operation looks hung; cancel does not respond during the block.
- Reduced trust: compaction at ~500k+ tokens is perceived as broken.

## Reproduction Steps
Run `/compact` manually with a context of ~556k tokens, 89 history blocks, model `deepseek-v4-flash` (provider `opencode-go`), with the `custom-compaction` extension enabled.

## Current State
Planning runs as one synchronous block: a single `setTimeout(0)` yield before it, then 30–90+ seconds without releasing the event loop and without any progress notifications.

## Desired Outcome
During planning, the Pi spinner keeps animating, a message about the running operation is shown (e.g., "planning compaction budgets…"), the UI stays responsive, and escape works.

## Success Metrics
- No event-loop blocking period longer than ~200 ms in the planning phase (measured with a heartbeat timer or by UI responsiveness).
- A progress message is visible during the whole planning phase.
- The compaction result (final summary, range selection, request count) does not change relative to current behavior.

## Scope
Only the planning phase of adaptive compaction in `custom-compaction`: releasing the event loop at an interval that prevents visible blocking, and progress notifications. Only what is required for "progress message + live spinner".

## Out of Scope / Non-Goals
- Optimizing tokenization itself (caching, worker thread, tokenizer replacement, removing the 3-encoding fallback).
- Changing the budget calculation algorithm or compaction results.
- Speeding up the first large LLM request.

## Constraints
- No overengineering (KISS/YAGNI) — only the minimal change for the Desired Outcome.
- Planning behavior and numbers must stay deterministic and equivalent to current behavior.
- The extension runs in the Pi main process; `js-tiktoken` is synchronous.

## Assumptions
- The blocking cause is CPU-bound tokenization, not network latency (supported by benchmark and static analysis). Verification: additional heartbeat measurement during reproduction.
- Inserting yields will not change computation results (deterministic pure functions).
- Verification: unit test on responsiveness and notification order per AGENTS.md.

## Open Questions
- Is progress inside planning needed (e.g., an iteration counter update) or is one start message plus a live spinner enough? Clarify in PRD.
- Acceptable blocking threshold: "no visible hang at all" — confirm when formulating requirements.

# Domain Glossary

| Term | Definition |
|---|---|
| custom-compaction | Pi-agent-suite extension that replaces standard context compaction with adaptive summarization. |
| adaptive compaction | Compaction path that, when a direct final request does not fit, reduces history in stages (preliminary ranges, merges, final summary). |
| planning phase | Synchronous computation of compaction budgets (`calculateCommonNodeBudget` and related functions) before LLM requests. |
| dry-run | Simulation of history reduction without LLM requests; used in the binary search for a feasible node budget. |
| tokenization | Encoding text into tokens via `js-tiktoken`; synchronous CPU-bound work. |
| event loop | Single-threaded JS execution loop in Pi; blocking it freezes the whole TUI. |
| Loader / spinner | pi-tui progress indicator animated via `setInterval(80ms)`. |
| progress notification | Status-line message emitted through `session.ui.notify`. |
| tool-result projection | Replacement of large tool results with concise LLM-generated summaries. |
| first large request | Async LLM request that reduces the whole history corpus (~500k input tokens), executed after planning. |
