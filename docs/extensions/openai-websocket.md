# openai-websocket

## Purpose

`openai-websocket` sends model requests of the pi provider `openai` in WebSocket mode of the OpenAI Responses API. Pi 1.4.0 sends each such request over HTTP with the whole context. In WebSocket mode, the extension keeps one connection per session and model. After the first request, it sends only the input items that the conversation added since the previous response, together with the ID of that response.

Pi still builds each request and processes each response. Request fields, usage, retries, abort, and the `before_provider_request` hooks of other extensions work as over HTTP.

## Configuration

The optional configuration file is `~/.pi/agent/agent-suite/openai-websocket/config.json`. `PI_AGENT_SUITE_DIR` replaces `~/.pi/agent/agent-suite` when set.

```json
{
  "enabled": true
}
```

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | `false` returns model requests of the `openai` provider to pi's own HTTP transport. Other providers keep their transport. |

A missing file enables the extension. Unknown fields, malformed JSON, and a non-Boolean `enabled` disable the extension; pi reports one error at session start, and model requests go over HTTP. The extension reads the file when it loads. Restart pi after changing the file.

The extension also follows the pi setting `transport`:

| `transport` | Behavior |
| --- | --- |
| `auto` (pi default), `websocket-cached` | A session reuses its connection and sends incremental requests. |
| `websocket` | Each model request opens its own connection, sends the whole context, and closes the connection. |
| `sse` | Model requests go over HTTP, as without the extension. The setting also moves the `openai-codex` provider of pi to HTTP. |

Pi settings `websocketConnectTimeoutMs` and `httpIdleTimeoutMs` set the handshake timeout and the longest wait between two events of a response. Without `websocketConnectTimeoutMs`, the handshake timeout is 15 seconds.

## Incremental requests

The extension sends an incremental request only when all of these hold:

- the request has a session ID, and `transport` is `auto` or `websocket-cached`;
- the previous response on the connection completed;
- all request fields except `input` equal the fields of the previous request;
- the new `input` starts with the previous `input` followed by the items of the previous response.

For example, an agent request carries 120 input items, and the model answers with a reasoning item and a `read` call. The next request carries the same 120 items, the two items of the answer, and the `read` result. The extension sends only the `read` result and the ID of the answer.

In any other case, the extension sends the whole context on the same connection. This happens after compaction, after a change of the request fields, and for the first request of a resumed session.

After a response completes, the extension builds pi's request body twice without network access to learn the items of the response in the form that pi will send them. The next request on the connection waits for this step.

## Connections

- One connection serves one response at a time. A second request of the same session that starts during a response opens its own connection.
- The extension closes a connection after 5 minutes without use, or before its next request when the connection is 55 minutes old. OpenAI closes connections after 60 minutes.
- When the server no longer holds the previous response (`previous_response_not_found`), the extension sends the whole context once on the same connection.
- When the server reports `websocket_connection_limit_reached` before the response starts, the extension opens a new connection and sends the request once more.
- After an aborted or failed response, the extension closes the connection.
- On `session_shutdown`, the extension closes all connections.

## Fallback to HTTP

When the handshake fails, or the connection closes before the first event of a response, the extension sends the same request over HTTP. Later requests of the session also go over HTTP. Pi shows one warning per session; without the pi interface, the warning goes to stderr.

When the connection fails or stays silent past `httpIdleTimeoutMs` after the response started, the response ends with an error, pi retries it under its `retry` settings, and the session moves to HTTP. An API error and a user abort keep the session in WebSocket mode.

If a pi update stops passing the request transport of the extension to the OpenAI SDK, the extension shows the same warning and moves the session to HTTP.

## Limitations

- Model calls that other extensions make through `completeSimple` of `@earendil-works/pi-ai/compat`, for example `ask_llm`, `consult_advisor`, and custom compaction, use pi's built-in provider and stay on HTTP.
- The handshake does not use an HTTP proxy.
- When pi exits with an open connection, the process waits until the server confirms the close of the connection. In a check on 2026-10-31, `pi -p` exited 2.1 seconds after the end of the session; without the extension, it exited at once.
- The extension supports pi 1.4.0. It relies on pi behavior that pi does not document: pi-ai passes the per-request `fetch` to the OpenAI SDK, and pi calls `onPayload` before the request leaves the process.
