# Analysis Results: first measurements of WebSocket mode for the OpenAI provider

These measurements check whether the `openai-websocket` extension brings the duration of model requests through the `openai` provider to the level of `openai-codex`, as NRQ-01 of [prd.md](prd.md) requires, and whether the cache hit share stays at least 94%, as NRQ-02 requires. They inform the decision whether the extension needs further changes.

## Scope
In scope: model requests to `gpt-6.1-sol` that agents of this machine sent on 2026-10-20 to 2026-10-31, and the sessions of one behavior review of the extension on 2026-10-31.

Out of scope: the alternating measurement that the PRD prescribes for NRQ-01, which needs a login to `openai-codex`; models other than `gpt-6.1-sol`.

## Key definitions and abbreviations

- Comparable request. A successful model request to `gpt-6.1-sol` with a context of 50 to 200 thousand tokens and an answer of up to 400 output tokens, the request class of NRQ-01.
- Context. The input tokens of a request: new input, cached input, and cache writes.
- Cache hit share. Cached input tokens divided by the context, summed over the requests of a series without the first request of each session and without requests below 20 thousand tokens of context, as in [problem.md](problem.md).
- Bin. A range of context size, used because the request duration depends on the context.
- Series. The requests of one run of an agent over WebSocket mode.

## Executive Summary
WebSocket mode works with the real endpoint: requests use one connection per session, incremental requests carry only new input items, and the cache hit share of the review sessions was 94.2% to 99.2%. The duration result is mixed. One series of 13 requests at 137 to 178 thousand tokens averaged 6.9 s, within NRQ-01 for the `openai-codex` average of 6.3 s. Two other series at similar sizes averaged 10.9 s and 11.1 s, close to the HTTP average of 11.8 s. The samples are small and compare with another week, so NRQ-01 is neither confirmed nor refuted. The recommended next step is the alternating measurement of the PRD (OPT-01).

## Background and Context
The model aliases moved from `openai-codex` to `openai` on 2026-10-26, and each model request became about 5 seconds slower ([problem.md](problem.md)). The `openai-websocket` extension sends requests of `openai` in WebSocket mode with incremental requests ([solution.md](solution.md)). The extension was enabled through the `packages` setting of pi on 2026-10-31, and a behavior review of the extension by an analyst subagent produced the WebSocket series below.

## Method and Data Sources
- Data source: pi session files of main agents and subagents on the measuring machine. Each assistant message holds the provider, the model, the duration of the request (`durationMs`), the stop reason, and usage.
- Baselines: comparable requests of `openai-codex` on 2026-10-20 to 2026-10-25, and of `openai` over HTTP from 2026-10-26 to 2026-10-31 16:30 UTC. The bin tables use only requests that started between 16:00 and 19:00 UTC, the hours of the WebSocket series, because [problem.md](problem.md) shows that the duration depends on the time of day.
- WebSocket series: the sessions of the review on 2026-10-31. Analyst session `c2b4988e-d72d-42fb-ac29-b4ef134a1595` ran a review from 16:49 to 17:16 UTC and a re-check of fixes from 17:29 to 17:44 UTC. Verifier session `e72c83ad-8e75-49d2-849e-34104bca7408` was a subagent of the analyst. Both used thinking `high`. The review ran the extension of commit `aaf27fb`; the re-check ran the same commit with the fixes of the review in the working tree.
- Live checks: `pi -p` runs with the extension and a temporary debug extension that logged each WebSocket message, the response status, and the time of process exit.
- Limitations: session files do not record the request body or the transport, so the share of incremental requests in the review series is not measured. The baselines come from another week. The WebSocket bins hold 3 to 23 requests.

## Observations

Baselines over all hours:

| Provider and period | Comparable requests | Average | Median | Cache hit share |
| --- | --- | --- | --- | --- |
| `openai-codex`, 2026-10-20 to 2026-10-25 | 14,955 | 6.4 s | 5.7 s | 91.4% (31,595 requests) |
| `openai` over HTTP, 2026-10-26 to 2026-10-31 | 3,355 | 11.2 s | 10.6 s | 95.0% (6,980 requests) |
| `openai-codex`, same period, 16:00 to 19:00 UTC | 1,598 | 6.2 s | 5.6 s | 92.3% (3,803 requests) |
| `openai` over HTTP, same period, 16:00 to 19:00 UTC | 541 | 11.4 s | 11.2 s | 95.7% (1,187 requests) |

Average duration by bin, with the number of comparable requests:

| Series | 50 to 80 thousand | 80 to 120 thousand | 120 to 200 thousand |
| --- | --- | --- | --- |
| `openai-codex`, 16:00 to 19:00 UTC | 5.9 s (408) | 6.3 s (579) | 6.3 s (611) |
| `openai` over HTTP, 16:00 to 19:00 UTC | 12.2 s (87) | 10.4 s (163) | 11.8 s (291) |
| WebSocket, review, analyst and verifier | 11.8 s (3) | 8.3 s (23) | 11.1 s (9) |
| WebSocket, re-check, analyst | – | – | 6.9 s (13), median 6.4 s |
| WebSocket, re-check, verifier | – | – | 10.9 s (7), median 10.8 s |

