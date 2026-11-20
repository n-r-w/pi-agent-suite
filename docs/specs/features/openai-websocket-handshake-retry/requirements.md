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
- [X] FRQ.02: If the retry limit is reached or the connection timeout expires without opening a connection, the extension warns as it switches to HTTP for the current and subsequent model requests of the session. If the user cancels while the extension is connecting or waiting to retry, it stops without switching to HTTP.
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

## Open questions

None.

## References

[WebSocket handshake retry target](target-picture.md).
