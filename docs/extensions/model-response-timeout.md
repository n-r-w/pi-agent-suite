# model-response-timeout

## Purpose

`model-response-timeout` limits the total duration of each provider response. The timer includes connection setup, first-token wait, and streaming. It ends at assistant `message_end`, before tool execution starts.

When a response times out, the extension aborts that response and starts up to `maxRetries` new model requests. A retry keeps the original user message. Partial text, thinking, tool calls, and the extension's hidden retry trigger do not enter the next provider request.

## Configuration

The optional configuration file is `~/.pi/agent/agent-suite/model-response-timeout/config.json`. `PI_AGENT_SUITE_DIR` replaces `~/.pi/agent/agent-suite` when set.

```json
{
  "enabled": true,
  "timeoutSeconds": 1200,
  "maxRetries": 3
}
```

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | Enables response timing and timeout retries. |
| `timeoutSeconds` | Positive finite number | `1200` | Maximum duration of one provider response in seconds. The timer-supported maximum is `2147483.647`. |
| `maxRetries` | Positive safe integer | `3` | Additional requests after the initial request times out. `3` allows up to four requests total. |

Unknown fields, malformed JSON, and invalid values disable only this extension. Pi reports one startup error and continues model requests without a response timer. Configuration is read when the extension loads. Restart Pi after changing the file.

## Timeout lifecycle

1. `before_provider_request` starts one timer for the configured duration.
2. Assistant `message_end` clears the timer. Tool execution has no active response timer.
3. If the timer expires first, the extension calls `ctx.abort()` once and replaces the assistant message with empty content and `stopReason: "error"`:

```text
Model response timed out after {timeoutSeconds} seconds.
```

4. If the retry limit has not been reached, the extension excludes that incomplete assistant message from later provider requests. It records a retry-scheduled entry and starts a new agent run after `agent_settled`.
5. The extension filters its hidden trigger out of the new provider request. If the limit is exhausted, the last timeout error is final. A successful assistant response resets the retry count.

`maxRetries` is independent of Pi's `retry` settings. Pi's built-in retry policy still applies to other eligible provider failures. An ordinary user abort does not trigger a timeout retry.

## Main and child sessions

Main Pi sessions and `run-subagent` child processes load the same timeout configuration. A child emits a context-free retry-scheduled entry before its intermediate `agent_settled`. The parent waits for the child's repeated request rather than treating that settlement as the final result. The parent receives a success or failure only after the last attempt settles.

## Provider abort behavior

The extension uses Pi's public `ctx.abort()` API. A provider that honors Pi's abort signal stops its response. If a provider ignores the signal, the timeout result remains pending until Pi emits assistant `message_end`.
