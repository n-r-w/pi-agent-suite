# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md) for WebSocket handshake, WebSocket mode, and model request.

## Context

The `openai-websocket` extension uses WebSocket mode for OpenAI Responses API requests. A session can use the same connection for multiple requests.

## Observed problem

- PRM.01: A Pi user loses WebSocket mode for the session after one failed handshake, even if the failure is temporary. The user starts a model request that needs a new connection, and the first attempt fails. The extension switches the session to HTTP before another attempt can succeed. One reported example produced `WebSocket handshake failed: error`.

## Affected audience

Pi users who use the `openai` provider in WebSocket mode.

## Evidence

The test cases for handshake failure and connect timeout in `pi-package/extensions/openai-websocket/index.test.ts` check that the current request completes over HTTP. The failure case also checks that the next request goes over HTTP and that Pi warns once.

## Impact

HIGH: After a single failed handshake, the session no longer benefits from incremental model requests over WebSocket. The user can still get a model response over HTTP.

## Current state

In `pi-package/extensions/openai-websocket/websocket-fetch.ts`, `WebSocketExchange.#acquire` tries once to open a new connection. If it fails and the user did not cancel, `createStreamFunction` in `pi-package/extensions/openai-websocket/stream.ts` records that the session uses HTTP.

## Desired state

A transient failure to open a connection does not cost the user WebSocket mode for the session.

## Problem boundary

This problem concerns opening a connection before the extension sends a model request. It does not concern a cancellation, a failure after the request was sent, or a network that continues to block WebSocket connections.

## Assumptions

The reported warning does not identify the cause or establish whether the connection would have opened on another attempt.

## Open questions

None about current behavior.
