# Idea: Non-blocking planning phase in custom-compaction

## Definitions
- **custom-compaction** — pi-agent-suite extension that replaces standard context compaction with adaptive summarization. See the Domain Glossary in `problem-statement.md`.
- **planning phase** — synchronous computation of adaptive compaction budgets before LLM requests.

## Context and Problem
Manual `/compact` on a context of ≥ ~500k tokens freezes the Pi TUI for 30–90+ seconds: the spinner stops, escape does not work, and the progress message becomes stale. The cause is synchronous CPU-bound tokenization in the planning phase, which blocks the Pi event loop.

## Goal
The planning phase becomes non-blocking: the Pi spinner animates continuously, a message about the running operation is displayed, and cancel works. The compaction result does not change.

## Scenarios
- The user runs `/compact` manually on a large context (~556k tokens, 89 history blocks).
- During planning, the user sees a progress message and a live spinner.
- The user presses escape during planning — the operation is interrupted, as on other compaction stages.

## Scope and Non-Scope
**In scope:** the planning phase of adaptive compaction in `custom-compaction`; releasing the event loop; a progress message; cancel; fixed `o200k_base` token counting; request-local caching of complete rendered planning-context estimates.
**Out of scope:** worker threads; changing the budget calculation algorithm; wall-clock performance benchmarks; speeding up the first large LLM request.

## Requirements

- REQ-01: When the planning phase starts, one progress message about the running operation is shown (by analogy with existing messages, e.g. "planning compaction budgets…"), and it remains on screen until the phase ends.
- REQ-02: During the planning phase, the event loop is not blocked for longer than ~200 ms at a time — the Pi spinner animates continuously and the UI stays responsive.
- REQ-03: Escape during the planning phase interrupts the compaction (cancel works, as on other stages).
- REQ-04: The compaction result (final summary, selected ranges, request count) does not change relative to current behavior.

## Open Questions
No blocking open questions.

## References
- `docs/specs/issues/pi-compact-hang/problem-statement.md` — Problem Statement and Domain Glossary.
