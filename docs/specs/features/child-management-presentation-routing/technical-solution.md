# Technical Solution: Child-to-Management Presentation Routing

## Problem Statement

- **PRB-01:** `pi-package/extensions/run-subagent/index.ts:createRootSupervisor` forwards child `notification` events to the root `ctx.ui.notify`. A notification produced by one child can therefore appear in the root TUI instead of the selected child pane.
- **PRB-02:** `ManagementScreen` already renders selected-child transient state through `ManagementProjectionView.selectedLiveStatus`, but the selected projection has no field for child notifications.
- **PRB-03:** Child session history and management presentation state are different data domains. `pi.appendEntry` writes an entry to the child session; `ManagementProjectionView` is the management panel read model.
- **PRB-04:** Trigger completion has no defined presentation contract. `workflow/index.ts:handleCliTriggerIfRequested` writes completion text to `stderr`, while `workflow/index.ts:runTriggerAt` only observes `{ ok: true } | { ok: false }`.
- **PRB-05:** The RPC parser currently rejects an omitted `notifyType` and treats an empty `statusText` as absent.

## Proposed Solution

### Presentation ownership

- **SOL-01:** Intermediate child notifications are transient management presentation state. They MUST NOT append child session entries, modify root session history, or call root `ctx.ui.notify`.
- **SOL-02:** The selected child pane MUST retain one latest intermediate notification. A later notification replaces it. The notification is cleared when the invocation reaches a terminal state; it MUST NOT be cleared immediately after rendering.
- **SOL-03:** Existing child session entries, `liveStatus`, and `projectionSavedTokens` retain their current ownership and behavior.

### Existing transport and active read model

- **SOL-04:** Keep the existing child RPC `extension_ui_request` transport and the closed `InvocationPresentationEvent` contract. Do not add knowledge-specific IPC or parse notification text.
- **SOL-05:** Extend the existing per-invocation runtime state in `InvocationSupervisor` with one latest notification value containing `message` and `notifyType`.
- **SOL-06:** Extend `ActiveConversationEntries` with the latest notification value. `InvocationSupervisor.readActiveEntries` returns this value together with the existing entries, live status, and projection savings.
- **SOL-07:** Keep the existing activity subscription. `InvocationSupervisor.handleRpcEvent` already notifies activity listeners for RPC events; `ManagementProjectionRuntime` already refreshes the selected `SelectedConversationLoader` for the matching invocation.
- **SOL-08:** Extend `SelectedConversationLoader`, `SelectedConversationSnapshot`, `ConversationSnapshot`, `ConversationUpdate`, and `ManagementProjectionView` with the transient notification value. The value is cleared when a selected invocation becomes terminal or the selected loader is disposed.

### Management panel rendering

- **SOL-09:** `ManagementScreen.renderLiveStatus` renders the latest notification in the existing row adjacent to the selected editor. If no notification is present, it renders the existing live status indicator.
- **SOL-10:** Notification colors follow `notifyType`: `info` uses the normal accent presentation, `warning` uses warning presentation, and `error` uses error presentation.
- **SOL-11:** The notification row uses `truncateToWidth` and `visibleWidth` so CJK and emoji text keeps the panel width invariant. Tests assert visual width rather than JavaScript string length.
- **SOL-12:** A notification remains visible until the next notification or terminal cleanup. No timer, queue, or animation is introduced.

### Final chronological messages

- **SOL-13:** Final trigger completion is a chronological presentation event, not an intermediate notification. Its storage owner MUST be selected explicitly before implementation.
- **REC-01:** Do not use `pi.appendEntry` for trigger completion while the requirement is presentation-only. `pi.appendEntry` changes child session history in addition to changing what the management panel can read.
- **SOL-14:** The final-message implementation MUST preserve the distinction between the child session history and the management panel chronological display. The selected option is recorded in `QST-01`.
- **SOL-15:** The existing custom-compaction outcome path uses `custom-compaction/index.ts:persistOutcome` and `CUSTOM_COMPACTION_OUTCOME_ENTRY`. Its persistence behavior is a separate decision recorded in `QST-02`.

### RPC validation

- **SOL-16:** An omitted `notifyType` is interpreted as `info`.
- **SOL-17:** An explicitly provided empty `statusText` remains an empty string and is not treated as an omitted field.
- **SOL-18:** A present malformed `notifyType`, `statusKey`, or `statusText` value is rejected without changing runtime state.

