# Technical Solution: Compaction Threshold Enforcement During Agent Runs

## Problem Statement

- PRB-01: Pi checks the automatic compaction threshold after `agent_end`, so one active agent run can send additional model requests after the calculated context reaches `contextWindow - reserveTokens`.
- PRB-02: After an extension aborts an over-threshold request, Pi can complete native threshold compaction before `agent_settled`; an unconditional `ctx.compact()` call at `agent_settled` then starts a redundant attempt that fails.
- CNS-01: Pi source code must not change.
- CNS-02: `custom-compaction` remains responsible only for custom summary generation through `session_before_compact`.
- CNS-03: `context-projection` remains responsible only for context projection. Its internal reusable calculations can be shared without moving compaction initiation into that extension.

## Behavioral Contract

- FRQ-01: Threshold enforcement applies to every active model with a positive `contextWindow`.
- FRQ-02: Before each model request, the calculated provider-visible context is compared with `min(contextWindow, contextWindow - reserveTokens + contextWindow * thresholdDeltaPercent / 100)`.
- FRQ-03: When the calculated context reaches the compaction threshold, compaction completes before the original over-threshold request is sent.
- FRQ-04: After successful compaction, the interrupted task continues automatically with preserved tool results and without user input.
- FRQ-05: When compaction fails, the over-threshold request remains blocked and the agent stops with an explicit error.
- FRQ-06: Main and child Pi sessions use the same behavior when the package is loaded.
- FRQ-07: Compaction initiation uses Pi's existing compaction pipeline and therefore preserves `session_before_compact`, custom summary generation, standard fallback, `CompactionEntry` persistence, and context rebuilding.
- FRQ-08: Threshold enforcement is disabled when Pi's `compaction.enabled` is `false`.
- FRQ-09: Threshold enforcement is disabled when `compaction-trigger` has `enabled: false`.
- FRQ-10: When `compaction-trigger/config.json` is absent or omits a field, `enabled` resolves to `true` and `thresholdDeltaPercent` resolves to `0`.
- FRQ-11: A successful native post-run compaction prevents a second manual compaction for the same threshold crossing.
- FRQ-12: When native post-run compaction does not succeed, the trigger initiates manual compaction after the interrupted run settles.

## Proposed Solution

### Separate trigger extension

- CMP-01: Add `pi-package/extensions/compaction-trigger/index.ts` as the sole owner of threshold detection and compaction initiation during an active agent run.
- DEC-01: Register `compaction-trigger` after `context-projection` in `pi-package/package.json`. Pi chains `context` handlers in registration order, so the trigger evaluates the final provider-visible messages after projection.
- DEC-02: Do not add threshold detection to `custom-compaction` or `context-projection`.

### Extension configuration

- CFG-01: Read optional settings from `compaction-trigger/config.json` through the suite configuration path.
- CFG-02: `enabled` is a boolean that defaults to `true`.
- CFG-03: `thresholdDeltaPercent` is a non-negative percentage of `contextWindow` that defaults to `0`.
- CFG-04: `enabled: false` disables only `compaction-trigger`; it does not change Pi's native compaction settings or pipeline.

### Request-size calculation

- ALG-01: On every `context` event, build the provider-visible request representation from `ctx.getSystemPrompt()`, `convertToLlm(event.messages)`, and the active tool definitions.
- ALG-02: Calculate a serialized estimate with `estimateSerializedInputTokens`. Also calculate a usage-backed estimate from the last assistant response with nonzero provider context usage whose `stopReason` is neither `aborted` nor `error`, plus `estimateTokens` for later messages. Use the larger estimate for threshold enforcement.
- ALG-03: Read `compaction.enabled` and `reserveTokens` through Pi's `SettingsManager`, including project settings precedence.
- ALG-04: Calculate `effectiveThreshold` as `min(contextWindow, contextWindow - reserveTokens + contextWindow * thresholdDeltaPercent / 100)`.
- ALG-05: Block the request when `estimatedTokens >= effectiveThreshold`. The `contextWindow` cap prevents the extension from permitting a request beyond the model's maximum context.
- DEC-03: Extract the existing active-tool collection from `custom-compaction` into a shared helper so compaction budgeting and threshold enforcement use the same tool representation.
- DEC-04: Extract native compaction-settings reading from `footer` into a shared helper. The footer output and `custom-compaction` behavior remain unchanged.

### Interruption and compaction lifecycle

