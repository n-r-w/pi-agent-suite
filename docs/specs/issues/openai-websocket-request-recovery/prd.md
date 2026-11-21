# WebSocket request recovery requirements

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

Keep a Pi session on WebSocket when it can recover from a transient transport failure.

## Affected scenarios

The extension loses a connection before or after the response starts, or it cannot open a replacement connection on the first attempt.

## Scope and non-scope

The change applies to recovery before HTTP fallback in `openai-websocket`. Pi still controls whether to retry a response that failed after it started. The change does not resume a partially streamed response or change Pi's retry settings.

## Requirements

### Functional requirements

- [X] FRQ.01: If a WebSocket drops before its first response event and the request deadline has not expired, the extension tries to resend the request over WebSocket before it falls back to HTTP. If the extension needs a new connection, it retries failed handshakes within the configured limits, even after an earlier send. A recovered failure does not switch the session to HTTP.
  - Origin: PRB.01 and the requirement to try WebSocket before HTTP.
  - Goal: Recover the interrupted request without losing WebSocket mode.
  - Feasibility: Confirmed. The extension controls handshakes and can resend the request before Pi receives response events.
- [X] FRQ.02: If WebSocket fails after the response starts, the extension reports a retryable error instead of restarting the stream or switching the session to HTTP. If Pi retries the request, the retry starts on WebSocket.
  - Origin: PRB.02 and the requirement to try WebSocket before HTTP.
  - Goal: Preserve WebSocket mode without replaying a response inside a stream Pi has started to process.
  - Feasibility: Confirmed. Pi can retry a transport error after the stream ends and invoke the provider again.

### Non-functional requirements

The handshake time limit remains the one in [WebSocket handshake retry requirements](../../features/openai-websocket-handshake-retry/requirements.md).

## Justification of requirements

| What does not work in 2.22.5 | Requirements that fix it |
| --- | --- |
| PRB.01: One loss before the first event or one failed replacement handshake causes a switch to HTTP. | FRQ.01 |
| PRB.02: The extension marks the session for HTTP before Pi can try WebSocket again. | FRQ.02 |

Sufficiency: Each failure follows a retry path that can keep the session on WebSocket.

Necessity: Without FRQ.01, the extension can still switch to HTTP before Pi starts the response. Without FRQ.02, the extension can still switch to HTTP after the response starts.

## Critical scenarios

- SCN.01: Recover a request before the first response event
  - Requirements: FRQ.01, lost connection.
  - Level: external.
  - Area: Pi, `openai-websocket`, and the Responses endpoint.
  - Flow: The endpoint drops the connection without sending a response event. The extension tries WebSocket again. When the endpoint answers, Pi gets the response without an HTTP fallback warning. If the endpoint keeps dropping each connection, the extension sends the request over HTTP after the retry limit.
- SCN.02: Open a replacement connection after a failed handshake
  - Requirements: FRQ.01, replacement handshake.
  - Level: external.
  - Area: `openai-websocket` and the Responses endpoint.
  - Flow: A sent request needs a replacement connection. The endpoint rejects the first handshake and accepts a retry. The extension sends the request over WebSocket instead of HTTP.
- SCN.03: Retry an interrupted response
  - Requirements: FRQ.02.
  - Level: external.
  - Area: Pi, `openai-websocket`, and the Responses endpoint.
  - Flow: The endpoint sends response events and then drops the connection or stops sending events. Pi gets a retryable error, not a new stream. When Pi retries, the endpoint receives a new WebSocket request. Pi gets the completed answer without an HTTP fallback warning.

## Open questions

None.
