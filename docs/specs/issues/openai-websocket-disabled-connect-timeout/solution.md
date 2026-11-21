# Technical solution: Disabled WebSocket connect timeout

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

Pi passes `0` to the extension when the user disables the connect timeout. In `socket.ts`, `connectWebSocketWithRetry` treats that value as the absence of a deadline, and `connectWebSocket` does not start a timer without a deadline. The same retry count, pause, and cancellation rules apply with or without a deadline. For a positive value, the extension still counts the handshake attempts and pauses against one time limit. This serves FRQ.01.

## Overengineering and overspecification considerations

Keep one retry loop for both modes instead of duplicating the retry and cancellation rules. Disabling the connect timeout leaves other request limits in place. Without another limit, a silent peer can keep an attempt pending until the user cancels or the network reports an error.

## Open questions

None.

## References

- [Extension configuration](../../../extensions/openai-websocket.md)
- [Initial handshake recovery](../../features/openai-websocket-handshake-retry/technical-solution.md)
