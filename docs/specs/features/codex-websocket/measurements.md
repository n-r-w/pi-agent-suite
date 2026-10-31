# Analysis Results: measurements of WebSocket mode for the OpenAI provider

These measurements check whether the `openai-websocket` extension brings the duration of model requests through the `openai` provider to the level of `openai-codex`, as NRQ-01 of [prd.md](prd.md) requires, and whether the cache hit share stays at least 94%, as NRQ-02 requires. They inform the choice of the provider for the model aliases and of further work on the extension.

## Scope
In scope: model requests to `gpt-6.1-sol` that agents of the measuring machine sent from 2026-10-20 to 2026-10-31; live diagnostic runs of pi on 2026-10-31; the endpoints that Codex CLI and the two pi providers use.

Out of scope: the alternating measurement that the PRD prescribes for NRQ-01, which needs a login to `openai-codex`; models other than `gpt-6.1-sol`.

## Key definitions and abbreviations

- Comparable request. A successful model request to `gpt-6.1-sol` with a context of 50 to 200 thousand tokens and an answer of up to 400 output tokens, the request class of NRQ-01.
- Context. The input tokens of a request: new input, cached input, and cache writes.
- Output tokens. The output tokens that the provider reports for a request, reasoning included.
- Cache hit share. Cached input tokens divided by the context, summed over the requests of a series without the first request of each session and without requests below 20 thousand tokens of context, as in [problem.md](problem.md).
- Generation speed. Output tokens of a request divided by its duration, for requests with at least 400 output tokens.
- Codex endpoint. `https://chatgpt.com/backend-api/codex`, which the `openai-codex` provider of pi uses.
- Platform endpoint. `https://api.openai.com/v1`, which the `openai` provider of pi uses.
- WebSocket period. Sessions created after the extension was enabled: 2026-10-31 from 16:49 to 21:53 UTC.

## Executive Summary
The extension works in production sessions. Each request after the first one of a session is incremental in the live diagnostic runs, and the cache hit share of the WebSocket period is 96.6%, above NRQ-02 and above both baselines. The extension removed the per-request delay of HTTP: with up to 150 output tokens, requests take about as long as through `openai-codex`. With longer output, requests take about as long as over HTTP, because the platform endpoint generates 25 to 30 output tokens per second and the Codex endpoint 47. The transport cannot change the generation speed, so NRQ-01 as written, an average over all comparable requests, is out of reach of the extension. The remaining choice is between endpoints: faster generation with a cache hit share of about 92.8% on the Codex endpoint, or slower generation with 96.6% on the platform endpoint. Codex CLI itself uses the Codex endpoint for ChatGPT sign-in. The recommended next step is the alternating measurement (OPT-03), which also tests whether the cache gap comes from the endpoint or from the request format.

## Background and Context
The model aliases moved from `openai-codex` to `openai` on 2026-10-26, and each model request became about 5 seconds slower ([problem.md](problem.md)). The `openai-websocket` extension sends requests of `openai` in WebSocket mode with incremental requests ([solution.md](solution.md)). The extension was enabled through the `packages` setting of pi on 2026-10-31 at about 16:49 UTC. A behavior review of the extension by an analyst subagent ran first, and ordinary work followed in the same evening.

## Method and Data Sources
- Session data: pi session files of main agents and subagents on the measuring machine. Each assistant message holds the provider, the model, the duration of the request (`durationMs`), the stop reason, and usage. Session files hold neither the request body, the transport, the service tier, nor pi notifications.
- WebSocket period: the sessions created after the extension was enabled. A pi process started before that time sends over HTTP, so the period starts with the session creation time.
- Baselines: requests of `openai-codex` from 2026-10-20 to 2026-10-25, and of `openai` over HTTP from 2026-10-26 to 2026-10-31 16:30 UTC, limited to 16, 17, 19, 20, and 21 UTC, the hours of the WebSocket period. [problem.md](problem.md) shows that the duration depends on the time of day.
- Live diagnostic runs: `pi -p` with the full package and a temporary debug extension. The debug extension logged for each request whether the extension sent it as incremental or full, and the first input item where a request differed from the previous one.
- Source reading: the endpoint choice of Codex CLI in `openai/codex`, file `codex-rs/model-provider-info/src/lib.rs`; the request construction of pi-ai 1.4.0 in `dist/api/openai-codex-responses.js` (`buildRequestBody`) and `dist/api/openai-responses.js` (`buildParams`); the CHANGELOG of pi-coding-agent 1.4.0.
- Limitations: the baselines come from other days, and the task mix of the periods may differ. The analysis by output tokens reduces the effect of the task mix on duration, and it does not remove it.

