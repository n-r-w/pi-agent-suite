# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md).

## Context

The `openai-websocket` extension sends OpenAI model requests over WebSocket. Version 2.22.5 retries failed handshakes before the first send of a model request.

## Observed problem

- PRM.01: A single transport failure after the extension sends a model request can leave the user on HTTP for the rest of the session, even when WebSocket is available again.
  - PRB.01: The user is waiting for the response to start. If the connection drops before the first event, the extension resends the request over HTTP without trying another WebSocket. If a request needs a replacement connection after the first send, one failed handshake also triggers HTTP.
  - PRB.02: The user is receiving a response when the connection drops or the response stalls. The extension ends the response and moves the session to HTTP, so Pi cannot retry over WebSocket in that session.

## Affected audience

Pi users who send requests to the `openai` provider over WebSocket.

## Evidence

A reported session showed `WebSocket connection lost: error` and a warning that requests in the session would use HTTP. The report does not show whether the response had started. In 2.22.5, the failure tests in `pi-package/extensions/openai-websocket/index.test.ts` expect HTTP after a lost connection before the first event and for subsequent requests after a loss during the response.

## Impact

HIGH: Pi stops using WebSocket for the session. It sends the full context over HTTP for later requests instead of continuing on WebSocket and sending only new input items when the previous response is reusable.

## Current state in 2.22.5

In `pi-package/extensions/openai-websocket/websocket-fetch.ts`, `WebSocketExchange.#acquire` uses a single handshake attempt after the first send. On connection loss, `WebSocketExchange.#respond` switches to HTTP before the first event, and `EventStreamBody.stream` switches the session to HTTP after the first event. In `pi-package/extensions/openai-websocket/stream.ts`, `createStreamFunction` remembers the switch for that session.

## Desired state

A transient WebSocket failure does not cost the user WebSocket mode for the session.

## Problem boundary

The failure must concern the WebSocket transport. An API rejection, user cancellation, explicit HTTP mode, and failures of other providers are outside the problem.

## Assumptions

The reported warning does not identify the cause of the loss or show whether another connection would have opened.

## Open questions

None about the behavior that makes the session switch to HTTP.
