# Technical Solution: Model Response Timeout with Pi Retry

## Problem Statement

- PRB-01: Pi applies idle and provider timeouts but has no total duration limit for one streaming model response.
- PRB-02: A provider can keep a response active by continuing to send data, which consumes output budget, cost, CPU, and memory.
- PRB-03: `run-subagent` publishes activity for every child `message_update`, although Pi does not persist the assistant entry until `message_end`.
- CNS-01: Pi source code and provider implementations must not change.
- CNS-02: The timeout must apply to main and child Pi sessions that load the package.
- CNS-03: Tool execution time must not count toward the model response timeout.
- GOL-01: Bound each provider response, discard incomplete response content, and use Pi's retry lifecycle for recovery.

## Proposed Solution

### Global timeout extension

- SOL-01: Add `pi-package/extensions/model-response-timeout/index.ts` as the single owner of model response timing.
- DEC-01: Register the extension once in `pi-package/package.json`. Main sessions and `run-subagent` children load the same package extension list.
- DEC-02: Start timing on `before_provider_request`. This boundary includes connection, first-token wait, and streaming time.
- DEC-03: Stop timing on assistant `message_end`. Tool execution starts after this boundary and is not timed.

### Configuration

- CFG-01: Read `model-response-timeout/config.json` through the shared suite storage reader.
- CFG-02: The default path is `~/.pi/agent/agent-suite/model-response-timeout/config.json`. `PI_AGENT_SUITE_DIR` replaces `~/.pi/agent/agent-suite` when set.
- CFG-03: A missing file enables the extension with this configuration:

```json
{
  "enabled": true,
  "timeoutSeconds": 300
}
```

- CFG-04: `enabled` is a boolean. `timeoutSeconds` is a positive finite number supported by the runtime timer.
- CFG-05: Unknown fields, malformed JSON, and invalid values disable the extension and produce one startup error. They do not block model requests.
- CFG-06: Configuration is read once when the extension loads. Pi must restart to apply a change.

### Response lifecycle

- ENT-01: One extension instance stores the active response generation, timer, and timeout outcome.
- STP-01: `before_provider_request` creates one timer for the configured duration and assigns a new response generation.
- STP-02: Assistant `message_end` clears the matching timer. A stale callback from an older generation has no effect.
- STP-03: Session start, session replacement, and session shutdown clear the timer and response state.

### Timeout handling

- STP-04: When the timer expires, the extension records the timeout and calls `ctx.abort()`.
- STP-05: The timed-out assistant `message_end` result keeps the assistant role, replaces `content` with an empty array, sets `stopReason` to `error`, and sets this error:

```text
Model response timed out after {timeoutSeconds} seconds.
```

- DEC-04: Empty replacement content prevents partial text, thinking, and `toolCall` data from entering the next provider context.
- DEC-05: The error text matches Pi's transient timeout classification. Pi applies `retry.enabled`, `retry.maxRetries`, and `retry.baseDelayMs` without an extension-owned retry loop.
- DEC-06: The extension does not send hidden continuation messages and does not maintain a separate retry budget.

### Child invocation completion

- STP-06: Pi performs retry attempts before `agent_settled`.
- STP-07: `ChildRpcPromptCompletionState` keeps the invocation pending until `agent_settled`, using Pi's existing `auto_retry_start` and `auto_retry_end` lifecycle.
- STP-08: A successful retry produces the normal child terminal result. Retry exhaustion produces one terminal failure with the timeout error.
- DEC-07: No timeout-specific child interruption marker or supervisor continuation state is required.

### Subagent management screen

- CMP-01: `InvocationSupervisor.handleRpcEvent` does not notify selected-conversation activity listeners for `message_update`.
- DEC-08: `message_update` still passes through presentation and completion reducers. Only the redundant conversation refresh notification is removed.
- STP-09: Finalized assistant messages, tool results, notifications, projection state, and terminal state retain their existing refresh behavior.
- DEC-09: The extension does not assemble or render partial model output.

### Failure handling

- FLR-01: A provider that honors Pi's active abort signal stops after the timer calls `ctx.abort()`.
- FLR-02: A provider that ignores the abort signal cannot be force-stopped through the public extension API. The timeout result remains pending until assistant `message_end`.
- FLR-03: Invalid configuration disables only `model-response-timeout` and emits one startup error.
- FLR-04: Disabled Pi retry or retry exhaustion ends the agent run with the package timeout error.

### Verification

- ACC-01: Config tests cover missing-file defaults, `PI_AGENT_SUITE_DIR`, disabled config, configured duration, malformed JSON, unknown fields, and invalid values.
- ACC-02: A timeout lifecycle test proves that timing starts before provider dispatch, calls `ctx.abort()` once, removes partial content, and returns an error accepted by Pi's retry classifier.
- ACC-03: A response completed before the deadline clears its timer and cannot be affected by a stale callback.
- ACC-04: A long tool execution after assistant `message_end` does not trigger the timeout.
- ACC-05: Existing child completion tests prove successful Pi retry and exhausted retry behavior.
- ACC-06: Supervisor tests prove `message_update` does not request selected-conversation refresh while finalized events still do.
- ACC-07: Package loading tests prove one timeout extension registration.
- ACC-08: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify` must pass.

## Overengineering and Overspecification Considerations

- SOL-02: One extension owns timing for both process roles.
- SOL-03: Pi owns retry count, backoff, cancellation, status rendering, and settlement.
- SOL-04: The solution does not wrap providers, inspect streamed token content, send continuation prompts, or add supervisor-owned timers.
- SOL-05: The management-screen change removes redundant refresh work without adding partial-output assembly or polling.

## Open Questions

No unresolved questions remain.

## References

- REF-01: `pi-package/shared/agent-suite-storage.ts` - Suite-owned extension configuration paths and `PI_AGENT_SUITE_DIR` handling.
- REF-02: `pi-package/extensions/model-response-timeout/index.ts` - Response timer and timed-out assistant replacement.
- REF-03: `pi-package/shared/child-rpc-completion.ts` - Existing Pi retry and child terminal decision lifecycle.
- REF-04: `pi-package/extensions/run-subagent/invocation-supervisor.ts` - Child RPC event routing and activity publication.
- REF-05: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md` - Pi retry settings.
- REF-06: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` - Retry classification, backoff, and `agent_settled` order.
