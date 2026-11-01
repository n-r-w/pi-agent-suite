# Problem Statement

## Key definitions and abbreviations
See [terms.md](terms.md).

## Context
Agents of this package call `gpt-6.1-sol` through the pi provider `openai`, with Sign in with ChatGPT. Pi 1.4.0 has two providers for the same subscription:
- `openai` sends each model request to `https://api.openai.com/v1/responses` over HTTP with server-sent events, as a full request.
- `openai-codex`, which pi labels "OpenAI Codex (legacy)", sends model requests to `https://chatgpt.com/backend-api` in WebSocket mode and sends incremental requests within a session.

The model aliases of the agent suite moved from `openai-codex` to `openai` on 2026-10-26. The aliases stay on `openai` because its cache hit share is higher, so the subscription quota lasts longer.

## Observed Problem
Each model request through `openai` takes about 5 seconds longer than the same request through `openai-codex`. Agent runs with many tool calls make dozens of model requests, so the user waits 18 to 33% longer for each run.

## Affected Audience
Users of main agents and subagents of this package whose model aliases point to the `openai` provider, for example the analyst subagents of the `tech-solution` workflow.

## Evidence
Pi session logs from 2026-10-20 to 2026-10-31, model requests to `gpt-6.1-sol` with thinking `high`, a context of 50 to 200 thousand tokens, and an answer of up to 400 tokens:

| Provider | Period | Model requests | Average duration per day |
|---|---|---|---|
| `openai-codex` | 2026-10-20 to 2026-10-25 | about 8,000 | 5.9 to 7.3 s |
| `openai` | 2026-10-26 to 2026-10-31 | about 2,000 | 7.9 to 12.8 s |

- On 2026-10-25, when pi used both providers, a model request took 7.3 s on average through `openai-codex` (2,180 requests) and 14.3 s through `openai` (20 requests).
- In three-hour windows, both providers are slowest from 12:00 to 15:00 UTC: `openai-codex` 7.6 to 9.0 s, `openai` 12.4 to 13.9 s.
- The package version did not change the result: with the same commit of the package, `openai` model requests took 7.0 to 9.9 s on 2026-10-28 and 2026-10-29 and 10.2 to 13.1 s on 2026-10-30 and 2026-10-31.
- On 2026-10-31, seven analyst subagent runs took 139.5 minutes in total. With the request duration of `openai-codex`, they would take 25 to 45 minutes less. Long document writing depends little on the provider, so runs that write more gain less.
- Pi issue [#11618](https://github.com/earendil-works/pi/issues/11618) reports the same difference on pi 1.4.0 with `gpt-6.1-terra`: a median of 41.4 s through `openai` and 22.2 s through `openai-codex` for one task, with about 0.65 s of tool time in both.

Cache hit share in sessions that called `activate_toolset`, without the first request of a session and with a context of at least 20 thousand tokens:

| Provider | Model requests | Cache hit share |
|---|---|---|
| `openai-codex` | 30,559 | 91.5% |
| `openai` | 6,868 | 94.6 to 95.2% |

## Impact
HIGH: the user waits longer for each agent run, and the delay grows with the number of tool calls. Switching the aliases back to `openai-codex` removes the delay but lowers the cache hit share by 3 to 4 percentage points.

## Current State
- The `openai` provider of pi 1.4.0 sends model requests through the OpenAI SDK over HTTP and ignores the pi setting `transport`. Pi maintainers closed the requests to add WebSocket mode to this provider without an implementation: [#3442](https://github.com/earendil-works/pi/issues/3442), [#5446](https://github.com/earendil-works/pi/issues/5446), [#10311](https://github.com/earendil-works/pi/issues/10311).
- The endpoint `wss://api.openai.com/v1/responses` accepts the Sign in with ChatGPT token of pi. On 2026-10-31 a script sent two model requests on one connection with `store: false`: a full request of 3,013 input tokens and an incremental request with one new message. Both completed in about 2.2 s. The provider reported 3,030 input tokens for the incremental request, 2,816 of them from the prompt cache.
- OpenAI reports that WebSocket mode makes runs with 20 or more tool calls up to about 40% faster end to end ([WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode)).

## Desired State
Agents keep the `openai` provider and its cache hit share, and a model request takes about as long as through `openai-codex`.

## Problem Boundary
- In scope: model requests that agents of this package send through the `openai` provider, in main agents and subagents.
- In scope: sessions with tool calls, where one session makes many model requests.
- Out of scope: the `openai-codex` provider and providers other than `openai`.
- Out of scope: the time that the model spends generating long answers.

## Assumptions
- The difference in duration comes mostly from the way `openai` sends model requests: a new HTTP request with the whole context each time. The service tier that the provider applies may also differ between the two routes; the session logs do not show it.

## Open Questions
None for the problem statement.
