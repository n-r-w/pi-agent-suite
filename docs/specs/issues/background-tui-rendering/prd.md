# Idea: Avoid unchanged background TUI renders

## Definitions

See [terms.md](terms.md).

## Context and Problem

See [problem.md](problem.md).

## Goal

Reduce background CPU usage without hiding changes to visible extension state.

## Scenarios

- Usage polling returns totals equal to the footer's cached totals.
- A main-agent contribution event does not change the footer's agent label.
- Codex quota polling produces the status already shown in the footer.
- The selected active subagent shows advancing elapsed time.

## Scope and Non-Scope

In scope:

- Background timers and subscriptions in `pi-package/extensions`.
- A 10-second elapsed-time refresh cadence in the subagent management screen.

Out of scope:

- Partial component invalidation in `pi-tui`.
- Render requests caused by user input or visible streaming changes.

## Requirements

### Functional Requirements

- [X] FRQ-01: The footer shall request a global render after usage polling only when `cost`, `tokens`, or usage availability changes.
  - Origin: source. The user selected option `O1-1` after the measured footer CPU investigation.
  - Goal: Remove unchanged periodic footer renders.
  - Goal achievement: Full. Unchanged polling results no longer enter the global render path.
- [X] FRQ-02: A background subscription shall request a global render only when the subscription changes visible component state.
  - Origin: source. The user applied the unchanged-state rule to all package components.
  - Goal: Remove unchanged subscription-driven renders.
  - Goal achievement: Full. Render requests follow visible state transitions.
- [X] FRQ-03: The selected active subagent elapsed time shall refresh every 10 seconds.
  - Origin: source. The user selected a 10-second cadence.
  - Goal: Reduce recurring management-screen renders.
  - Goal achievement: Full. The elapsed timer requests at most one cadence render every 10 seconds.
- [X] FRQ-04: Codex quota polling shall not publish status text equal to the currently published status text.
  - Origin: formulated. The package audit found a periodic status publisher that could repeat visible state.
  - Goal: Remove unchanged quota-driven renders.
  - Goal achievement: Full. Equal status results do not call the UI status setter.

### Non-Functional Requirements

- [X] NRQ-01: The change shall preserve the existing 10-second usage polling cadence and cross-process usage discovery.
  - Origin: formulated. Child agents write usage from separate processes.
  - Goal: Reduce renders without making root-family usage stale.
  - Goal achievement: Full. Polling continues while unchanged results avoid rendering.

## Open Questions

None.

## Technical Supplement

See [solution.md](solution.md).

## References

- [Footer documentation](../../../extensions/footer.md)
- [Run-subagent documentation](../../../extensions/run-subagent.md)
- [Codex quota documentation](../../../extensions/codex-quota.md)
