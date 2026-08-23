# Technical Solution: Subagent wait Escape cancellation

## Problem Statement

- PRB-01: Pressing `Escape` during `subagent_wait` can produce an aborted `ExtensionContext.signal` followed by a final assistant `stopReason` of `"error"`. The root lifecycle handler checks only `stopReason: "aborted"`, so active child agents continue running.

## Proposed Solution

- SOL-01: The registered `agent_end` handler passes its `ExtensionContext` to `handleAgentEnd`.
- SOL-02: `handleAgentEnd` classifies the main-agent run as cancelled when either `isAbortedAgentRun(event)` returns true or `ctx.signal?.aborted` is true.
- SOL-03: Cancelled runs use the existing `RuntimeFailureRecoveryTracker` and `recoverRootShutdown` path. The coordinator and supervisor remain the authorities for logical terminal state and transitive process termination.
- SOL-04: Final `stopReason` values of `"stop"` and `"error"` do not trigger recovery when the active context signal is absent or not aborted.
- ACC-01: Given an active root child, when `agent_end` has final `stopReason: "error"` and an aborted context signal, root recovery receives the child's runtime lease.
- ACC-02: Given an active root child, when `agent_end` has final `stopReason: "error"` and no aborted context signal, root recovery does not start.
- ACC-03: Existing nested-wait cancellation, root-wait cancellation, and final `stopReason: "aborted"` behavior remain valid.

## Overengineering and Overspecification Considerations

- DEC-01: The change adds one public signal check to the existing lifecycle condition. It does not add a cancellation protocol, process-control path, or error-message match.
- DEC-02: The extension does not infer cancellation from `errorMessage` text because provider and runtime wording is not a stable cancellation contract.

## Open Questions

None.

## References

- REF-01: `pi-package/extensions/run-subagent/index.ts` - root lifecycle cancellation decision and recovery admission.
- REF-02: `pi-package/extensions/run-subagent/index.test.ts` - regression coverage for an aborted context signal with final `stopReason: "error"`.
- REF-03: `pi-package/shared/agent-end-state.ts` - final assistant outcome classifier.
- REF-04: `docs/extensions/run-subagent.md` - user-facing cancellation contract.
