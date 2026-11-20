# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md) for WebSocket handshake, WebSocket mode, and model request.

## Context

The `openai-websocket` extension uses WebSocket mode for OpenAI Responses API requests. A session can use the same connection for multiple requests.

## Observed problem

- PRM.01: Before this change, a Pi user lost WebSocket mode for the session after one failed handshake, even if the failure was temporary. When a model request needed a new connection, the extension switched the session to HTTP as soon as the first handshake failed. One reported example produced `WebSocket handshake failed: error`.

## Affected audience

Pi users who use the `openai` provider in WebSocket mode.

## Evidence

At commit `45735d6`, the handshake failure and connect timeout tests in `pi-package/extensions/openai-websocket/index.test.ts` checked that the request completed over HTTP. The failure test also checked that the next request went over HTTP and that Pi warned once.

## Impact

HIGH: After a single failed handshake, the session no longer benefited from incremental model requests over WebSocket. The user could still get a model response over HTTP.

## Behavior before this change

In `pi-package/extensions/openai-websocket/websocket-fetch.ts`, `WebSocketExchange.#acquire` tried once to open a new connection. If the attempt failed and the user had not cancelled, `createStreamFunction` in `pi-package/extensions/openai-websocket/stream.ts` recorded that the session would use HTTP.

## Desired state

A transient failure to open a connection does not cost the user WebSocket mode for the session.

## Problem boundary

This problem concerns opening a connection before the extension sends a model request. It does not concern a cancellation, a failure after the request was sent, or a network that continues to block WebSocket connections.

## Assumptions

The reported warning does not identify the cause or establish whether the connection would have opened on another attempt.

## Open questions

None about current behavior.
