# `session_compact` custom message misses the immediate overflow retry

## What happened?

In `@earendil-works/pi-coding-agent` 0.84.4, a `session_compact` handler can restore provider-visible context with `pi.sendMessage(..., { triggerTurn: false })`. During overflow recovery, Pi queues that message until the retried turn ends. The immediate retry therefore runs without the restored context.

This affects extensions that republish exact state after compaction. The compaction summary is applied, but the first request after overflow recovery cannot see the state published by `session_compact`.

## Steps to reproduce

The attached `index.ts` is a standalone reproduction extension. The attached `settings.json` contains its compaction settings.

With no other extensions loaded, select the registered `overflow-retry-repro` model and send two prompts. The fake provider completes the first request, returns a deterministic overflow on the second request, and checks the context received by the automatic retry. The extension supplies a compaction result and publishes `RESTORED_CONTEXT_MARKER` from `session_compact`.

On 0.84.4, the retried request reports:

```text
BUG REPRODUCED: restored context was missing from the overflow retry.
```

## Expected behavior

A passive custom message published by `session_compact` must be included in the immediate overflow retry. The reproducer should report:

```text
EXPECTED BEHAVIOR: restored context reached the overflow retry.
```

The message must remain after completed tool results and must not be inserted between an assistant tool call and its result.

## Same delay after threshold compaction between turns

In `@earendil-works/pi-coding-agent` 1.3.0, the same delay occurs when Pi compacts by threshold inside an active run, before the next assistant response. This finding comes from reading the Pi 1.3.0 source in `dist/core/agent-session.js`; it was not reproduced.

- `_compactBeforeNextAssistantResponse` runs auto-compaction, and `session_compact` handlers run while the run is active.
- `sendCustomMessage` pushes a message with `triggerTurn: false` into `_pendingCustomMessages` while the run is active, and the `turn_end` handler appends pending messages to the session.
- At this point, the previous turn has ended and its tool results are already in the session, so appending the message cannot split a tool call from its result. Pi still defers the message, and the next assistant response is generated without it. The message reaches the context only from the request after that response.
- `deliverAs: "steer"` delivers the message before the next response on this path. After threshold compaction at the end of a run, however, a steered message starts an extra assistant turn, because Pi continues the run while queued messages exist. No delivery option reaches the next request on every compaction path without starting a turn.

In this package, `mcp-wrapper` republishes MCP server instructions and `workflow` publishes activation options from `session_compact` with `triggerTurn: false`. After threshold compaction between turns, the model answers once without this context.

Expected behavior: a passive custom message published by `session_compact` during threshold compaction between turns reaches the next assistant request.

## Temporary test skip

The integration test `overflow compaction retries after passive context restoration` in `test/integration/compaction-overflow-retry.test.ts` is temporarily disabled with `test.skip` to unblock the current branch release. The failure was confirmed with Pi 0.85.1: the retry context contains no `restored-context` custom message. The test assertions remain unchanged.

A test-local `biome-ignore lint/suspicious/noSkippedTests` comment permits this temporary skip. Remove both `test.skip` and the suppression comment after upgrading to a Pi version that fixes this issue, and confirm that the test passes. The threshold interruption test in the same file remains enabled.

## Version

0.84.4
