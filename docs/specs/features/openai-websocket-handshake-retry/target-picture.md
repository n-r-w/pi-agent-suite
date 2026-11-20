# WebSocket handshake retry target

## Outcome

A Pi user can recover from a transient failure to open a WebSocket to OpenAI without losing WebSocket mode for the session. If the extension cannot open the connection in time, it keeps the current HTTP fallback.

## Acceptance scenarios

- If the first handshake fails and a retry opens the connection, the extension sends the model request once over WebSocket. The session stays on WebSocket, and Pi does not show the HTTP fallback warning.
- If all attempts fail or the positive `websocketConnectTimeoutMs` budget expires, the extension sends the current and subsequent model requests of the session over HTTP. Pi warns when the extension switches the session to HTTP. The budget covers the attempts and the pauses between them.
- If the user cancels during a handshake or a pause, the extension stops trying without switching the session to HTTP.
- If the user omits the optional `handshakeRetry` block in `openai-websocket/config.json`, the extension tries up to two more times after the first failure and waits 500 ms before each retry. Users can set `maxRetries` and `delayMs` independently. If `maxRetries` is `0`, the extension switches to HTTP on the first handshake failure.

## Scope and decisions

The change covers the `openai-websocket` extension, its tests, and its documentation. Implementation details are delegated within this scope. The extension keeps its behavior after it sends a model request. Pi's settings and dependencies stay unchanged. Fixing the extension's existing handling of a disabled handshake timeout is outside this change.

## Verification and delivery

Run `bun run verify` and check the acceptance scenarios before presenting the complete implementation for review. After acceptance, open a standalone pull request against `main`. Do not merge the pull request.

This directory holds the task documents.
