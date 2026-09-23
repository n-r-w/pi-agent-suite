# Idea: Retry timed-out model responses

## Definitions

A retry is an additional provider request after an initial request times out. `maxRetries` counts retries, not the initial request.

## Context and Problem

See [problem.md](problem.md).

## Goal

A timed-out model response must not end a request until the configured retry limit is exhausted or a later provider response completes.

## Scenarios

- A main Pi session times out while waiting for a model response.
- A child Pi session times out while its parent waits for a `run-subagent` result.
- A user aborts a request before the response timeout fires.

## Scope and Non-Scope

- In scope: Response timeouts, retry limits, main-session continuation, and child-invocation completion.
- Out of scope: Changes to Pi, tool-execution timeouts, and changes to provider transport implementations.

## Requirements

### Functional Requirements

- [x] FRQ-01: A timed-out response must trigger at most `maxRetries` additional model requests. The default is three retries after the initial request.
  - Origin: source. The user chose three retries after the initial request.
  - Goal: Bound recovery from response timeouts.
  - Goal achievement: Full. The limit prevents an unbounded sequence of timeout retries.
- [x] FRQ-02: The optional `maxRetries` configuration value must be a positive safe integer.
  - Origin: formulated. The extension's configuration is strictly validated.
  - Goal: Make the retry limit deterministic.
  - Goal achievement: Full. Invalid retry limits cannot start an unbounded or fractional retry sequence.
- [x] FRQ-03: The retry must exclude the failed assistant response and extension-owned trigger from the next model request without duplicating the user's message.
  - Origin: formulated. The user approved an extension-managed retry of the original request.
  - Goal: Repeat the interrupted request without changing its model context.
  - Goal achievement: Full. The next request sees the original input rather than partial output.
- [x] FRQ-04: A `run-subagent` invocation must remain pending while the child has a scheduled timeout retry and terminate on success or retry exhaustion.
  - Origin: source. The user approved the change to child completion handling.
  - Goal: Provide the retry in both main and child sessions.
  - Goal achievement: Full. The parent does not terminate a child between retry attempts.
- [x] FRQ-05: An ordinary user abort must not schedule a timeout retry.
  - Origin: formulated. An explicit cancellation is not a response timeout.
  - Goal: Keep user cancellation effective.
  - Goal achievement: Full. Only expiration of the extension timer starts recovery.

## Open Questions

None.
