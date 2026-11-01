# Terms

- Model request: one request from pi to the provider for one model response. An agent turn with tool calls makes one model request after each batch of tool results.
- WebSocket mode: a mode of the OpenAI Responses API in which the client keeps one open connection and sends each model request as a message on it. The server keeps the previous response of the connection in memory.
- Full request: a model request that carries the whole conversation context.
- Incremental request: a model request in WebSocket mode that carries only the input items added after the previous response on the same connection, together with the ID of that response.
- Prompt cache: a provider cache of previously submitted request prefixes. The provider reports cached input separately from new input, and the subscription or the bill counts cached input at a lower rate.
- Cache hit share: the input tokens that the provider read from the prompt cache, divided by all input tokens of the model request.
