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

Each participant model must report configured authorization through `ModelRegistry.hasConfiguredAuth(model)`. An unconfigured participant returns an authentication error without creating a child process or retry. Every recovery attempt acquires the package-wide FIFO startup slot and calls `ModelRegistry.getApiKeyAndHeaders(model)`. An unavailable credential result releases the slot and waits before another attempt without starting Pi.

The FIFO slot covers credential resolution, process start, and the successful or failed RPC response for the first `prompt`. A successful response releases the slot while the participant continues generating its answer, so accepted participants can run in parallel. Before RPC delivery, all contiguous leading `/` characters are removed from every participant prompt. An empty result is rejected.

Only a failed first-`prompt` RPC response whose first error line is exactly `No API key found for <provider>.` for the selected provider can replace a child. Status, projection, extension, and other service events before that response do not block recovery. The failed process exits before the FIFO slot is released. Every replacement after such a rejection creates a new process with the same participant session paths. A successful prompt response, cancellation, a later participant turn, a transport failure, or another error prevents replacement.

The shared policy reads one configuration file during extension startup. When `PI_AGENT_SUITE_DIR` is empty or unset, it appends `agent-suite/child-startup/config.json` to Pi's agent directory. Pi resolves that directory from a non-empty `PI_CODING_AGENT_DIR`, otherwise from `~/.pi/agent`. When `PI_AGENT_SUITE_DIR` is non-empty, the file is `$PI_AGENT_SUITE_DIR/child-startup/config.json`. No other configuration path is checked.

`authRetry.maxRetries` is a non-negative integer with default `10`; `authRetry.delayMs` is a positive integer with default `2000`. The delay is fixed without exponential growth or randomization. A missing file or omitted field uses the defaults. An unreadable file, malformed JSON, unsupported key, or invalid value rejects extension loading.

Each attempt appends a `child-auth-startup-diagnostic` session entry with the launcher, provider, attempt counts, stage, prompt-acceptance state, decision, fixed reason code, and duration. Entries exclude credentials and `auth.json` content. Exhausted recovery returns the sanitized original error plus the final recovery reason.

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