## Observations

### Production sessions of the WebSocket period
- 24 sessions made 820 requests through `openai`: 789 ended with a tool call, 30 with a final answer, and 1 with an error.
- The error `This operation was aborted` came from a `SubAgentAnalyst` run that `pi-agent stop` stopped at 20:10:27 UTC. The same error with zero duration occurred 25 times through `openai-codex` from 2026-10-11 to 2026-10-25 and 3 times through `openai` over HTTP from 2026-10-26 to 2026-10-30.

Cache hit share:

| Series | Cache hit share |
| --- | --- |
| `openai-codex`, baseline hours | 92.8% |
| `openai` over HTTP, baseline hours | 95.0% |
| `openai` WebSocket period | 96.6% (70.5 million context tokens) |

Six of 24 WebSocket sessions have a cache hit share below 94%; the lowest is 84.8% over 10 requests.

Average duration of comparable requests by context, with the number of requests:

| Series | 50 to 80 thousand | 80 to 120 thousand | 120 to 200 thousand | All, average and median |
| --- | --- | --- | --- | --- |
| `openai-codex`, baseline hours | 5.7 s (866) | 5.9 s (1,163) | 5.8 s (1,369) | 5.8 s, 5.3 s (3,398) |
| `openai` over HTTP, baseline hours | 11.5 s (97) | 10.7 s (214) | 11.1 s (467) | 11.0 s, 10.5 s (778) |
| `openai` WebSocket period | 9.4 s (109) | 8.5 s (185) | 8.6 s (99) | 8.8 s, 8.9 s (393) |

Distribution of comparable requests:

| Series | 10th percentile | Median | 90th percentile | Under 7 s | Over 10 s |
| --- | --- | --- | --- | --- | --- |
| `openai-codex`, baseline hours | 2.6 s | 5.3 s | 9.2 s | 75% | 8% |
| `openai` WebSocket period | 3.9 s | 8.9 s | 13.3 s | 37% | 41% |

Average duration by output tokens, context of 50 to 200 thousand tokens, with the number of requests:

| Output tokens | `openai-codex`, baseline hours | `openai` over HTTP, baseline hours | `openai` WebSocket period |
| --- | --- | --- | --- |
| 0 to 50 | 3.1 s (586) | 6.5 s (102) | 3.9 s (44) |
| 50 to 150 | 4.8 s (1,067) | 9.0 s (232) | 5.5 s (114) |
| 150 to 400 | 7.3 s (1,740) | 13.1 s (443) | 11.2 s (237) |
| 400 to 1,000 | 13.0 s (1,126) | 22.2 s (308) | 21.2 s (184) |
| Generation speed, median | 47 tokens/s | 25 tokens/s | 30 tokens/s |

Average duration of comparable WebSocket requests by the event before them:

| Event before the request | Requests | Average | Cached share of the request |
| --- | --- | --- | --- |
| An ordinary tool call | 334 | 8.8 s | 96.5% |
| A workflow call | 47 | 8.2 s | 99.5% |
| A change of the active toolset | 7 | 10.5 s | 97.0% |
| A pause over 5 minutes | 4 | 5.8 s | 99.6% |
| A user prompt | 3 | 8.1 s | 93.5% |

### Live diagnostic runs
- Run 1, thinking `low`, 6 requests with a context of 16.5 to 21 thousand tokens: the first request was full; each of the other 5 was incremental with one input item and took 2.3 to 3.1 s.
- Run 2, thinking `high`, 15 requests with a context of 16.6 to 67.3 thousand tokens: the first request was full; each of the other 14 was incremental with one input item. The 5 requests with a context of 50 to 67 thousand tokens took 2.1 to 3.4 s.
- In both runs, each request began with the whole input of the previous request, and no request field other than `input` changed.
- In an earlier live check, `pi -p` with the extension exited 2.1 seconds after `session_shutdown`, when the server confirmed the close of the connection; without the extension, the process exited within the same second.

