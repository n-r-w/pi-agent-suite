# Idea: WebSocket mode for the OpenAI provider

## Definitions
See [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md).

## Goal
A model request through the `openai` provider takes about as long as through `openai-codex`, while the cache hit share and the behavior of agents stay as they are now.

## Affected Scenarios
- An agent works in a session and calls tools, so each tool result leads to another model request.
- A subagent runs in its own pi process and session.
- A package extension calls the model outside the agent loop, for example for compaction, `ask_llm`, or `consult_advisor`.
- The user resumes a saved session in a new pi process.
- The user aborts a response, or the network fails during a session.

These scenarios apply to main agents and subagents.

## Scope and Non-Scope
In scope: model requests that the package sends through the `openai` provider, with any credential that pi uses for it. The measurements in [problem.md](problem.md) concern Sign in with ChatGPT.

Out of scope: the `openai-codex` provider, other providers, HTTP proxies, and the time that the model spends generating long answers.

## Requirements

### Functional Requirements
- [X] FRQ-01: For each model request through `openai`, the agent receives the same result as over HTTP: response text, reasoning, tool calls, usage with cached input, error messages, retries under the pi retry settings, and abort by the user.
  - Origin: formulated. The desired state keeps the behavior of agents unchanged.
  - Goal: keep agents working as they do now.
  - Goal achievement: Partial. The requirement protects behavior; NRQ-01 addresses duration.
  - Feasibility: Confirmed. The `openai-codex` provider of pi passes events that it receives in WebSocket mode to the same event processor that `openai` uses for HTTP events, and the probe of 2026-10-31 received completed responses with usage on both requests.
  - Example: the agent asks the model, the model calls `read`, and the agent receives the tool call with the same name, arguments, and usage fields as over HTTP.
- [X] FRQ-02: When a connection in WebSocket mode cannot be opened, or closes before the response starts, the model request completes over HTTP, the session continues, and the user learns that WebSocket mode is unavailable.
  - Origin: formulated. A network or the endpoint can reject WebSocket, and the user must not lose the run. Without a notice, the user would see slower runs and no reason for them.
  - Goal: keep agent runs reliable.
  - Goal achievement: Partial. The requirement removes a new failure mode; it does not reduce duration.
  - Feasibility: Confirmed. Pi sends the same model request over HTTP today.
  - Example: a firewall blocks the WebSocket handshake; the agent receives its response over HTTP, and the user sees a warning that WebSocket mode is unavailable.
- [X] FRQ-03: The user can return model requests of `openai` to HTTP without removing the package.
  - Origin: formulated. The user compares HTTP and WebSocket mode to verify NRQ-01 and needs a way back if the endpoint changes its behavior.
  - Goal: keep the change reversible.
  - Goal achievement: Partial. The requirement supports verification and rollback.
  - Feasibility: Confirmed. Pi has the setting `transport` with the value `sse`, which the package can honor.
  - Example: the user sets `transport` to `sse`, and the next model request goes over HTTP.

### Non-Functional Requirements
- [X] NRQ-01: For model requests to `gpt-6.1-sol` with thinking `high`, a context of 50 to 200 thousand tokens, and an answer of up to 150 output tokens, the average duration through `openai` in WebSocket mode is at least 2 s shorter than the average duration through `openai` over HTTP on the same day.
  - Origin: formulated. The desired state in [problem.md](problem.md): a model request takes about as long as through `openai-codex`. The transport sets only the delay of sending a request. The duration of longer answers depends on the generation speed of the endpoint, which varies between days on both endpoints ([measurements.md](measurements.md)).
  - Goal: shorten agent runs by removing the extra delay of each model request.
  - Goal achievement: Partial. The requirement covers the delay that comes from the way requests are sent; the generation of long answers is out of scope.
  - Feasibility: Confirmed. On 2026-10-31, such requests took 4.99 s on average over 171 WebSocket requests and 7.93 s over 178 HTTP requests of the same day ([measurements.md](measurements.md)).
  - Verification: pi session logs of one day give the duration of each model request over HTTP and in WebSocket mode. Requests of sessions with `transport` set to `sse` or with the extension disabled go over HTTP.
  - Example: if requests over HTTP average 7.9 s on the day of the check, requests in WebSocket mode average at most 5.9 s.