- ENT-01: One extension instance keeps a local lifecycle state with the closed values `idle`, `interrupting`, `compacted`, `compacting`, `resuming`, and `failed`.
- STP-01: In `idle`, an under-threshold `context` event returns no replacement and leaves the request unchanged.
- STP-02: In `idle`, an at-threshold or over-threshold `context` event changes the state to `interrupting`, calls `ctx.abort()`, and returns an empty message list so the original large message array cannot reach the provider path.
- STP-03: A successful `session_compact` event in `interrupting` changes the state to `compacted`. This records that Pi rebuilt the context before `agent_settled`.
- STP-04: In `agent_settled`, `compacted` changes to `resuming` and sends one hidden continuation without calling `ctx.compact()`.
- STP-05: In `agent_settled`, `interrupting` changes to `compacting` and calls `ctx.compact()` because no successful compaction was observed.
- STP-06: Manual `ctx.compact()` follows Pi's compaction path. Pi emits `session_before_compact`, accepts a custom result or standard fallback, persists the resulting `CompactionEntry`, and rebuilds the active context.
- STP-07: The manual `onComplete` callback changes the state to `resuming` and sends one hidden `compaction-trigger-continuation` custom message with `triggerTurn: true`.
- STP-08: The first under-threshold `context` event in `resuming` changes the state to `idle` and lets the resumed model request proceed.
- STP-09: A session start or replacement resets non-active trigger state so lifecycle state cannot leak between sessions.

### Continuation contract

- EVC-01: The continuation message has `customType: "compaction-trigger-continuation"`, `display: false`, and `triggerTurn: true`.
- EVC-02: The continuation message tells the model to continue the interrupted task from preserved context and tool results. Tests assert delivery fields and continuation behavior, not arbitrary prompt wording.

### Failure handling

- FLR-01: A manual `ctx.compact()` error changes the state to `failed`, does not send a continuation message, and appends a visible non-triggering diagnostic that states that compaction failed and the next model request was blocked.
- FLR-02: A failed native post-run compaction leaves the state as `interrupting`, so `agent_settled` starts one manual compaction attempt.
- FLR-03: When the resumed context still reaches the threshold after one successful compaction, the extension aborts the resumed run and reports FLR-01 instead of starting another compaction cycle.
- FLR-04: Invalid native compaction settings produce the same blocked-request diagnostic rather than sending a request without an enforceable threshold.

### Public API limitation

- LIM-01: `ctx.compact()` enters Pi's manual compaction path, so lifecycle events report `reason: "manual"`. Pi's public extension API has no parameter for `reason: "threshold"`.
- TRD-01: The manual reason is accepted because it preserves the public compaction pipeline and does not change summary selection, persistence, or continuation behavior.

### Verification

- ACC-01: A unit test proves that an under-threshold context does not abort, compact, replace messages, or enqueue continuation.
- ACC-02: A unit test proves that reaching the threshold aborts the active run and calls `ctx.compact()` at `agent_settled` when no successful `session_compact` event occurs.
- ACC-03: A unit test proves that Pi's `compaction.enabled: false` disables threshold enforcement.
- ACC-04: A unit test proves that a successful `session_compact` event before `agent_settled` suppresses manual `ctx.compact()` and sends exactly one hidden continuation.
- ACC-05: A unit test proves successful manual compaction sends exactly one hidden continuation and returns to `idle` only after an under-threshold resumed context.
- ACC-06: Unit tests prove compaction failure and an over-threshold resumed context stop without another model request or compaction loop.
- ACC-07: An integration test uses a real `AgentSession`, an isolated fake provider, and an isolated tool result to prove that the original over-threshold request is not sent, native post-run compaction runs through `session_before_compact`, no redundant manual compaction starts, and the task resumes after the rebuilt context.
- ACC-08: Package-loading checks prove one `compaction-trigger` registration in main and child Pi processes.
- ACC-09: Implementation follows RED-GREEN-REFACTOR. Each behavior test must fail for its expected assertion before production code is added.
- ACC-10: Unit tests prove default extension settings, `enabled: false`, a positive `thresholdDeltaPercent`, equality with the effective threshold, and the `contextWindow` cap.
- ACC-11: An integration test loads a nonzero `thresholdDeltaPercent` from isolated suite configuration and proves the configured threshold through a real `AgentSession`.

## Overengineering and Overspecification Considerations

- SOL-01: The solution adds one extension because existing extensions have different responsibilities.
- SOL-02: The solution uses existing Pi events and shared token estimation. It adds no dependency, provider-specific branch, model allowlist, or independent summary format.
- SOL-03: The state machine contains only lifecycle states needed to prevent duplicate compaction, unsafe continuation, and retry loops.
- SOL-04: The optional extension configuration adds only `enabled` and `thresholdDeltaPercent`. Pi model metadata and native compaction settings remain inputs to the effective threshold.

## Open Questions

No unresolved questions remain.

## References

- REF-01: [Problem Statement](problem-statement.md) - Approved problem scope, evidence, and constraints.
- REF-02: [Domain Glossary](domain-glossary.md) - Terms used by this solution.
- REF-03: [Custom compaction extension](../../../extensions/custom-compaction.md) - Existing custom summary behavior.
- REF-04: `pi-package/shared/context-size.ts` - Existing provider-visible token estimation.
- REF-05: `pi-package/extensions/footer/index.ts` - Existing native compaction-settings reader.
- REF-06: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` - Public `context`, `agent_settled`, `ctx.abort()`, and `ctx.compact()` contracts.
- REF-07: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` - Agent settlement, manual compaction, and continuation behavior.
