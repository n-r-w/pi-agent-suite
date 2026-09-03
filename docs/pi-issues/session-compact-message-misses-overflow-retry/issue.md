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

## Version

0.84.4
