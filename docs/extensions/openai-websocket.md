# openai-websocket

## Purpose

`openai-websocket` sends model requests of the pi provider `openai` in WebSocket mode of the OpenAI Responses API. Without this extension, Pi sends each such request over HTTP with the whole context. In WebSocket mode, the extension keeps one connection per session and model. After the first request, it sends only the input items that the conversation added since the previous response, together with the ID of that response.

Pi still builds each request and processes each response. Request fields, usage, retries, abort, and the `before_provider_request` hooks of other extensions work as over HTTP.

## Configuration

The optional configuration file is `~/.pi/agent/agent-suite/openai-websocket/config.json`. `PI_AGENT_SUITE_DIR` replaces `~/.pi/agent/agent-suite` when set.

```json
{
  "enabled": true,
  "handshakeRetry": {
    "maxRetries": 2,
    "delayMs": 500
  }
}
```

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | `false` returns model requests of the `openai` provider to Pi's own HTTP transport. Other providers keep their transport. |
| `handshakeRetry.maxRetries` | Non-negative safe integer | `2` | Number of retries when a handshake fails or a connection drops before the first response event. Each connection opening and each request exchange have their own retry count. `0` disables both kinds of retry. |
| `handshakeRetry.delayMs` | Non-negative safe integer | `500` | Milliseconds to wait before each handshake retry or request resend after a connection loss. `0` retries without a pause. |

The `handshakeRetry` object and both of its fields are optional. For example, `{"handshakeRetry":{"maxRetries":1}}` allows one retry in each case and keeps the 500 ms pause.

A missing file enables the extension with the defaults. If the extension cannot read the file or finds invalid JSON, an unknown field, or a value of the wrong type, it stays disabled. Pi reports one error at session start, and the `openai` provider uses Pi's built-in HTTP transport. The extension reads the file when it loads. Restart Pi after changing the file.

The extension also follows the pi setting `transport`:

| `transport` | Behavior |
| --- | --- |
| `auto` (pi default), `websocket-cached` | A session reuses its connection and sends incremental requests. |
| `websocket` | Each model request opens its own connection, sends the whole context, and closes the connection. |
| `sse` | Model requests go over HTTP, as without the extension. The setting also moves the `openai-codex` provider of pi to HTTP. |

A positive Pi setting `websocketConnectTimeoutMs` limits the total time the extension spends opening a connection, including handshake retries and pauses. If you omit the setting, the limit is 15 seconds. Set it to `0` or `"disabled"` to remove this limit without disabling retries. For example, with `0` and the default `handshakeRetry` settings, the extension still retries a failed handshake up to two times.

Pi uses `httpIdleTimeoutMs` for response timeouts unless the request's `timeoutMs` or `retry.provider.timeoutMs` overrides it. Before the first response event, the OpenAI SDK also applies its request timeout to the exchange, including any retries inside it.

## Incremental requests

The extension sends an incremental request only when all of these hold:

- the request has a session ID, and `transport` is `auto` or `websocket-cached`;
- the previous response on the connection completed;
- all request fields except `input` equal the fields of the previous request;
- the new `input` starts with the previous `input` followed by the items of the previous response;
- pi parsed the arguments of each tool call in the previous response. When pi cannot parse them, it sends `{}` instead, while the server keeps the original text.

For example, an agent request carries 120 input items, and the model answers with a reasoning item and a `read` call. The next request carries the same 120 items, the two items of the answer, and the `read` result. The extension sends only the `read` result and the ID of the answer.

In any other case, the extension sends the whole context on the same connection. This happens after compaction, after a change of the request fields, and for the first request of a resumed session.

After a response completes, the extension builds pi's request body twice without network access to learn the items of the response in the form that pi will send them. The next request on the connection waits for this step.

## Connections

- One connection serves one response at a time. A second request of the same session that starts during a response opens its own connection.
- The extension closes a connection after 5 minutes without use, or before its next request when the connection is 55 minutes old. OpenAI closes connections after 60 minutes.
- When the server no longer holds the previous response (`previous_response_not_found`), the extension sends the whole context once on the same connection.
- When the server reports `websocket_connection_limit_reached` before the response starts, the extension opens a new connection and sends the request once more.
- After an aborted or failed response, the extension closes the connection. When a later request of the session already took over the connection, the extension keeps it for that request.
- On `session_shutdown`, the extension closes all connections.

## Recovery and fallback to HTTP

If a handshake fails, the extension retries up to the configured count and stops sooner if the connection timeout expires. The same rule applies when the extension needs a replacement connection, for example when Pi retries a model request. If the connection drops before the first response event, the extension discards that connection and tries to resend the request over WebSocket. On a new connection it sends the full context, not just the new input items. For example, with the defaults, if the first two connections drop before the first event and the third answers, the request completes over WebSocket without a fallback warning.

If the handshake attempts run out, the connection budget expires, or every resend loses its connection before the first event, the extension sends the request over HTTP. Once the extension switches the session to HTTP, retries of that request and later requests in the session also use HTTP. The extension shows at most one HTTP fallback warning per load. Without Pi's interface, the extension writes the warning to stderr.

If the connection drops or the idle timeout expires after the first response event, the extension ends the response with an error instead of resending it. If the SDK request deadline expires before the first event, the SDK ends the request. In either case, when Pi retries under its `retry` settings, it starts over on WebSocket. The error itself does not switch the session to HTTP. If you cancel during a handshake or a retry pause, the extension stops without switching to HTTP.

The extension does not switch to HTTP for an OpenAI API error. If the error arrives before the response stream starts, the extension gives Pi the error's HTTP status and headers, such as `retry-after`. Pi uses those fields to decide whether and when to retry.

If a Pi update stops passing the request transport of the extension to the OpenAI SDK, the extension shows the same warning and moves the session to HTTP.

## Limitations

- Model calls that other extensions make through `completeSimple` of `@earendil-works/pi-ai/compat`, for example `ask_llm`, `consult_advisor`, and custom compaction, use pi's built-in provider and stay on HTTP.
- The handshake does not use an HTTP proxy.
- When pi exits with an open connection, the process waits until the server confirms the close of the connection. In a check on 2026-10-31, `pi -p` exited 2.1 seconds after the end of the session; without the extension, it exited at once.
- The extension relies on two undocumented behaviors of Pi's OpenAI Responses provider. In Pi 1.6.1, the provider passes the per-request `fetch` to the OpenAI SDK and calls `onPayload` before sending the request.
