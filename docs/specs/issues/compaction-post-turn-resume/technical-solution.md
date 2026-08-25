# Technical Solution: Passive Post-Compaction Context Restoration

## Problem Statement

- PRB-01: Automatic compaction emits `session_compact` before the active agent run settles.
- PRB-02: MCP and workflow handlers publish restored hidden context with `deliverAs: "steer"` while the agent run remains active.
- PRB-03: Pi adds these messages to the steering queue. The non-empty queue causes another model request after a completed assistant response with `stopReason: "stop"`.

## Proposed Solution

### SOL-01: Post-compaction delivery

- Publish MCP instructions, workflow checkpoints, and workflow activation options from `session_compact` with `triggerTurn: false`.
- Keep `deliverAs: "steer"` so the message contract remains explicit while `triggerTurn: false` prevents steering-queue insertion.
- Persist each restored message immediately in the post-compaction session history.

### SOL-02: Ordinary workflow delivery

- Keep workflow activation, stage transition, stage update, completion, and active-loop reminder messages on their existing delivery paths.
- Keep MCP startup instruction publication on its existing delivery path.

### SOL-03: Validation

- Assert that workflow checkpoint and activation-option messages emitted by `session_compact` use `triggerTurn: false`.
- Assert that MCP instructions emitted by `session_compact` use `triggerTurn: false`.
- Execute the real `AgentSession` overflow-compaction control flow with `willRetry: true`. Assert that passive context is persisted without steering and that compaction still requests continuation.
- Retain the ordinary workflow delivery test that requires `deliverAs: "steer"` without passive delivery.

## Overengineering and Overspecification Considerations

- The solution uses the public `pi.sendMessage` option already used by the package.
- The solution does not change compaction summaries, workflow state, MCP catalogs, message content, dependencies, or Pi core.
- Passive delivery is limited to the two `session_compact` handlers that restore model-visible context.

## Open Questions

No unresolved questions remain.

## References

- REF-01: `pi-package/extensions/mcp-wrapper/index.ts` - MCP post-compaction instruction publication.
- REF-02: `pi-package/extensions/mcp-wrapper/index.test.ts` - MCP lifecycle tests.
- REF-03: `pi-package/extensions/workflow/context.ts` - workflow journal delivery contract.
- REF-04: `pi-package/extensions/workflow/index.ts` - workflow post-compaction publication.
- REF-05: `pi-package/extensions/workflow/index.test.ts` - workflow lifecycle tests.
- REF-06: `test/integration/compaction-overflow-retry.test.ts` - interrupted-work compaction retry test.
- REF-07: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` - custom-message queueing and automatic compaction continuation.
