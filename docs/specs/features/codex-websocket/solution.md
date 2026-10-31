# Technical Solution: WebSocket mode for the OpenAI provider

## Problem Statement
Each model request through the pi provider `openai` takes about 5 seconds longer than through `openai-codex`, because pi sends it as a full request over HTTP. Agent runs with many tool calls take 18 to 33% longer. The aliases stay on `openai` for its higher cache hit share. See [problem.md](problem.md), [terms.md](terms.md), and the requirements in [prd.md](prd.md).

## Proposed Solution
A new package extension `openai-websocket` registers a stream function for the built-in provider `openai`. The function runs pi's own `openai-responses` implementation and gives it a per-request `fetch` that sends the Responses request in WebSocket mode. Within a session, the extension reuses the connection and sends incremental requests when the conversation continues the previous response.

### Integration point
The extension calls `pi.registerProvider("openai", ...)` with `api: "openai-responses"` and a `streamSimple` function. In pi-coding-agent 1.4.0, `composeModelProvider` in `dist/core/provider-composer.js` keeps the built-in models and the authentication of `openai`, including Sign in with ChatGPT, and calls the extension function for each model whose `api` is `openai-responses`.

The function calls `openAIResponsesApi().streamSimple` from `@earendil-works/pi-ai/compat` with the same options and its own `fetch`. `stream` in `dist/api/openai-responses.js` of pi-ai 1.4.0 passes `options.fetch` to the OpenAI SDK client. Pi passes the session ID, the `transport` setting, `httpIdleTimeoutMs`, and `websocketConnectTimeoutMs` to the stream options (`dist/core/sdk.js` of pi-coding-agent).

So pi keeps request construction, the fields that Sign in with ChatGPT rejects, usage accounting, retries, abort handling, and the `before_provider_request` hooks of the package. This serves FRQ-01: the agent receives the result of the same pi code as over HTTP.

### Data structures
- Connection pool. The extension keeps open connections in one in-process map. The key combines the session ID, the model, and a SHA-256 digest of the WebSocket URL and the handshake headers. The digest keeps the token out of the key in clear text, and a refreshed token gives a new key, so the extension opens a new connection for it. An entry holds the socket, the time of the handshake, the time of the last use, a busy flag, and the continuation record.
- Continuation record, one for each connection: the last request in its full form, the ID of its response, the items of that response in the form that pi will send them in the next request, and a flag that these items are ready.
- HTTP sessions: the session IDs that moved to HTTP after a failure of WebSocket mode.

One connection serves one model request at a time. When a second model request of the same session starts while the connection is busy, the extension opens another connection for it. The data needs no locks: all requests of a pi process run on one JavaScript thread, and each subagent runs in its own pi process with its own pool.

### Sending a model request
The `fetch` of the extension takes only a `POST` to a path that ends with `/responses` and carries a JSON body without `background: true`. It passes every other request to the original `fetch` unchanged.

For a Responses request, the extension:
- changes the URL scheme from `https` to `wss`, which gives `wss://api.openai.com/v1/responses`;
- opens the connection with the request headers, without the headers that describe an HTTP body, such as `content-type` and `content-length`;
- sends the body as one `response.create` message without the field `stream`, the shape that the probe of 2026-10-31 used;
- returns to the SDK a response with status 200 whose body repeats each received event in server-sent event format, so the SDK decoder and pi's event processing read it as over HTTP;
- turns an error event with an HTTP status before the first response event into an HTTP error response with the status and the response headers of the event (`error.headers`, such as `retry-after` and `x-should-retry`), so pi formats and retries it as over HTTP.

The connect timeout is the pi setting `websocketConnectTimeoutMs`, and the timeout between events is `httpIdleTimeoutMs`.

The probe connected without the header `OpenAI-Beta`, and the `openai-codex` provider of pi removes it before the handshake. The extension sends no beta header.

### Incremental requests
The extension sends an incremental request only when all of these hold:
- the setting `transport` is `auto` or `websocket-cached`, and the request has a session ID;
- the connection holds a continuation record whose response items are ready;
- all fields of the new request except `input` equal the fields of the recorded request;
- the new `input` begins with the recorded `input` followed by the recorded response items;
- pi parsed the arguments of each tool call in the recorded response. Pi replaces arguments that it cannot parse with `{}` and sets `argumentsError`, while the server keeps the original text, so only a full request gives the model the same context as over HTTP.

Then the message carries `previous_response_id` and only the remaining input items. In any other case the extension sends a full request on the connection. A full request is always correct and only slower.

For example, an agent request carries 120 input items, and the model answers with a reasoning item and a `read` call. The next request carries the same 120 items, the two items of the answer, and the `read` result. The extension sends only the `read` result and the ID of the answer.

