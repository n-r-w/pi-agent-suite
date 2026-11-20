# WebSocket handshake retry requirements

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

Keep a Pi session in WebSocket mode when it can recover from a transient handshake failure.

## Affected scenarios

A model request needs a new connection. The first handshake fails, later attempts succeed or fail, or the user cancels the request.

## Scope and non-scope

The requirements apply before the extension sends the model request. Other providers, Pi retry settings, and recovery after sending the request stay unchanged. Handling a disabled connection timeout is outside scope.

## Requirements

### Functional requirements

- [X] FRQ.01: If a new WebSocket does not open, the extension retries opening it until an attempt succeeds, the retry limit is reached, or the connection timeout expires. On success, the extension sends the current model request once over WebSocket. A recovered failure does not switch the session to HTTP or produce an HTTP fallback warning.
  - Origin: PRM.01 and the recovery scenario in [WebSocket handshake retry target](target-picture.md).
  - Goal: Recover before sending the model request.
  - Feasibility: Confirmed. The extension detects handshake failures before it sends the model request.
- [X] FRQ.02: If the retry limit is reached or the connection timeout expires without opening a connection, the extension warns as it switches to HTTP for the current model request and later requests with the same Pi session ID. If the user cancels while the extension is connecting or waiting to retry, it stops without switching to HTTP.
  - Origin: PRM.01 and the fallback and cancellation scenarios in [WebSocket handshake retry target](target-picture.md).
  - Goal: Preserve HTTP recovery without treating a cancellation as a transport failure.
  - Feasibility: Confirmed. The extension already receives the cancellation signal and can send the model request over HTTP when an open fails.
- [X] FRQ.03: The extension accepts an optional `handshakeRetry` block in its configuration. `maxRetries` counts attempts after the first and defaults to `2`. `delayMs` sets the fixed pause before each retry and defaults to `500` ms. If only one field is present, the other keeps its default. With `maxRetries: 0`, the extension switches to HTTP on the first handshake failure.
  - Origin: PRM.01 and the configuration scenario in [WebSocket handshake retry target](target-picture.md).
  - Goal: Let users adjust the recovery for their connection without changing Pi's model-request retries.
  - Feasibility: Confirmed. The extension reads its own configuration before registering the provider.

### Non-functional requirements

- [X] NRQ.01: When Pi supplies a positive `websocketConnectTimeoutMs`, the extension stops trying to open a new connection when that much time has elapsed since the first attempt began. Without a value from Pi, the budget is 15 seconds. The budget includes each attempt and the pauses before retries. Verify the limit in a controlled time test that observes the start of the handshake and the transition to HTTP.
  - Origin: PRM.01 and the timeout scenario in [WebSocket handshake retry target](target-picture.md).
  - Goal: Avoid extending the connection timeout when recovering from a failure.
  - Feasibility: Confirmed. Pi passes the timeout to the extension, and the extension controls whether and when to open another connection.

## Justification of requirements

| What does not work now | Requirements that fix it |
|---|---|
| PRM.01: The session switches to HTTP at the first failed handshake. | FRQ.01, FRQ.02, FRQ.03, NRQ.01 |

Sufficiency: The extension can recover from a failed handshake before it sends the model request, while retaining the fallback and cancellation paths.

Necessity: All four requirements apply to PRM.01 under its accepted recovery, fallback, configuration, and time budget constraints.

## Critical scenarios

- SCN.01: Recover from a transient handshake failure
  - Requirements: FRQ.01, FRQ.03 (defaults)
  - Level: external.
  - Area: Pi, `openai-websocket`, and the OpenAI Responses endpoint.
  - Flow: With default settings, the endpoint rejects the first two handshakes and accepts the third. The extension waits 500 ms before each retry. The endpoint receives the model request once over WebSocket. Pi shows no HTTP fallback warning, and the next request of the session uses WebSocket.
- SCN.02: Exhaust the configured retry count
  - Requirements: FRQ.02 (fallback), FRQ.03 (`maxRetries` override, omitted `delayMs`, and retries disabled)
  - Level: external.
  - Area: Pi, `openai-websocket`, and the OpenAI Responses endpoint.
  - Flow: The endpoint rejects each handshake. The extension tries no more than the configured number of retries and uses the default pause when `delayMs` is omitted. With `maxRetries: 0`, the first failure ends the attempts. The current model request and the next request with the same Pi session ID use HTTP, and Pi shows the fallback warning once.
- SCN.03: Reach the connection timeout during recovery
  - Requirements: FRQ.02 (fallback), FRQ.03 (`delayMs` override and omitted `maxRetries`), NRQ.01
  - Level: external.
  - Area: Pi, `openai-websocket`, and the OpenAI Responses endpoint.
  - Flow: The first handshake fails, and the next attempt starts after a configured pause. If the endpoint does not finish that handshake, the extension switches to HTTP within the original connection budget rather than restarting the timeout. If the configured pause alone would consume the remaining budget, the extension starts HTTP fallback by the original deadline without opening another connection.
- SCN.04: Cancel while opening a connection or waiting to retry
  - Requirements: FRQ.02 (cancellation during a handshake and during a pause)
  - Level: external.
  - Area: Pi, `openai-websocket`, and the OpenAI Responses endpoint.
  - Flow: The user cancels while the extension is opening a connection or waiting between attempts. No further handshake or HTTP fallback follows, and the next model request can use WebSocket.

## Open questions

None.

## References

[WebSocket handshake retry target](target-picture.md).