### Review sessions
Before ordinary work, the review of the extension produced small series in the 120 to 200 thousand bin: 11.1 s over 9 requests during the review, and 6.9 s over 13 requests and 10.9 s over 7 requests during the re-check, which ran in the same minutes. Their cache hit shares were 86.9% to 99.2%. These series are part of the WebSocket period above.

### Endpoints and request formats
- Codex CLI chooses the Codex endpoint for ChatGPT sign-in (`AuthMode::Chatgpt`, constant `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`) and the platform endpoint for other authentication, and enables WebSocket mode for its OpenAI provider (`supports_websockets: true`).
- The CHANGELOG of pi-coding-agent states: "Renamed the inherited OpenAI Codex provider to "OpenAI Codex (legacy)"; Sign in with ChatGPT on the OpenAI provider supersedes it."
- The `openai-codex` provider of pi builds its own requests without the OpenAI SDK. It sends the system prompt in the field `instructions` and adds `text.verbosity: "low"` by default, `parallel_tool_calls: true`, and `tool_choice: "auto"`. The `openai` provider builds requests for the OpenAI SDK and sends the system prompt as the first item of `input`. Both providers process response events with the same pi function, `processResponsesStream`.
- The `codex-fast` extension, which sets `service_tier: "priority"`, has no state file on the measuring machine, so it was off for the `openai-codex` baseline.

## Analysis and Interpretations

- The extension sends incremental requests in ordinary agent turns with the full package.
  - Evidence: both live diagnostic runs; each request after the first one was incremental.
- The extension removed the per-request delay of HTTP.
  - Evidence: follows from the output-token table. With up to 150 output tokens, WebSocket requests take 0.7 to 0.8 s longer than `openai-codex` and 2.6 to 3.5 s less than HTTP.
- The remaining gap to `openai-codex` comes from the generation speed of the platform endpoint, which the transport cannot change.
  - Evidence: follows from the output-token table. The gap grows with the output: from 0.8 s at 0 to 50 output tokens to 8.2 s at 400 to 1,000 output tokens. The generation speed of `openai` is 25 tokens/s over HTTP and 30 tokens/s over WebSocket, against 47 tokens/s of `openai-codex`. The baselines come from other days, so the size of the gap is not confirmed for the same hour.
- NRQ-01 as written cannot be met by the extension. It compares averages over all comparable requests, and requests with more than 150 output tokens make 60% of the WebSocket comparable requests.
  - Evidence: follows from the output-token table: 237 of 395 WebSocket requests with up to 400 output tokens have 150 to 400 output tokens; in the 150 to 400 bucket, WebSocket takes 11.2 s against 7.3 s of `openai-codex`.
- NRQ-02 holds for the WebSocket period as a whole.
  - Evidence: 96.6% against the threshold of 94%. The six sessions below 94% are not explained; one possible cause is a full request after a pause over 5 minutes, after which the extension closes the connection.
- The events before a request do not explain the spread of durations.
  - Evidence: 334 of 395 comparable WebSocket requests follow an ordinary tool call and average 8.8 s, the same as the whole period.
- The difference between the endpoints is a property of the serving side. The two pi providers share the response processing, and Codex CLI uses the Codex endpoint for the same subscription.
  - Evidence: follows from the source reading above. Why OpenAI serves the endpoints at different speeds is not visible: session files do not hold the service tier.

## Hypotheses and Tests

- HYP-01: the generation speed of the platform endpoint stays below that of the Codex endpoint when both serve the same task in the same hour. If true, the choice between endpoints is final for speed. If false, the gap of the baselines came from the days or the task mix. Test: the same agent task several times through each provider within one hour; compare generation speed and duration by output tokens. Cost: about one hour and the subscription quota of the runs; needs a login to `openai-codex`.
- HYP-02: the cache hit share depends on the endpoint and does not depend on the request format. If true, an extension that sends pi's standard request to the Codex endpoint gets the cache hit share of `openai-codex`, and OPT-04 brings nothing over OPT-02. If false, OPT-04 can combine the generation speed of the Codex endpoint with the cache hit share of the platform endpoint. Test: the same task on the Codex endpoint with the request format of `openai-codex` and with the request format of `openai`; compare the cache hit share. Cost: a temporary transformation of requests in the extension and a run of the same task.
- HYP-03: the sessions below 94% cache hit share have full requests after pauses over 5 minutes. Test: count full requests in such a session with the debug extension. Cost: low.

