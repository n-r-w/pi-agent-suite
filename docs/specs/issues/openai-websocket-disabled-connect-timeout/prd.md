# Disabled WebSocket connect timeout requirements

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

Keep WebSocket available when the user disables the connect timeout in Pi.

## Affected scenarios

A handshake takes longer than the default time limit, returns a failure, or remains pending until the user cancels.

## Scope and non-scope

The change applies when the extension opens a WebSocket with the connect timeout disabled. Positive time limits, response timeouts, and the HTTP fallback after exhausted retries stay unchanged.

## Requirements

### Functional requirements

- [X] FRQ.01: If Pi disables the connect timeout, the extension applies no time limit of its own to opening a WebSocket. It still retries failed handshakes according to its configured retry count and pause. If the user cancels a handshake or pause, the extension stops without switching the session to HTTP.
  - Origin: PRM.01.
  - Goal: Remove the connection time limit without removing recovery or cancellation.
  - Feasibility: Confirmed. Pi tells the extension when the connect timeout is disabled and supplies a cancellation signal for the request.

### Non-functional requirements

No change to the positive connection time limit specified in the [handshake retry requirements](../../features/openai-websocket-handshake-retry/requirements.md).

## Justification of requirements

| What does not work in 2.22.5 | Requirements that fix it |
| --- | --- |
| PRM.01: Disabling the timeout cuts the first attempt short and bypasses retries. | FRQ.01 |

Sufficiency: The extension can wait for the connection and recover if the first handshake fails.

Necessity: Without FRQ.01, disabling the timeout can still make the extension switch to HTTP before it can recover.

## Critical scenarios

- SCN.01: Recover from a late handshake failure
  - Requirements: FRQ.01, no time limit and configured retries.
  - Level: external.
  - Area: Pi, `openai-websocket`, and the Responses endpoint.
  - Flow: With the connect timeout disabled, the first handshake stays pending past the default timeout and then fails. The extension retries after the configured pause. When the endpoint accepts, the request completes over WebSocket without an HTTP fallback warning.
- SCN.02: Cancel while opening or waiting to retry
  - Requirements: FRQ.01, cancellation.
  - Level: external.
  - Area: Pi and `openai-websocket`.
  - Flow: With the connect timeout disabled, the user cancels during a pending handshake or a retry pause. The extension stops and does not move the session to HTTP.

## Open questions

None.
