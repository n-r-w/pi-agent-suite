# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md).

## Context

Pi interprets `websocketConnectTimeoutMs: 0` and `websocketConnectTimeoutMs: "disabled"` as disabling the connect timeout. Pi passes `0` to the provider in both cases.

## Observed problem

- PRM.01: A user who disables the connect timeout can lose WebSocket mode for the session even when the server can open a connection. The first attempt can fail before the server has time to accept it.

## Affected audience

Pi users who use the `openai-websocket` extension with the connect timeout disabled.

## Evidence

With a local endpoint that waited 80 ms before accepting a connection, the extension sent the first request and the next request of the same session over HTTP when the connect timeout was disabled. With a 1,000 ms connect timeout in a fresh session, both requests used WebSocket. The test `waits for and retries a failed handshake when the connection timeout is disabled` in `pi-package/extensions/openai-websocket/index.test.ts` checks that the extension waits past the default connect timeout and retries a real handshake failure.

## Impact

HIGH: The extension can route the rest of the session over HTTP even though the endpoint supports WebSocket.

## Current state in 2.22.5

In `pi-package/extensions/openai-websocket/socket.ts`, `connectWebSocketWithRetry` bypasses retries when Pi passes `0`. The `connectWebSocket` function starts a timer with a delay of `0` ms instead of omitting the timer.

## Desired state

A disabled connect timeout does not cause a working WebSocket endpoint to lose its chance to accept a connection. The user can still cancel and can still recover from failed handshakes.

## Problem boundary

The issue concerns opening a connection. It does not change the OpenAI SDK request timeout or Pi's response timeout.

## Assumptions

None.

## Open questions

None.
