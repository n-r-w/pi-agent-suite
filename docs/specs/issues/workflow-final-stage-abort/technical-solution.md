# Technical Solution: Final Workflow Stage Settlement

## Problem Statement

- PRB-01: `agent_settled` identifies the end of an agent run but does not include the assistant outcome.
- PRB-02: Completing every final stage on `agent_settled` marks the workflow completed after an assistant message with `stopReason: "aborted"` or `stopReason: "error"`.
- PRB-03: False completion removes the active final-stage instructions and can survive session compaction through the persisted workflow completion entry.

## Proposed Solution

### SOL-01: Settled run outcome

- Record whether the latest assistant message ended with `stopReason: "aborted"` or `stopReason: "error"` when `turn_end` fires.
- Reset the recorded outcome after `agent_settled` so one failed run cannot affect a later run.

### SOL-02: Final-stage completion

- Keep the final workflow stage active when the settled run ended with `stopReason: "aborted"` or `stopReason: "error"`.
- Keep the final-stage model, thinking level, instructions, and route active after an unsuccessful run.
- Preserve automatic completion for successful settled runs. Successful completion restores the pre-workflow runtime settings and persists the completed state.
- Preserve dynamic workflow replacement. A successful `workflow_create` activates the new workflow immediately and does not depend on completion of the replaced workflow.

### SOL-03: Validation

- Test both `aborted` and `error` outcomes after entering a final stage.
- Assert that unsuccessful outcomes do not persist a completion entry or restore pre-workflow runtime settings.
- Retain the successful settlement test that asserts final-stage completion and runtime restoration.

## Overengineering and Overspecification Considerations

- The solution uses existing `turn_end` and `agent_settled` events.
- The solution does not add a completion tool, persisted fields, configuration, or dependencies.
- Only the two terminal failure values defined by the assistant message contract block automatic completion.

## Open Questions

No unresolved questions remain.

## References

- REF-01: `pi-package/extensions/workflow/index.ts` - workflow lifecycle and final-stage completion.
- REF-02: `pi-package/extensions/workflow/index.test.ts` - workflow lifecycle behavior tests.
- REF-03: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` - `turn_end` and `agent_settled` event contracts.
