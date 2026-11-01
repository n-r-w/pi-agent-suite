# Analysis Results: measurements of WebSocket mode for the OpenAI provider

These measurements check whether the `openai-websocket` extension brings the duration of model requests through the `openai` provider to the level of `openai-codex`, the goal of [prd.md](prd.md), whether it removes the per-request delay of HTTP, as NRQ-01 requires, and whether the cache hit share stays at least 94%, as NRQ-02 requires. They inform the choice of the provider for the model aliases and of further work on the extension.

## Scope
In scope: model requests to `gpt-6.1-sol` that agents of the measuring machine sent from 2026-10-10 to 2026-10-31; live diagnostic runs of pi on 2026-10-31; the endpoints that Codex CLI and the two pi providers use; public reports that compare the endpoints.

Out of scope: new measurements. On 2026-11-01 the project owner decided to run none, including an alternating measurement of both providers within one hour. Models other than `gpt-6.1-sol` are out of scope.

## Key definitions and abbreviations

- Comparable request. A successful model request to `gpt-6.1-sol` with a context of 50 to 200 thousand tokens and an answer of up to 400 output tokens, the request class that the analysis compares with the `openai-codex` baseline.
- Context. The input tokens of a request: new input, cached input, and cache writes.
- Output tokens. The output tokens that the provider reports for a request, reasoning included.
- Cache hit share. Cached input tokens divided by the context, summed over the requests of a series without the first request of each session and without requests below 20 thousand tokens of context, as in [problem.md](problem.md).
- Generation speed. Output tokens of a request divided by its duration, for requests with at least 400 output tokens.
- Codex endpoint. `https://chatgpt.com/backend-api/codex`, which the `openai-codex` provider of pi uses.
- Platform endpoint. `https://api.openai.com/v1`, which the `openai` provider of pi uses.
- WebSocket period. Sessions created after the extension was enabled: 2026-10-31 from 16:49 to 21:53 UTC.

## Executive Summary
The extension works in production sessions. Each request after the first one of a session is incremental in the live diagnostic runs, and the cache hit share of the WebSocket period is 96.6%, above NRQ-02. The extension removed the per-request delay of HTTP: on 2026-10-31, requests with up to 150 output tokens took 2.2 to 3.1 s less over WebSocket than over HTTP earlier that day. Requests with 400 to 1,000 output tokens took as long as over HTTP, because their duration depends on the generation speed, and the transport cannot change it.

The generation speed and the cache hit share vary between days on each endpoint by as much as they differ between the endpoints. The Codex endpoint generated 29 to 33 tokens/s on 2026-10-12 to 2026-10-14 and 37 to 46 tokens/s on other days; the platform endpoint generated 24 to 28 tokens/s on most days and about 40 tokens/s on 2026-10-28 and 2026-10-29. Pi sent requests through only one of the providers on each day, so the data do not show whether one endpoint is faster or caches better. Public reports also disagree on which endpoint is faster. Users of Codex reported a slowdown of the Codex endpoint from 2026-10-25, the days when the aliases moved to `openai`.

The project owner chose OPT-01 on 2026-11-01: the aliases stay on `openai` with the extension, and NRQ-01 now limits the per-request delay, the part of the duration that the transport controls. NRQ-01 holds: on 2026-10-31, requests with up to 150 output tokens took 2.9 s less over WebSocket than over HTTP.

## Background and Context
The model aliases moved from `openai-codex` to `openai` on 2026-10-26, and each model request became about 5 seconds slower ([problem.md](problem.md)). The `openai-websocket` extension sends requests of `openai` in WebSocket mode with incremental requests ([solution.md](solution.md)). The extension was enabled through the `packages` setting of pi on 2026-10-31 at about 16:49 UTC. A behavior review of the extension by an analyst subagent ran first, and ordinary work followed in the same evening.

