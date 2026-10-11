# Requirements

## Goal

Publish workflow availability without delaying reminders or requesting an extra provider turn after a terminating tool batch.

## Acceptance criteria

1. Activation-options updates default to `triggerTurn: false`.
2. Workflow activation and reminder delivery remain unchanged.
3. With either steering mode, the reminder reaches the third provider request after two ordinary tool calls.
4. With either steering mode, two terminating tool calls end the run after exactly two provider requests.
5. Regression tests use temporary agent settings and inspect journal metadata, not prompt content.

## Non-goals

Do not change Pi, user settings, dependency versions, workflow scheduling, or fork-specific delegation guidance.
