# Technical solution: WebSocket handshake recovery

## Problem statement

[Problem statement](problem.md) describes how a single failed handshake leaves the session on HTTP.

## Proposed solution

Keep the retry policy in the extension. Its existing configuration reader validates the optional handshake retry settings and supplies their defaults. The extension passes the validated policy to the code that opens a new socket. Pi still supplies the connection timeout; its agent and provider request retries do not control the handshake. This serves FRQ.03 and NRQ.01.

The request exchange selects the retrying socket opener only before the first WebSocket send of the model request. All later acquisitions for that request use the single-attempt opener, including after a connection age-limit response or when Pi starts another exchange to retry the provider request. The pool still handles reuse and calls the selected opener only when it needs a new socket. Give the attempts and pauses one elapsed-time budget. A later attempt receives only the part of the budget that remains, and cancellation interrupts both an active handshake and a pause. A non-positive timeout keeps its existing single-attempt behavior. This serves FRQ.01, FRQ.02 and NRQ.01.

Keep the existing decision to switch the session to HTTP at the request boundary. The socket module returns an opened socket or the final failure. The request code sends the model request only after the socket opens and still distinguishes cancellation from an unavailable WebSocket. After the request is sent, the extension keeps the existing responses to a lost connection, a lost previous response, and a connection age limit. This serves FRQ.01 and FRQ.02.

Pi's retry settings are the alternative to extension-local configuration. They govern the agent or provider request rather than opening a transport connection, and they do not offer a fixed handshake pause. Using them would couple this feature to unrelated failure handling. Giving each handshake its own full timeout would let recovery extend the user's wait. The shared budget avoids this cost, at the expense of fewer attempts when an earlier one consumes most of the time.

## Overengineering and overspecification considerations

The change adds no dependency or retry policy for other extensions. It uses the runtime's abortable timer for waits and preserves the existing one-attempt socket operation. The implementer chooses the local control flow and test fixtures.

## Open questions

None.

## References

- [Requirements and critical scenarios](requirements.md)
- [Accepted target](target-picture.md)
