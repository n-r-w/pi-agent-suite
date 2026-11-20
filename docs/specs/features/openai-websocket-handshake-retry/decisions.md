# Decisions

- Keep the retry settings in `openai-websocket/config.json`. Pi's retry settings apply to requests rather than handshakes, so changing them would also change behavior outside connection setup.
- Treat `delayMs: 0` as no pause. This lets users retry immediately without disabling retries.
- Apply the retry policy only before the first WebSocket send of a model request, including across multiple exchanges for that request. Preserve single-attempt acquisition for post-send recovery, including after a connection age-limit response and when Pi retries a provider error.
- Measure the positive connection budget with elapsed time. Include waits before retries, and do not start a new handshake once the budget has expired.
