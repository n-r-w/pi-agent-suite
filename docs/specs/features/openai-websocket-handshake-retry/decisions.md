# Decisions

- Keep the retry settings in `openai-websocket/config.json`. Pi's retry settings apply to requests rather than handshakes, so changing them would also change behavior outside connection setup.
- Treat `delayMs: 0` as no pause. This lets users retry immediately without disabling retries.
- Apply the retry policy only when the current exchange first acquires a connection. Preserve the existing acquisition path for a resend after a connection age-limit response.
- Measure the positive connection budget with elapsed time. Include waits before retries, and do not start a new handshake once the budget has expired.
