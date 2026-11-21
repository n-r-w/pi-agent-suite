# Technical solution: WebSocket request recovery

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

Keep each resend count with the request exchange in `websocket-fetch.ts`. Reuse the retry count and pause from `handshakeRetry`. When a connection fails before the first response event, release it before waiting to resend. Use the original request body to build the replacement request. On a new connection, the extension sends the whole context because the previous connection's response ID is not available there. The extension does not know whether OpenAI started generating the lost response. A resend can therefore repeat model work, as the previous HTTP fallback could. This serves FRQ.01.

Use the same handshake retry policy for initial and replacement connections. Each opening has its own time limit unless the user [disables the connect timeout](../openai-websocket-disabled-connect-timeout/solution.md). The SDK request deadline still bounds the exchange before the first event. Send the request over HTTP when the extension runs out of handshake attempts, connection time, or resends. Keep the HTTP session decision after that fallback. An abort during recovery leaves the session on WebSocket. This serves FRQ.01.

After the first response event, release a failed connection and report the error to Pi. Pi decides whether to start a new request under its existing retry settings. An SDK request timeout before the first event also leaves the retry to Pi. Neither error marks the session for HTTP. If Pi's retry opens a new connection and the handshake fails, the same handshake retry policy applies. This serves FRQ.02.

## Overengineering and overspecification considerations

There is no separate configuration for request resends or tracking across Pi retries. An in-stream retry inside the extension could mix events from two attempts in one response. Letting Pi own retries at that point avoids that risk. The trade-off is that if every attempt fails only after the response starts, Pi can finish with an error without trying HTTP. The extension changes neither the agent retry limit nor the request deadline.

## Open questions

None.

## References

- [Initial handshake recovery](../../features/openai-websocket-handshake-retry/technical-solution.md)
- [Extension configuration and recovery](../../../extensions/openai-websocket.md)
