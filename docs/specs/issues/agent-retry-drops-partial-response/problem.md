# Problem Statement

## Context

Pi can retry a transient assistant error at the agent level. An `openai-codex` stream can fail after it has already delivered text and reasoning blocks. Pi persists the failed assistant message when the response ends, but a later context edit can omit that message from the next model request.

## Observed Problem

When a long `openai-codex` response fails mid-stream with `terminated`, Pi's automatic agent-level retry omits the failed response from the next request. The replacement response starts without the text and reasoning already produced in the failed attempt, even when those blocks remain visible in the transcript and recorded in the session.

## Affected Audience

Users of long-running Pi tasks whose model response fails after producing partial output and whose agent-level retry is enabled. The immediate case uses `openai-codex`; other providers with retryable mid-stream failures may encounter the same Pi retry path.

## Evidence

- [Pi issue #8031](https://github.com/earendil-works/pi/issues/8031) reports `openai-codex` mid-stream failures after substantial partial output, followed by full-response regeneration. The issue was closed automatically, without a maintainer's technical resolution.
- [Pi issue #157](https://github.com/earendil-works/pi/issues/157#issuecomment-3639135365) describes removing the failed assistant message from model context while retaining it in session history as the intended agent-level retry flow.
- In the repository's Pi 0.87.0 dependency, `AgentSession._prepareRetry()` calls `_omitRecoveryAttempt()` before the next `agent.continue()`. The omission persists as a `context_edit`. `SessionManager.buildSessionProjection()` excludes entries whose latest edit has `replacement: null`. The relevant dependency files are `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` and `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`.

## Impact

The retry can repeat analysis and produce an answer that does not build on the failed attempt's recorded work. Users may see partial output followed by regeneration of the same answer in one transcript. Repeated generation consumes additional time and model output; no measured token or monetary cost is available. Work completed before the failed response, including earlier tool results, remains in context unless another projection or compaction excludes it.

## Current State

With agent-level retry enabled, a retryable error leaves the failed assistant message in raw session history but excludes it from the effective context of subsequent model requests. That omission also persists if a user sends a later message in the same branch. With agent-level retry disabled before the failure, no retry-specific omission is created; a failed assistant response that reached `message_end` remains eligible for later context projection. Output displayed before `message_end` is not independently persisted as a session message.

Provider-level retries are a separate mechanism. The Codex client's provider retry covers failures before processing the response stream, not the observed failure after substantial output. Pi's default `retry.provider.maxRetries` is `0`; provider-level retry does not create the `context_edit` used by agent-level retry. The `model-response-timeout` extension also excludes timed-out responses when scheduling its own retry, but that is a separate path.

## Desired State

After an interrupted long response, users can continue the task without unnecessarily discarding useful recorded progress or mistaking an independent regeneration for a continuation.

## Problem Boundary

This problem concerns agent-level automatic retry after a response that produced useful text or reasoning before a retryable error, and later turns on the same session branch after that retry. A failure before any output, an ordinary user abort without automatic retry, provider-level pre-stream retries, and content that never reached `message_end` are distinct cases.

## Assumptions

Pi's retry path excludes the failed response, including any signed reasoning blocks that reached `message_end`. The available evidence does not establish that replaying a partially failed Codex response is accepted by Codex or that the model would continue from the exact interrupted point.

## Open Questions

- How often do retryable failures occur after useful partial output in main sessions and child sessions?
- Does `openai-codex` accept a subsequent request containing the failed assistant's text and signed reasoning blocks, and what continuation behavior does it produce?
- Under which other retryable errors or providers does Pi discard useful partial output? How often does a later compaction replace that evidence with a summary?