## Method and Data Sources
- Session data: pi session files of main agents and subagents on the measuring machine. Each assistant message holds the provider, the model, the duration of the request (`durationMs`), the stop reason, and usage. Session files hold neither the request body, the transport, the service tier, nor pi notifications.
- WebSocket period: the sessions created after the extension was enabled. A pi process started before that time sends over HTTP, so the period starts with the session creation time.
- Baselines: requests of `openai-codex` from 2026-10-20 to 2026-10-25, and of `openai` over HTTP from 2026-10-26 to 2026-10-31 16:30 UTC, limited to 16, 17, 19, 20, and 21 UTC, the hours of the WebSocket period. [problem.md](problem.md) shows that the duration depends on the time of day.
- Day series: generation speed, duration of short answers, and cache hit share of each provider for each UTC day from 2026-10-10 to 2026-10-31, over all hours.
- Same-day comparison: requests of `openai` on 2026-10-31 over HTTP from 00:00 to 16:30 UTC and in the WebSocket period.
- Live diagnostic runs: `pi -p` with the full package and a temporary debug extension. The debug extension logged for each request whether the extension sent it as incremental or full, and the first input item where a request differed from the previous one.
- Source reading: the endpoint choice of Codex CLI in `openai/codex`, file `codex-rs/model-provider-info/src/lib.rs`; the request construction of pi-ai 1.4.0 in `dist/api/openai-codex-responses.js` (`buildRequestBody`) and `dist/api/openai-responses.js` (`buildParams`); the CHANGELOG of pi-coding-agent 1.4.0.
- Public reports: issues of `earendil-works/pi` and `openai/codex`, a blog post of WorkOS, and the prompt caching guide of OpenAI, found by web search on 2026-11-01.
- Limitations: no day has requests of both providers, and the task mix of the days may differ. The analysis by output tokens reduces the effect of the task mix on duration, and it does not remove it.

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

### Same-day comparison on 2026-10-31
Average duration of `openai` requests by output tokens, context of 50 to 200 thousand tokens, with the number of requests:

| Output tokens | HTTP, 00:00 to 16:30 UTC | WebSocket period |
| --- | --- | --- |
| 0 to 50 | 6.1 s (44) | 3.9 s (46) |
| 50 to 150 | 8.5 s (134) | 5.4 s (125) |
| 150 to 400 | 13.8 s (332) | 11.2 s (251) |
| 400 to 1,000 | 21.1 s (270) | 21.2 s (189) |
| Generation speed, median | 26.4 tokens/s | 29.9 tokens/s |

### Day series
Requests with a context of 50 to 200 thousand tokens, all hours. Pi sent requests through `openai-codex` until 2026-10-25 and through `openai` from 2026-10-26; on 2026-10-31, `openai` used HTTP until 16:49 UTC and WebSocket after it.

| Day | Provider | Requests with at least 400 output tokens | Generation speed, median | Average duration with under 50 output tokens | Cache hit share |
| --- | --- | --- | --- | --- | --- |
| 10-10 | `openai-codex` | 1,594 | 39.0 tokens/s | 3.5 s | 94.9% |
| 10-11 | `openai-codex` | 3,441 | 37.3 tokens/s | 3.7 s | 93.5% |
| 10-12 | `openai-codex` | 2,416 | 30.2 tokens/s | 6.1 s | 93.7% |
| 10-13 | `openai-codex` | 900 | 32.5 tokens/s | 5.2 s | 94.4% |
| 10-14 | `openai-codex` | 731 | 29.1 tokens/s | 4.9 s | 95.9% |
| 10-15 | `openai-codex` | 847 | 42.1 tokens/s | 3.4 s | 94.0% |
| 10-16 | `openai-codex` | 716 | 42.7 tokens/s | 3.3 s | 95.5% |
| 10-17 | `openai-codex` | 58 | 45.1 tokens/s | 2.8 s | 92.6% |
| 10-18 | `openai-codex` | 70 | 45.0 tokens/s | 3.1 s | 93.2% |
| 10-19 | `openai-codex` | 177 | 45.7 tokens/s | 2.9 s | 92.0% |
| 10-20 | `openai-codex` | 659 | 41.0 tokens/s | 3.4 s | 92.0% |
| 10-21 | `openai-codex` | 1,109 | 43.9 tokens/s | 3.6 s | 93.0% |
| 10-22 | `openai-codex` | 419 | 44.9 tokens/s | 2.8 s | 86.3% |
| 10-23 | `openai-codex` | 774 | 37.9 tokens/s | 3.6 s | 92.2% |
| 10-24 | `openai-codex` | 1,443 | 42.5 tokens/s | 3.5 s | 92.1% |
| 10-25 | `openai-codex` | 1,911 | 43.7 tokens/s | 3.9 s | 90.9% |
| 10-26 | `openai` | 743 | 24.5 tokens/s | 7.6 s | 95.2% |
| 10-27 | `openai` | 213 | 24.2 tokens/s | 6.7 s | 95.9% |
| 10-28 | `openai` | 175 | 40.6 tokens/s | 4.8 s | 92.0% |
| 10-29 | `openai` | 137 | 40.4 tokens/s | 5.3 s | 94.7% |
| 10-30 | `openai` | 169 | 25.9 tokens/s | 6.5 s | 94.0% |
| 10-31 | `openai` | 603 | 27.8 tokens/s | 5.0 s | 96.4% |

Limited to 16, 17, 19, 20, and 21 UTC, the `openai` provider generated 38.4 tokens/s over 84 requests on 2026-10-28, against 40.5 to 53.8 tokens/s of `openai-codex` on 2026-10-20 to 2026-10-25.

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

