# Problem Statement

## Context

The `run-subagent` extension delivers terminal feedback in one of two ways. A matching active `subagent_wait` returns the feedback as its tool result. Otherwise, the extension appends a visible `subagents-feedback` custom message to the direct owner's conversation before the next model request.

The custom message contains human-readable completion text and stores structured `SubagentFeedback` in its `details`. Pi includes the text in model context but does not send custom-message `details` to the model.

## Observed Problem

When terminal feedback is delivered through owner history, the calling agent can continue to treat the completed subagent as active. The agent can then include the terminal session in later `subagent_wait` calls or use `subagent_query` only to rediscover completion that was already present in its context.

## Affected Audience

Users who run multiple subagents while the calling agent continues other work are affected. Calling agents are affected when feedback arrives asynchronously between tool calls.

## Evidence

A session observed on September 20, 2026 had this sequence:

1. Subagent 2 completed successfully while the calling agent was processing a turn.
2. The extension appended a visible `subagents-feedback` custom message containing the completion status and result reference before the next model request.
3. The next model response called `subagent_wait` with session IDs 2, 3, and 4.
4. After feedback for session 3 was returned, the model called `subagent_wait` with session IDs 2 and 4.
5. After feedback for session 4 was returned, the model called `subagent_wait` for session 2, received `no_active_sessions`, and then called `subagent_query` for session 2.

The session trace shows that feedback delivery completed before the first redundant wait. The failure therefore occurred after delivery, when the calling agent interpreted the model-visible conversation state.

The repository behavior matches this trace:

- `pi-package/extensions/run-subagent/index.ts:createActiveWriter` sends history feedback with `deliverAs: "steer"`, which places it before the next model request.
- `pi-package/extensions/run-subagent/persistence.ts:createHistoryMessage` creates human-readable content and stores structured feedback separately in `details`.
- Pi custom-message `details` are not sent to the model.
- `pi-package/extensions/run-subagent/coordinator.ts:SubagentCoordinator.wait` silently removes terminal sessions from the selected active-session set.
- `pi-package/extensions/run-subagent/prompts/extension-description.md` instructs the calling agent to account for automatically received results and to wait only for results not received earlier.

The user reports that similar failures have occurred with other calling agents.

## Impact

The failure causes redundant tool calls, extra model requests, avoidable latency, and additional token or provider cost. It can also cause the calling agent to delay use of a completed result or incorrectly report that required feedback is still unavailable.

## Current State

History feedback is visible to both the user and the model. Delivery is durable and idempotent. The model receives human-readable completion content, while lifecycle identifiers and structured terminal state remain in metadata excluded from model context. The calling agent must infer the state transition and maintain its active-session set through subsequent model turns.

A redundant wait does not expose the stale state. When active and terminal session IDs are submitted together, `subagent_wait` waits for the active sessions and does not identify the ignored terminal sessions in its result.

## Desired State

After history feedback reports a terminal subagent result, the calling agent consistently uses that result and no longer treats the reported session as active. The feedback remains visible to the user.

## Problem Boundary

The problem covers terminal feedback delivered through the direct owner's conversation history. It includes feedback delivered while the owner is processing a turn or is idle. It does not cover feedback returned directly by a matching active `subagent_wait`, child execution correctness, or TUI rendering defects.

## Assumptions

- The repeated incidents reported by the user share the same state-reconciliation failure. This must be checked against additional affected sessions.

## Open Questions

- How often does the failure occur, and which calling models are affected?
- Can a deterministic provider reproduce the failure when terminal feedback arrives between two tool calls?
