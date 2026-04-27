# context-overflow

## Purpose

`context-overflow` starts preventive standard pi compaction when the active model has too few remaining context tokens.

## Behavior

- Handles `turn_end`.
- Runs only when `ctx.hasUI !== false`.
- Reads current usage through `ctx.getContextUsage()`.
- Skips compaction when UI is unavailable.
- Skips compaction when context usage is unavailable.
- Skips compaction when `tokens` is `null`.
- Computes `remainingTokens = contextWindow - tokens`.
- Starts standard compaction when `remainingTokens <= compactRemainingTokens`.
- Calls `ctx.compact()` without `customInstructions`.
- Leaves `session_before_compact` and compaction summary content to standard pi compaction or the configured `custom-compaction` extension.
- Waits for successful compaction before the `turn_end` handler returns.
- Sends user message `continue` with follow-up delivery after successful compaction.
- Sends no continuation when compaction fails.
- Prevents repeated or parallel compactions for one threshold exceedance.
- Re-arms compaction only after a later known usage returns above the threshold.
- Does not register or call UI APIs.
- Exposes its parsed config contract for footer display of the used-token compaction threshold.
- Does not modify `custom-compaction`.

## Configuration

File: `~/.pi/agent/config/context-overflow.json`.

```json
{
  "enabled": true,
  "compactRemainingTokens": 49152
}
```

`enabled` is optional and defaults to `true`. `compactRemainingTokens` is optional.

Optional fields:

- `compactRemainingTokens`

Defaults:

- Missing config file enables the extension.
- Default `compactRemainingTokens` is `49152`.

Rules:

- `enabled` must be a boolean value.
- `compactRemainingTokens` must be a non-negative integer.
- Unsupported keys make the configuration invalid.
- Invalid configuration disables preventive compaction.
- Invalid configuration does not show a notification because the extension owns no UI.
- Invalid configuration makes footer omit the context-overflow limit and keep `current/full-window` context usage.

## Verification

Tests must verify:

- default enabled behavior when the config file is missing;
- valid non-default `compactRemainingTokens` behavior;
- no compaction when UI is unavailable;
- no compaction when context usage is unavailable;
- no compaction when `tokens` is `null`;
- compaction when `remainingTokens` equals `compactRemainingTokens`;
- `ctx.compact()` call without `customInstructions`;
- `turn_end` waits for compaction completion before queuing continuation;
- user message `continue` only after successful compaction;
- no continuation after compaction failure;
- duplicate and parallel compaction prevention for one threshold exceedance;
- re-arming only after known usage returns above the threshold;
- fail-closed behavior for disabled or invalid configuration;
- no UI API calls.