### Verification

- **ACC-01:** A child notification is visible only in the selected child pane and never through root `ctx.ui.notify`.
- **ACC-02:** A second notification replaces the first; the first notification is not appended to child or root session history.
- **ACC-03:** Terminal cleanup removes the transient notification while preserving the final chronological presentation entry selected by `QST-01`.
- **ACC-04:** Switching between child A and child B never displays A's notification in B's pane.
- **ACC-05:** `notifyType` defaults to `info`, empty `statusText` is preserved, and malformed payloads are rejected.
- **ACC-06:** CJK and emoji notification text is clipped to the panel's visual width.
- **ACC-07:** Trigger success and failure produce the selected chronological presentation result without incorrectly reporting failure as completed.

## Overengineering and Overspecification Considerations

- **TRD-01:** Extending the existing active read model reuses `InvocationSupervisor` activity notifications, `SelectedConversationLoader`, and `ManagementProjectionRuntime`. A second event bus would duplicate selection and lifecycle ownership.
- **TRD-02:** Keeping one latest transient notification matches the existing Pi status-line behavior. A timer or notification queue would add behavior not required by the presentation contract.
- **TRD-03:** No dependency, compatibility layer, fallback path, or knowledge-specific transport is required.
- **LIM-01:** The chronological storage owner for final trigger completion and the migration policy for the existing custom-compaction outcome are not selected in this document.

## Open Questions

### QST-01: Where should trigger-completion data be stored?

- **Impact:** The choice determines whether implementation uses child `pi.appendEntry` or a management-only invocation presentation timeline.
- **What the answer should look like:** Select exactly one: `child session history` or `management TUI presentation state only`.
- **What has been checked:** `ManagementProjectionView` is an in-memory management read model; `pi.appendEntry` is used by `custom-compaction/index.ts:persistOutcome` and writes a child session entry; workflow trigger completion currently has no chronological entry contract.
- **Resolution:** User decision before implementation.

### QST-02: Should custom-compaction outcome remain in child session history?

- **Impact:** Moving it to management-only state would change the existing `CUSTOM_COMPACTION_OUTCOME_ENTRY` persistence contract.
- **What the answer should look like:** Select exactly one: preserve child-session persistence or migrate custom-compaction outcome to management-only presentation state.
- **What has been checked:** `custom-compaction/index.ts:persistOutcome` calls `pi.appendEntry(CUSTOM_COMPACTION_OUTCOME_ENTRY, ...)`; the management panel reads child session entries through the selected conversation loader.
- **Resolution:** User decision before changing the existing custom-compaction path.

### QST-03: What ordering key applies to management-only final entries?

- **Impact:** A panel-only final event needs a deterministic position relative to durable child session entries.
- **What the answer should look like:** Select exactly one ordering contract: append after the latest loaded child entry, use a supervisor event sequence, or use a timestamp with a defined tie-breaker.
- **What has been checked:** Child session entries have append-order IDs; transient runtime fields currently have no chronological entry identity.
- **Resolution:** Resolve only if `QST-01` selects management-only presentation state.

## References

- **REF-01:** `pi-package/extensions/run-subagent/invocation-contracts.ts` — invocation presentation event and supervisor option contracts.
- **REF-02:** `pi-package/extensions/run-subagent/invocation-supervisor.ts` — child RPC parsing, per-invocation runtime state, active entry reads, and activity notifications.
- **REF-03:** `pi-package/extensions/run-subagent/management-screen/selected-conversation.ts` — selected active conversation loading and transient state propagation.
- **REF-04:** `pi-package/extensions/run-subagent/management-screen/runtime.ts` — selected invocation refresh and immutable management projection publication.
- **REF-05:** `pi-package/extensions/run-subagent/projection.ts` — management projection view and selected conversation snapshot.
- **REF-06:** `pi-package/extensions/run-subagent/management-screen/screen.ts` — selected pane and live status rendering.
- **REF-07:** `pi-package/extensions/custom-compaction/index.ts` — `CUSTOM_COMPACTION_OUTCOME_ENTRY` persistence and renderer registration.
- **REF-08:** `pi-package/extensions/workflow/index.ts` — trigger execution and CLI completion behavior.
- **REF-09:** `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js` — Pi status-line retention behavior in `showStatus`.
