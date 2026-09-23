# Technical Solution: Retry timed-out model responses

## Problem Statement

See [problem.md](problem.md). In Pi 0.87, `ctx.abort()` cancels the agent run. Pi's built-in retry policy does not restart a cancelled run.

## Proposed Solution

- `model-response-timeout/config.ts` accepts `maxRetries` as a positive safe integer, defaulting to `3`. It counts additional requests after the initial request.
- The extension starts its timer at `before_provider_request` and clears it at assistant `message_end`. On expiration, it calls `ctx.abort()` and replaces the interrupted assistant response with empty content and a timeout error.
- While retry budget remains, `turn_end` adds a `context_edit` that excludes the interrupted assistant response from later provider requests. The same boundary appends a context-free `model-response-timeout.retry-scheduled` entry before Pi emits `agent_settled`.
- The extension starts the next agent run from `agent_settled` with a hidden custom message. Its `context` handler removes that message from provider context. The retry does not append a second user message.
- `child-rpc-completion.ts` consumes each `entry_appended` event for the retry-scheduled entry. It ignores the immediately following `agent_settled`, then waits for the next response. A final timed-out response with no new retry entry produces a failure on settlement.
- Successful assistant responses reset the timeout retry count. Session start and shutdown clear pending timers and retry state. A user abort without timer expiration does not create a retry entry.

## Overengineering and Overspecification Considerations

The extension owns one bounded retry count. A custom entry informs the parent without adding model context or a second child protocol. Pi and its provider implementations remain unchanged.

## Open Questions

None.

## References

- `pi-package/extensions/model-response-timeout/index.ts` - Timeout and retry lifecycle.
- `pi-package/shared/model-response-timeout-protocol.ts` - Shared marker contract.
- `pi-package/shared/child-rpc-completion.ts` - Child invocation completion.
