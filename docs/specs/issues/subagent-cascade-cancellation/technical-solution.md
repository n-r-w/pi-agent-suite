# Technical Solution: Cascade subagent cancellation

## Problem Statement
- PRB-01: Pi aborts an active main-agent run by emitting `agent_end` with the final assistant message set to `stopReason: "aborted"`; it does not emit `session_shutdown`.
- PRB-02: The `run-subagent` extension previously started transitive shutdown only from `session_shutdown`, leaving accepted background child processes active after main-agent cancellation.
- PRB-03: A child can own further child invocations, so stopping only direct child processes would leave deeper descendants active.

## Proposed Solution
- SOL-01: A shared agent-end classifier reads the final assistant message, ignoring trailing tool-result messages. It classifies only `stopReason: "aborted"` as cancellation and classifies neither provider errors nor missing assistant messages as cancellation.
- SOL-02: The root `run-subagent` runtime handles an aborted `agent_end` by admitting `recoverRootShutdown` through `RuntimeFailureRecoveryTracker` and awaiting the tracker drain.
- SOL-03: Worker runtimes do not initiate root recovery from `agent_end`. The root supervisor owns every process and expands cancellation transitively through `ownerRuntimeLeaseId`.
- SOL-04: Agent-run cancellation retains the root runtime, root writer, management runtime, and recovery admission for later user prompts. Only `session_shutdown` disposes those session-scoped resources.
- SOL-05: `SubagentCoordinator.shutdown` remains the logical-state authority: it cancels waits and records active invocations as `terminal-aborted` with forced-abort feedback withheld.
- SOL-06: `InvocationSupervisor.terminateLease` remains the process authority: it expands the complete runtime-lease closure and joins idempotent process teardown.
- SOL-07: `cmux` and `completion-sound` use the shared final-assistant classifier for their completed-work decisions, preserving their existing behavior.
- ACC-01: Given an active root child with nested descendants, when the main agent ends with final `stopReason: "aborted"`, every active invocation in the ownership closure becomes terminal-aborted and every corresponding process teardown settles.
- ACC-02: Given final `stopReason: "stop"`, `"toolUse"`, or `"error"`, the lifecycle handler does not start root recovery.
- ACC-03: After aborted-run recovery, a later `message_end` can still reconcile through the retained root runtime.
- ACC-04: Concurrent aborted-run recovery and `session_shutdown` join the recovery tracker and process teardown without duplicate terminal feedback.

## Overengineering and Overspecification Considerations
- DEC-01: The solution reuses the coordinator, supervisor, persistence recovery, and process escalation already used by `session_shutdown`; it adds no second cancellation graph or process-control path.
- DEC-02: The shared classifier removes duplicate final-assistant traversal from three extensions and contains no session or process policy.
- LIM-01: Pi does not expose cancellation of an auto-retry delay as a distinct extension lifecycle event. This solution handles active agent-run cancellation represented by final `stopReason: "aborted"` and session termination represented by `session_shutdown`.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/run-subagent/index.ts` - root lifecycle wiring and recovery admission.
- REF-02: `pi-package/extensions/run-subagent/coordinator.ts` - logical runtime-lease closure and forced-abort state.
- REF-03: `pi-package/extensions/run-subagent/invocation-supervisor.ts` - transitive process teardown.
- REF-04: `pi-package/shared/agent-end-state.ts` - final assistant outcome classifier.
- REF-05: `docs/extensions/run-subagent.md` - user-facing extension behavior.