### Public reports
- pi issue 11618, 2026-10-30: one task on `gpt-6.1-terra` with pi 1.4.0, three runs per provider. The median duration was 41.4 s through `openai` and 22.2 s through `openai-codex`. The author calls the batch small and stochastic and names no cause.
- WorkOS, a post of 2026-09-04 with measurements of August 2026: one long pi task, 10 runs per provider. The median duration was 1,296 s through `openai` and 1,971 s through `openai-codex`; in a smaller series, the generation speed was 39.2 and 28.1 tokens/s. With `service_tier: "priority"`, `openai-codex` ran at the speed of `openai` with the default tier.
- pi issue 3188, 2026-04-14: the same short answer, repeated. The average duration with the default tier was 8.3 s on the platform endpoint and 14.0 s on the Codex endpoint. The Codex endpoint reports the service tier `default` even when the request sets `priority`.
- openai/codex issues 57105, 57151, and 57764, 2026-10-26 to 2026-10-30: users of Codex reported a slowdown of the Codex endpoint from 2026-10-25. In issue 57151, the generation speed of `gpt-6-astra` fell from 24.1 to 12.7 tokens/s. No OpenAI staff answer appears in these issues.
- The prompt caching guide of OpenAI states that caching is best-effort and that OpenAI routes a request to a cache by a hash of the start of the prompt and by `prompt_cache_key`. The search found no comparison of the cache hit share between the endpoints.

## Analysis and Interpretations

- The extension sends incremental requests in ordinary agent turns with the full package.
  - Evidence: both live diagnostic runs; each request after the first one was incremental.
- The extension removed the per-request delay of HTTP.
  - Evidence: follows from the same-day comparison. With up to 150 output tokens, WebSocket requests took 2.2 to 3.1 s less than HTTP requests of the same day. The HTTP requests ran in other hours of that day.
- Requests with more than 400 output tokens take as long over WebSocket as over HTTP, because their duration depends on the generation speed.
  - Evidence: follows from the same-day comparison: 21.2 s against 21.1 s at 400 to 1,000 output tokens. Both pi providers process response events with the same function, so the serving side sets the generation speed.
- The generation speed and the cache hit share of each endpoint vary between days by as much as they differ between the endpoints.
  - Evidence: follows from the day series. The Codex endpoint ranged from 29.1 to 45.7 tokens/s and from 86.3% to 95.9% cache hit share; the platform endpoint ranged from 24.2 to 40.6 tokens/s and from 92.0% to 96.4%. The cache hit share of 92.8% for the `openai-codex` baseline comes from 2026-10-20 to 2026-10-25, when the share of `openai-codex` was below its level of 2026-10-10 to 2026-10-16.
- The data do not show whether one endpoint generates faster or caches better.
  - Evidence: follows from the day series: no day has requests of both providers, and the ranges overlap. The public reports disagree: two of them found the Codex endpoint slower, one found it faster, and the reported slowdown from 2026-10-25 falls on the days of the move to `openai`.
- NRQ-01 holds: on 2026-10-31, requests with up to 150 output tokens took 4.99 s on average over 171 WebSocket requests and 7.93 s over 178 HTTP requests, 2.9 s less.
  - Evidence: the same-day comparison, with both output buckets up to 150 tokens taken together; each of these requests used thinking `high`.
- Against the `openai-codex` baseline of other days, comparable WebSocket requests take 8.8 s on average against 5.8 s.
  - Evidence: the gap comes from requests with more than 150 output tokens, 60% of the comparable WebSocket requests: 237 of 395 have 150 to 400 output tokens and take 11.2 s against 7.3 s of the baseline. The duration of these requests depends on the generation speed, so the extension cannot close this part of the gap.
- NRQ-02 holds for the WebSocket period as a whole.
  - Evidence: 96.6% against the threshold of 94%. The six sessions below 94% are not explained; one possible cause is a full request after a pause over 5 minutes, after which the extension closes the connection.
- The events before a request do not explain the spread of durations.
  - Evidence: 334 of 395 comparable WebSocket requests follow an ordinary tool call and average 8.8 s, the same as the whole period.

## Hypotheses and Tests
No test is planned; see Scope. Each test needs a login to `openai-codex` in pi and the subscription quota of its runs.