Cache hit share of the WebSocket series: analyst review 97.6% (46 requests), verifier review 94.2% (21 requests), analyst re-check 99.2% (23 requests), verifier re-check 86.9% (11 requests).

Other observations:
- The review and re-check sessions made 106 model requests through `openai`, and none ended with an error. Session files do not record pi notifications, so whether a session moved to HTTP is not visible in them.
- In a live check on 2026-10-31, an agent turn with one `read` call made two requests on one connection. The first carried 3 input items without `previous_response_id`. The second carried 1 input item, the tool result, with `previous_response_id`, and the provider reported 6,656 of 7,456 input tokens as cached.
- In a live check, `pi -p` with the extension exited 2.1 seconds after `session_shutdown`; the server confirmed the close of the connection at that moment. Without the extension, the process exited within the same second as `session_shutdown`.

## Analysis and Interpretations

- WebSocket mode works with the Sign in with ChatGPT token on `wss://api.openai.com/v1/responses`, and the extension sends incremental requests.
  - Evidence: the live check above shows a request with `previous_response_id` and one input item, and the answer completed.
- NRQ-02 holds for three of four series. The verifier re-check series (86.9%) is below 94%.
  - Evidence: follows from the cache hit shares above. The cause of the low share is not checked; one possible cause is that the verifier session resumed after a pause longer than 5 minutes, after which the extension had closed its connection and the first request was full.
- WebSocket mode shortens requests compared with HTTP, but by a varying amount: from 0.7 s to 4.9 s in the 120 to 200 thousand bin.
  - Evidence: follows from the bin table, HTTP 11.8 s against WebSocket 11.1 s, 10.9 s, and 6.9 s.
- NRQ-01 is not decided. The re-check series meets it (6.9 s against the limit of 6.3 s + 15% = 7.2 s), and the other two series in the same bin do not.
  - Evidence: follows from the bin table; the two re-check series ran in the same minutes with similar contexts and differ by 4 s.
- The difference between series of the same minutes points to a factor other than the transport of this extension. [problem.md](problem.md) names one candidate: the service tier may differ between `api.openai.com` and `chatgpt.com/backend-api`.
  - Evidence: not confirmed; session files do not record the service tier or the route.

## Hypotheses and Tests

- HYP-01: WebSocket mode through `openai` reaches the duration of `openai-codex` for the same task. If true, NRQ-01 holds and the extension needs no change. If false, the remaining difference comes from the route or the service tier, and the transport cannot remove it. Test: the alternating measurement of the PRD, the same agent task several times through each provider within one hour. Expected signal: the `openai` average is at most 15% above the `openai-codex` average. Falsification signal: a larger gap. Cost: about one hour and the subscription quota of the runs; needs a login to `openai-codex`.
- HYP-02: the low cache hit share of the verifier re-check comes from a full request after a pause. Test: count the full requests in such a session with the debug extension that logs each WebSocket message. Cost: low.

## Options and Trade-offs

- OPT-01: alternating measurement of the PRD. Pros: removes the effect of time and week, answers HYP-01. Cons: needs a login to `openai-codex`, about one hour, and the quota of the runs. When to choose: before any further change of the extension for speed.
- OPT-02: recount the same tables after several days of ordinary work. Pros: no login and no extra quota; larger samples. Cons: the baselines stay in another week, so the conclusion stays indirect. When to choose: when the quota or the time of OPT-01 is not available.

## Recommendation
OPT-01. The spread between WebSocket series of the same minutes, 6.9 s to 11.1 s, exceeds the margin to the NRQ-01 limit, and only a direct comparison within one hour separates the transport from other factors. Precondition: a login to `openai-codex` in pi.

## Action Plan

- 1: Run the alternating measurement of OPT-01. Success criterion: averages of both providers for the same task within one hour, and a verdict on NRQ-01.
- 2: If HYP-01 is false, compare the service tier and the response headers of both routes before any change of the extension.

## Assumptions
- The comparable requests of the baselines and of the review sessions represent the same kind of work: agent turns with tool calls. Both conclusions on NRQ-01 depend on it; OPT-01 removes this assumption by running the same task through both providers.

## Open Questions

### QST-01: Does the `openai` provider in WebSocket mode meet NRQ-01?
  - Purpose: decide whether the extension needs changes for speed. Without an answer, the aliases stay on `openai` with a duration between the HTTP and the `openai-codex` level.
  - Impact: MEDIUM.
  - Answer: averages of both providers for one task within one hour, and their ratio.
  - Done: comparison of the review series with baselines of another week; the series disagree.
  - Resolution: OPT-01 after a login to `openai-codex`.

## References
- [problem.md](problem.md) - evidence of the slowdown and the baselines of the problem.
- [prd.md](prd.md) - NRQ-01, NRQ-02, and the measurement method.
- [solution.md](solution.md) - the technical solution of the extension.
- [docs/extensions/openai-websocket.md](../../../extensions/openai-websocket.md) - user documentation of the extension.