The recorded response items must equal what pi will send, item by item. The raw `output` of the server differs from pi's serialization: per the OpenAI SDK types, a server `function_call` may carry `status`, and `output_text` may carry `logprobs`, while pi's `convertResponsesMessages` writes neither. A baseline from the raw output would make the prefix check fail on almost every turn, and every request would be full.

The extension loader of pi maps only the pi-ai entry points `compat`, `models`, `oauth`, and `providers/all` (`dist/core/extensions/loader.js`), so an extension cannot call `convertResponsesMessages` of the running pi. Therefore, after a response finishes, the extension runs pi's `openai-responses` request construction twice for a context without network access:
1. a context with only the finished assistant message and the session's tool declarations;
2. a context with only the same tool declarations.

In each run, the extension's `onPayload` receives the finished body, saves its `input`, and throws, which stops the run before the client sends anything. The first `input` without the prefix from the second one gives the response items. The prefix exists because pi 1.4.0 can place tool declarations in `input` for models that support conversation-local declarations. Pi adds a placeholder `function_call_output` for each tool call without a result, so the extension drops tool outputs from the response items, as pi's `openai-codex` provider does. This method follows `pi-openai-websocket` by angribot.

The capture runs with the extension's own `onPayload`, so the `before_provider_request` hooks of the package, for example the response timer of `model-response-timeout`, do not run for it. Real model requests still pass through pi's `onPayload` and these hooks.

The capture starts when pi finishes the response, and the next request on the connection waits for it. The capture takes milliseconds, and without the wait a fast tool would make the next request full. A response that ends with an error or an abort clears the record.

A request field that pi computes from the context size changes the request, so the request is full. For example, pi lowers `max_output_tokens` when the context approaches the context window. Sign in with ChatGPT omits this field.

### Connection lifecycle
- The extension closes a connection after 5 minutes without use or 55 minutes after its handshake. OpenAI closes connections after 60 minutes. A timer checks the pool once a minute while the pool has connections.
- When the server rejects an incremental request with `previous_response_not_found`, the extension forgets the record and sends the full request once on the same connection. This serves SCN-06.
- When the server reports `websocket_connection_limit_reached` before the response starts, the extension opens a new connection and retries once. This serves SCN-10.
- After an aborted or failed response, the state of the server is unknown, so the extension closes that connection. This includes a response that the server completed while pi ended it with an abort or an error, for example when the user aborts during the processing of `response.completed`; the extension then closes the connection unless a later request already took it over: the connection is busy, or it holds the record of a later response.
- On `session_shutdown`, and through `registerSessionResourceCleanup` of pi-ai for modes without session teardown, the extension closes all connections.
- A new pi process starts with an empty pool, so the first model request of a resumed session is full. This serves SCN-08.

### Fallback and switching off
- With `"enabled": false` in `openai-websocket/config.json` of the agent suite directory, the extension registers no stream function, and pi sends `openai` requests over HTTP. Other providers keep their transport. A missing file enables the extension; an invalid file disables it and pi reports one error at session start. This serves FRQ-03.
- With `transport: "sse"`, the extension calls pi's implementation without its `fetch`, and requests go over HTTP. This pi setting also moves the `openai-codex` provider to HTTP.
- With `transport: "websocket"`, each model request opens its own connection and sends a full request, as the pi setting describes.
- When the handshake fails, or the connection closes before the first event, the extension passes the same request to the original `fetch` and marks the session as HTTP. pi-ai repeats a failed request through the same `fetch`, so the repeats of that request also go to the original `fetch`. The user sees one warning per session through the pi interface, or on stderr without an interface. This serves FRQ-02.
- When the connection fails after the response started, the stream ends with an error, pi retries under its retry settings, and the session moves to HTTP. A user abort and an API error do not move the session.
- A model call without a session ID opens its own connection, sends a full request, and closes the connection after the response.
- Package extensions such as `ask_llm`, `consult_advisor`, and custom compaction call the model through `completeSimple` of `@earendil-works/pi-ai/compat`. That function uses pi's built-in provider without the extension's stream function, so these calls stay on HTTP and keep their current result.

If a pi update stops passing `options.fetch` to the SDK, the extension's `fetch` receives no call. After such a response, the extension marks the session as HTTP and shows the same warning, so the user learns that WebSocket mode is lost.

### Critical scenarios
| Scenario | Mechanism |
|---|---|
| SCN-01 agent turn with tool calls | integration point, pooled connection, incremental requests |
| SCN-02 subagent run | the same mechanisms in the child pi process, which loads the package |
| SCN-03 call outside the agent loop | `completeSimple` of package extensions uses pi's built-in provider over HTTP |
| SCN-04 WebSocket unavailable | fallback to the original `fetch`, HTTP session, warning |
| SCN-05 connection lost during a response | stream error, pi retry, HTTP session |
| SCN-06 server lost the previous response | full request once on the same connection |
| SCN-07 user aborts | pi abort handling; the extension closes the connection |
| SCN-08 resumed session | empty pool, first request full |
| SCN-09 history changes | the prefix check fails, full request |
| SCN-10 session longer than one hour | 55-minute limit, retry on a new connection |
| SCN-11 return to HTTP | `"enabled": false` in the extension configuration, or `transport: "sse"` |