- HYP-01: when both endpoints serve the same task, alternating within one hour, the platform endpoint generates slower than the Codex endpoint. If true, the choice between endpoints decides the duration of long answers. If false, the gap between the baselines came from the days. The day series weaken it: the platform endpoint generated about 40 tokens/s on 2026-10-28 and 2026-10-29, the level of the Codex endpoint on 2026-10-10 and 2026-10-23. Test: the same agent task several times through each provider, alternating within one hour; compare generation speed and duration by output tokens. Cost: about one hour.
- HYP-02: for the same task in the same hour, the Codex endpoint has a lower cache hit share than the platform endpoint. If true, OPT-02 spends more of the quota, and the cause, the endpoint or the request format, decides whether OPT-04 can help. If false, the gap between 92.8% and 96.6% came from the days. Test: the same task through each provider in the same hour; for the cause, the same task on the Codex endpoint with the request format of each provider. Cost: about one hour, and a temporary transformation of requests in the extension for the cause.
- HYP-03: the sessions below 94% cache hit share have full requests after pauses over 5 minutes. Test: count full requests in such a session with the debug extension. Cost: low.

## Options and Trade-offs

- OPT-01: keep the aliases on `openai` with the extension, and change NRQ-01 so that it measures the per-request delay on requests with up to 150 output tokens. Pros: the provider that pi supports; the extension removed the per-request delay; the cache hit share of 96.6% meets NRQ-02. Cons: if HYP-01 is true, long answers take longer than through `openai-codex`, and nobody will know it. When to choose: when no measurement runs.
- OPT-02: return the aliases to `openai-codex` and disable the extension with `"enabled": false`. Pros: the endpoint that Codex CLI uses; in the baselines, the fastest generation. Cons: the advantage of the baselines may come from the days; the cache hit share of the Codex endpoint was 86.3% to 95.9% by day; pi marks this provider as legacy. When to choose: when the duration of agent runs matters most and the owner accepts the risk that the advantage came from the days.
- OPT-03: run the tests of HYP-01 and HYP-02 before choosing. Declined: the project owner decided on 2026-11-01 to run no measurements.
- OPT-04: extend the extension so that it sends pi's standard requests of `openai` to the Codex endpoint: the Codex URL, the Codex headers such as `chatgpt-account-id` and `originator`, and the system prompt moved to `instructions`. Pros: the generation speed of the Codex endpoint while pi keeps request construction and response processing. Cons: the extension would depend both on internal behavior of pi and on the private contract of the Codex endpoint, which pi marks as legacy. When to choose: only when tests show that the Codex endpoint generates faster and that the request format sets the cache hit share; no such test is planned.

## Recommendation
OPT-01, chosen by the project owner on 2026-11-01. The extension removed the part of the duration that the transport controls. The day series show no advantage of either endpoint beyond the variation between days, so OPT-02 would rest on baselines of other days, and OPT-04 has no evidence for its premise. NRQ-01 of [prd.md](prd.md) now limits the per-request delay on requests with up to 150 output tokens, which session data of one day can check.

## Assumptions
- The days of both providers represent the same kind of work: agent turns with tool calls on the measuring machine. The comparison between days depends on it; no measurement will check it.

## Open Questions

### QST-02: Does the cache hit share differ between the endpoints?
  - Purpose: decide whether OPT-02 spends more of the quota and whether OPT-04 can combine faster generation with a higher cache hit share.
  - Impact: LOW: no option depends on it while no measurement runs.
  - Answer: the cache hit share of both providers for the same task in the same hour.
  - Done: day series of both providers; the request formats of both pi providers are compared in the source; search for public reports.
  - Resolution: none planned; the test of HYP-02 answers it.

## References
- [problem.md](problem.md) - evidence of the slowdown and the baselines of the problem.
- [prd.md](prd.md) - NRQ-01, NRQ-02, and the measurement method.
- [solution.md](solution.md) - the technical solution of the extension.
- [docs/extensions/openai-websocket.md](../../../extensions/openai-websocket.md) - user documentation of the extension.
- [openai/codex, codex-rs/model-provider-info/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs) - endpoint choice of Codex CLI.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`, `buildRequestBody` - request format of the `openai-codex` provider.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`, `buildParams` - request format of the `openai` provider.
- [earendil-works/pi issue 11618](https://github.com/earendil-works/pi/issues/11618) - `openai` slower than `openai-codex` on one task, 2026-10-30.
- [WorkOS: When your Codex allowance runs out, use an API key instead of credits](https://workos.com/blog/codex-allowance-runs-out-use-api-key-not-credits) - `openai` faster than `openai-codex` in August 2026.
- [earendil-works/pi issue 3188](https://github.com/earendil-works/pi/issues/3188) - durations by service tier on both endpoints, April 2026.
- [openai/codex issue 57151](https://github.com/openai/codex/issues/57151), [issue 57105](https://github.com/openai/codex/issues/57105), [issue 57764](https://github.com/openai/codex/issues/57764) - reports of a slowdown of the Codex endpoint from 2026-10-25.
- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) - routing of requests to the prompt cache.
