# model-response-timeout

## Purpose

`model-response-timeout` limits the total duration of each provider response. The timer includes connection setup, first-token wait, and streaming. It ends when Pi emits assistant `message_end`, before tool execution starts.

When a response times out, the extension calls `ctx.abort()` once. It replaces the incomplete assistant message with empty content and a retryable timeout error. Partial text, thinking, and tool calls do not enter the next provider context.

Pi owns retries for this error. The extension does not send continuation messages or maintain a separate retry budget.

## Configuration

The optional configuration file is `~/.pi/agent/agent-suite/model-response-timeout/config.json`. `PI_AGENT_SUITE_DIR` replaces `~/.pi/agent/agent-suite` when set.

```json
{
  "enabled": true,
  "timeoutSeconds": 300
}
```

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | Enables response timing. |
| `timeoutSeconds` | Positive finite number | `300` | Maximum provider response duration in seconds. The maximum timer-supported value is `2147483.647`. |

Unknown fields, malformed JSON, and invalid values disable only this extension. Pi reports one startup error and continues model requests without a response timer. Configuration is read once when the extension loads. Restart Pi after changing the file.

## Timeout lifecycle

1. `before_provider_request` starts one timer for the configured duration.
2. Assistant `message_end` clears the timer. Tool execution has no active response timer.
3. If the timer expires first, the extension calls `ctx.abort()` once.
4. The timed-out assistant message receives `content: []`, `stopReason: "error"`, and this error:

```text
Model response timed out after {timeoutSeconds} seconds.
```

5. Pi classifies the timeout as transient and applies its built-in retry policy.

Configure retry count and backoff through Pi settings:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

The retry settings also apply to other transient provider errors.

## Main and child sessions

The package registers the extension once. Main Pi sessions and `run-subagent` child processes that load the package use the same timeout configuration.

Pi performs each retry before `agent_settled`. `run-subagent` therefore keeps the child invocation active through retries without a timeout-specific child protocol.

`run-subagent` does not refresh the selected conversation for streaming `message_update` events. Finalized `message_end` events and other state-changing events keep their existing activity notifications.

## Provider abort behavior

The extension uses Pi's public `ctx.abort()` API. A provider that honors Pi's abort signal stops its response. If a provider ignores the signal, the timeout result remains pending until Pi emits assistant `message_end`.
