# convene-council

## Purpose

`convene-council` adds the `convene_council` tool.

Use it when a complex question needs two model participants to compare answers before returning a final answer.

The models with the highest "thinking" level and reasoning capabilities are recommended for best results. Each participant runs in an isolated child Pi session with a Pi-compatible UUIDv7 session ID.

## Configuration

Default config file: `~/.pi/agent/agent-suite/convene-council/config.json`.

If `PI_AGENT_SUITE_DIR` is set, the config file is `$PI_AGENT_SUITE_DIR/convene-council/config.json`.

The extension is disabled when the config file is missing or when `enabled` is not `true`.

### Full config example

```json
{
  "enabled": true,
  "llm1": {
    "model": {
      "id": "provider/model-a",
      "thinking": "high"
    }
  },
  "llm2": {
    "model": {
      "id": "provider/model-b",
      "thinking": "medium"
    }
  },
  "participantIterationLimit": 3,
  "finalAnswerParticipant": "llm2",
  "responseDefectRetries": 1,
  "tools": ["grep", "fetch_*"]
}
```

### Parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `false` | Enables the extension only when set to `true`. |
| `llm1` | No | Object with optional `model` | Uses the current session model and thinking level | Configures the first participant. |
| `llm1.model` | No | Object with optional `id` and `thinking` | Uses the current session model and thinking level | Configures the first participant model. |
| `llm1.model.id` | No | Non-empty `provider/model` string | Current session model | Model for the first participant. |
| `llm1.model.thinking` | No | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Current thinking level | Thinking level for the first participant. |
| `llm2` | No | Object with optional `model` | Uses the current session model and thinking level | Configures the second participant. |
| `llm2.model` | No | Object with optional `id` and `thinking` | Uses the current session model and thinking level | Configures the second participant model. |
| `llm2.model.id` | No | Non-empty `provider/model` string | Current session model | Model for the second participant. |
| `llm2.model.thinking` | No | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Current thinking level | Thinking level for the second participant. |
| `participantIterationLimit` | No | Positive integer | `3` | Maximum number of discussion iterations before returning a no-consensus result. |
| `finalAnswerParticipant` | No | One of `llm1`, `llm2` | `llm2` | Participant that writes the final answer after agreement. |
| `responseDefectRetries` | No | Non-negative integer | `1` | Number of retries for malformed participant responses or defective final answers. |
| `tools` | No | Array of non-empty tool-name patterns | Participants receive only `read` | Additional tools available to participants. `read` is always included. Exact tool names and wildcard patterns such as `fetch_*` are allowed. Full wildcard `*` is rejected. Each pattern must match at least one available tool. |

Unsupported keys make the config invalid.

## Authentication startup recovery

Before creating participant processes, `convene-council` resolves both configured model credentials sequentially through the parent model registry. A parent authentication failure returns without starting child Pi.

All child launchers in the package share one FIFO startup gate within the parent process. The gate allows one child process at a time to start and complete RPC prompt preflight, including credential loading. A prompt response releases the gate while an accepted participant continues generating its answer, so model execution remains parallel.

Before RPC delivery, all contiguous leading `/` characters are removed from every participant prompt. An empty result is rejected, so participant tasks cannot enter Pi's extension-command path.

After successful parent authentication, a fresh participant process can still temporarily miss OAuth credentials when another Pi process holds the shared `auth.json` lock. `convene-council` uses the shared recovery policy and retries only a provider-matching `No API key found for <provider>` RPC prompt rejection received before observable child RPC activity. Each retry creates a new process with the same participant session paths and re-enters the startup gate. The original attempt and up to three retries use exponential randomized delays. Cancellation, later participant turns, failures after session activity, transport failures, and other errors are not retried.

## Tool input

```json
{
  "question": "Which implementation approach should we use?"
}
```

`question` is required and must be an English question for the council. No other tool input fields are allowed.

## Output

When the participants agree, the tool returns the final answer.

When the participants do not agree before `participantIterationLimit`, the tool returns a no-consensus result with the latest answer from each participant.
