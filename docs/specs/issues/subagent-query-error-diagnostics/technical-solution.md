# Technical Solution: Subagent Query Error Diagnostics

## Problem Statement

- PRB-01: `executeSubagentQuery` replaces exceptions from `completeAuxiliaryLlm` with `The query failed, please try again later`.
- PRB-02: `executeSubagentQuery` replaces `AssistantMessage.errorMessage` when `AssistantMessage.stopReason` is `error` with the same generic message.
- PRB-03: The replacement prevents callers from identifying authentication, provider, transport, and request failures carried by the auxiliary completion boundary.

## Proposed Solution

### SOL-01: Preserve completion diagnostics

- WHILE `completeAuxiliaryLlm` rejects and the query cancellation signal has not won, WHEN `executeSubagentQuery` handles the rejection, THE query SHALL return the thrown value converted by `errorMessage` as its issue.
- WHILE an assistant response has `stopReason: "error"`, WHEN `errorMessage` is present, THE query SHALL return `AssistantMessage.errorMessage` as its issue.
- WHILE an assistant response has `stopReason: "error"`, WHEN `errorMessage` is absent, THE query SHALL return `The query failed, please try again later` as its issue.
- WHILE a query issue crosses the registered tool boundary, WHEN `SubagentToolError` is constructed, THE error message SHALL pass through `sanitizePublicSubagentErrorMessage` before reaching the failed-tool result.

### SOL-02: Verification

- ACC-01: A provider response with `stopReason: "error"` and `errorMessage: "provider failed"` produces the issue `provider failed` and records billed provider cost.
- ACC-02: A completion rejection with `Error("request timed out")` produces the issue `request timed out` and records no provider cost.
- ACC-03: Query cancellation continues to propagate Pi's cancellation reason instead of producing `query_failed`.

## Overengineering and Overspecification Considerations

- The change reuses `errorMessage` and the `SubagentToolError` sanitization boundary already used by the extension.
- The change adds no retry policy, error taxonomy, wrapper, configuration, or persistence field.

## Open Questions

No unresolved design questions remain for this solution.

## References

- REF-01: `pi-package/extensions/run-subagent/subagent-query.ts` - auxiliary query execution and error mapping.
- REF-02: `pi-package/extensions/run-subagent/error-message.ts` - conversion of thrown values to messages.
- REF-03: `pi-package/extensions/run-subagent/contracts.ts` - failed-tool error sanitization boundary.
- REF-04: `pi-package/extensions/run-subagent/subagent-query.test.ts` - provider response and rejection behavior tests.