- [X] NRQ-02: In sessions through `openai`, the cache hit share of model requests with a context of at least 20 thousand tokens, without the first request of a session, is at least 94%.
  - Origin: formulated. The aliases stay on `openai` because its cache hit share is 94.6 to 95.2% over HTTP, which saves the subscription quota.
  - Goal: keep the subscription quota use as it is now.
  - Goal achievement: Full.
  - Feasibility: Confirmed. In the probe of 2026-10-31, the provider read 2,816 of 3,030 input tokens of an incremental request from the cache; in long sessions the new part of a request is a smaller share.
  - Example: a subagent session of 40 model requests with 150 thousand tokens of context reports at least 94% of input tokens as cached.

## Critical Scenarios
- SCN-01: Agent turn with tool calls
  - Requirements: FRQ-01, NRQ-01, NRQ-02
  - Level: external
  - Area: agent session, the package, the `openai` provider, the Responses API
  - Flow: the user sends a prompt; the agent calls tools several times; each tool result leads to another model request; the agent finishes the answer; the session log shows the duration and the cached input of each model request.
- SCN-02: Subagent run
  - Requirements: FRQ-01, NRQ-01, NRQ-02
  - Level: external
  - Area: parent agent, child pi process, the package in the child process, the Responses API
  - Flow: the parent starts a subagent; the subagent works through tool calls in its own session; the parent receives its final response; the subagent session log shows durations and cached input.
- SCN-03: Model call outside the agent loop
  - Requirements: FRQ-01
  - Level: external
  - Area: a package extension such as custom compaction or `ask_llm`, the `openai` provider
  - Flow: the extension calls the model without an agent turn; the extension receives the complete response.
- SCN-04: WebSocket unavailable
  - Requirements: FRQ-02
  - Level: external
  - Area: the package, the network, the Responses API
  - Flow: the handshake fails; the model request completes over HTTP; the user sees one warning; later requests of the session go over HTTP.
- SCN-05: Connection lost during a response
  - Requirements: FRQ-01, FRQ-02
  - Level: external
  - Area: the package, the network, pi retry
  - Flow: the connection closes after the response started; the agent receives a stream error; pi retries the model request under its retry settings; the session continues.
- SCN-06: Server no longer holds the previous response
  - Requirements: FRQ-01
  - Level: external
  - Area: the package, the Responses API
  - Flow: the server rejects an incremental request because it no longer holds the previous response; the model request completes with the whole context; the agent receives the response.
- SCN-07: User aborts a response
  - Requirements: FRQ-01
  - Level: external
  - Area: pi interface, the package, the Responses API
  - Flow: the user aborts during a response; the agent stops as over HTTP; the next prompt in the session receives a normal response.
- SCN-08: Session resumed in a new process
  - Requirements: FRQ-01, NRQ-02
  - Level: external
  - Area: saved session, new pi process, the package, the Responses API
  - Flow: the user reopens a saved session and sends a prompt; the first model request carries the whole context; later requests of the run show cached input as in SCN-01.
- SCN-09: History changes within a session
  - Requirements: FRQ-01
  - Level: external
  - Area: compaction or context projection, the package, the Responses API
  - Flow: compaction replaces earlier messages; the next model request carries the whole new context; the agent receives a response that reflects the new context.
- SCN-10: Session longer than one hour
  - Requirements: FRQ-01
  - Level: external
  - Area: the package, the Responses API connection limit
  - Flow: a session keeps working for more than 60 minutes; model requests keep completing without errors from the connection limit.
- SCN-11: User returns to HTTP
  - Requirements: FRQ-03
  - Level: external
  - Area: pi settings, the package
  - Flow: the user sets `transport` to `sse`; the next session sends its model requests over HTTP.

## Open Questions
None.

## Technical Supplement
No implementation approach is prescribed by these requirements. See [solution.md](solution.md).

## References
- [problem.md](problem.md): evidence and current state.
- [OpenAI WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode): the protocol of the Responses API in WebSocket mode.
- [pi #11618](https://github.com/earendil-works/pi/issues/11618): a measured difference between `openai` and `openai-codex` on pi 1.4.0.