### Verification
- Unit tests next to the extension use a fake WebSocket server and fake `fetch`, as the testing rules of the project require. They cover the choice between full and incremental requests, the baseline capture, the fallback cases, abort, `previous_response_not_found`, the connection limit, pool expiry, and the case where pi does not call the injected `fetch`.
- `pi --no-session -p -e ./pi-package/extensions/openai-websocket/index.ts` checks that the extension loads.
- NRQ-01 and NRQ-02 need live model requests, so the user measures them by the method in the PRD. First results: [measurements.md](measurements.md).

### Documentation
The change adds `docs/extensions/openai-websocket.md`, a line in `README.md`, and the extension entry in `pi-package/package.json`.

### Trade-offs
- The extension depends on behavior of pi that its documentation does not promise: pi-ai passes `options.fetch` to the SDK, pi composes an extension `streamSimple` with a built-in provider, and the request construction calls `onPayload` before the network. A pi update can break any of them. The development dependencies pin pi 1.4.0, so unit tests show a break after an upgrade, and the check of the injected `fetch` turns a silent loss into a warning and HTTP.
- The extension does not use an HTTP proxy for the handshake. Pi 1.4.0 runs on Node, and the PRD excludes proxies.
- Each finished response costs two extra builds of the request body on the CPU, without network access.
- The design repeats the approach of `pi-openai-websocket` by angribot, which is under the MIT license. Code copied from it keeps its copyright notice.

### Alternatives
- Switch the model aliases to `openai-codex`: requests become fast, but the cache hit share drops from 94.6 to 95.2% to 91.5%. This uses more of the subscription quota.
- Install `pi-openai-toolkit`: it takes the baseline from the raw server output, so incremental requests would rarely happen. It also turns on its own compaction and web search by default.
- Install `pi-openai-websocket`: the transport would live outside this package, and its updates would come from a third party with access to the OAuth token.
- Patch pi-ai in place: the next pi update overwrites the patch.
- Write a separate stream implementation, as `openai-codex` does in about 590 lines: it would repeat pi's request construction and event handling, and the package would have to follow each change of them.

## Overengineering and Overspecification Considerations
Each element has a reason:
- Connection pool: NRQ-01 needs one connection for the requests of a session.
- Continuation record and prefix check: NRQ-01 needs incremental requests, and a request that does not continue the record must stay full.
- Baseline capture through `onPayload`: the raw server output does not match pi's serialization, and extensions cannot reach `convertResponsesMessages`.
- HTTP sessions and the warning: FRQ-02.
- Retry after `previous_response_not_found`: the server keeps only the last response of a connection, and pi's `openai-codex` provider handles the same error.
- Retry after the connection limit: OpenAI closes connections after 60 minutes, and agent sessions last longer.
- Configuration file with `enabled`: the user chose a switch that returns `openai` to HTTP and keeps the transport of `openai-codex`.
- Check of the injected `fetch`: pi releases change internal behavior, and without the check a lost WebSocket mode would look like a slow provider.

The solution leaves out: a statistics command, removal of parameters that a relay rejects, proxy support, the `OpenAI-Beta` header, prewarming with `generate: false`, and a setting with a list of providers. No requirement or observed case needs them.

The implementer decides the module layout, names, the text of the warning, and the exact test cases.

## Open Questions
None.

## References
- `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js`, `composeModelProvider`: composition of an extension stream function with the built-in provider and its authentication.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js`, `buildRequestOptions` and the agent options: session ID, `transport`, timeouts, and `onPayload` passed to providers.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`: the pi-ai entry points available to extensions.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`, `stream`, `createClient`, and `buildParams`: request construction and the per-request `fetch`.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`, `convertResponsesMessages`: pi's serialization of assistant messages.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`, `processWebSocketStream` and `acquireWebSocket`: pi's WebSocket mode for `openai-codex`.
- `pi-package/extensions/model-response-timeout/index.ts` and `pi-package/extensions/codex-verbosity/index.ts`: package hooks on `before_provider_request`.
- [OpenAI WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode): the protocol, the 60-minute connection limit, and the connection-local cache of the previous response.
- [angribot/pi-openai-websocket](https://github.com/angribot/pi-openai-websocket): an extension with the same approach for third-party providers.
- [pi-openai-toolkit](https://www.npmjs.com/package/pi-openai-toolkit) 0.24.2: an extension that takes the baseline from the raw server output.