## Options and Trade-offs

- OPT-01: keep the aliases on `openai` with the extension, and change NRQ-01 so that it measures the per-request delay on requests with up to 150 output tokens. Pros: the highest cache hit share, 96.6%, so the subscription quota lasts longer. Cons: requests with longer output take about as long as over HTTP. When to choose: when the quota matters more than the duration of long answers.
- OPT-02: return the aliases to `openai-codex` and disable the extension with `"enabled": false`. Pros: the fastest generation, on the endpoint that Codex CLI uses. Cons: the cache hit share drops to about 92.8%; pi marks this provider as legacy. When to choose: when the duration of agent runs matters more than the quota.
- OPT-03: run the tests of HYP-01 and HYP-02 before choosing. Pros: the choice rests on a comparison within one hour, and HYP-02 shows whether OPT-04 is worth building. Cons: about one hour, the quota of the runs, and a login to `openai-codex`. When to choose: before a decision that changes the aliases or the extension.
- OPT-04: extend the extension so that it sends pi's standard requests of `openai` to the Codex endpoint: the Codex URL, the Codex headers such as `chatgpt-account-id` and `originator`, and the system prompt moved to `instructions`. Pros: the generation speed of the Codex endpoint while pi keeps request construction and response processing. Cons: the extension would depend both on internal behavior of pi and on the private contract of the Codex endpoint, which pi marks as legacy. When to choose: only when HYP-02 is false.

## Recommendation
OPT-03. The choice between OPT-01 and OPT-02 trades the duration of long answers against the quota, and the size of the duration gap rests on baselines from other days. HYP-02 decides whether OPT-04 is a real third option. Precondition: a login to `openai-codex` in pi.

## Action Plan

- 1: Run the test of HYP-01. Success criterion: generation speed and duration by output tokens of both providers for the same task within one hour.
- 2: Run the test of HYP-02. Success criterion: cache hit share of both request formats on the Codex endpoint.
- 3: Choose OPT-01, OPT-02, or OPT-04 by the results, and update NRQ-01 of [prd.md](prd.md) to match.

## Assumptions
- The baselines and the WebSocket period represent the same kind of work: agent turns with tool calls. The size of the duration gap depends on it; OPT-03 removes this assumption.

## Open Questions

### QST-01: Which endpoint should the model aliases use?
  - Purpose: decide between the duration of agent runs and the subscription quota. Without an answer, the aliases stay on `openai` with the extension.
  - Impact: MEDIUM.
  - Answer: one of OPT-01, OPT-02, or OPT-04, with NRQ-01 updated to match.
  - Done: comparison of the WebSocket period with baselines of other days by output tokens; source reading of Codex CLI and pi.
  - Resolution: after OPT-03.

### QST-02: Does the cache hit share depend on the endpoint or on the request format?
  - Purpose: decide whether OPT-04 can combine the faster generation with the higher cache hit share.
  - Impact: MEDIUM.
  - Answer: the cache hit share of both request formats on the Codex endpoint for the same task.
  - Done: the request formats of both pi providers are compared in the source; their effect on the cache is not measured.
  - Resolution: the test of HYP-02.

## References
- [problem.md](problem.md) - evidence of the slowdown and the baselines of the problem.
- [prd.md](prd.md) - NRQ-01, NRQ-02, and the measurement method.
- [solution.md](solution.md) - the technical solution of the extension.
- [docs/extensions/openai-websocket.md](../../../extensions/openai-websocket.md) - user documentation of the extension.
- [openai/codex, codex-rs/model-provider-info/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs) - endpoint choice of Codex CLI.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`, `buildRequestBody` - request format of the `openai-codex` provider.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`, `buildParams` - request format of the `openai` provider.
