# Technical Solution: Subagent Workflow Status in Management Screen

## Problem Statement

The management screen (Ctrl+Shift+G) does not display the current workflow state of a selected subagent. The user cannot see which workflow stage each subagent is working on without reading its conversation.

- TS-P1: Workflow state lives in the child process's `WorkflowRuntime.state`. No existing data channel carries it to the parent's management screen.
- TS-P2: The parent's `readActiveEntries` polls the child via `get_entries` RPC. The response contains all session entries, including `custom` type entries created by `pi.appendEntry`.

## Proposed Solution

### Core Finding: No Child-Side Changes Needed

The workflow extension already persists state via `pi.appendEntry("workflow-state", data)`, creating `type: "custom"` session entries. Pi's `getEntries()` returns all entries except `type: "session"`. Therefore, `get_entries` RPC already returns workflow-state entries. The parent receives them but discards them in `filterConversationSessionEntry` (only keeps `message` and `custom_message`).

Evidence chain:
1. `commitWorkflowStateChange` in `extensions/workflow/index.ts` calls `pi.appendEntry(WORKFLOW_STATE_ENTRY, persistedData)` where `WORKFLOW_STATE_ENTRY = "workflow-state"`.
2. `SessionManager.appendCustomEntry` creates `{ type: "custom", customType, data, id, parentId, timestamp }`.
3. `SessionManager.getEntries()` returns `fileEntries.filter(e => e.type !== "session")` — includes `custom` type.
4. `get_entries` RPC handler returns entries from `getEntries()`.
5. `parseConversationSessionEntry` accepts `custom` type without additional validation.
6. `SelectedConversationLoader` merges all entries into `entriesById` Map via `mergeEntries`.

### Data Format of Workflow-State Entries

Created/activated entries:
```
{ kind: "created" | "activated", workflow: WorkflowDefinition, route: string[] }
```

Transitioned entries:
```
{ kind: "transitioned", route: string[] }
```

`WorkflowDefinition` contains: `id` (string), `description` (string), `stages` (array of `{ id, description, ... }`), `transitions` (array of `{ from, to, type }`).

### Architecture

```
get_entries RPC response (already contains workflow-state custom entries)
    ↓
SelectedConversationLoader.entriesById (all merged entries in append order)
    ↓
extractWorkflowStatus(entriesById.values())  ← NEW: in updateTransientState
    ↓
SelectedConversationSnapshot.workflowStatus
    ↓
ConversationUpdate → HierarchyConversationProjection.updateConversation
    ↓
ConversationSnapshot.workflowStatus → ManagementProjectionView.selectedWorkflowStatus
    ↓
renderSelectedSessionHeader → renderSelectedWorkflowStatus  ← NEW
    ↓
truncateToWidth(text, width, "…") → theme.fg("dim", text)
```

### Changes

#### New file: `extensions/run-subagent/workflow-status.ts`

- `WorkflowStatus` interface: `{ workflowId: string; stageDescription: string }`
- `extractWorkflowStatus(entries: readonly SessionEntry[]): WorkflowStatus | undefined`

Extraction logic:
1. Iterate entries in append order (Map insertion order from `entriesById`).
2. For entries with `type: "custom"`, `customType: "workflow-state"`:
   - If `kind` is `"created"` or `"activated"`: update tracked workflow definition (`workflowId` + `stages` map of stage ID to description).
   - For any `kind`: update tracked `route`.
3. If both workflow definition and route exist: map active stage ID (last element of `route`) to description from stages map.
4. Return `{ workflowId, stageDescription }` or `undefined`.

Boundary validation: treat entry data as untrusted. Use `isRecord`, type checks for strings/arrays, consistent with existing patterns (`reduceLiveAgentStatus`, `readNotification`).

#### Modified: `extensions/run-subagent/management-screen/selected-conversation.ts`

- Add `workflowStatus: WorkflowStatus | undefined` field to `SelectedConversationLoader`.
- Add `workflowStatus: WorkflowStatus | undefined` to `SelectedConversationSnapshot`.
- In `updateTransientState`: call `extractWorkflowStatus(Array.from(this.entriesById.values()))`, compare with current value, update field.
- In `getSnapshot`: include `workflowStatus`.

#### Modified: `extensions/run-subagent/projection.ts`

- Add `workflowStatus: WorkflowStatus | undefined` to `ConversationSnapshot`, `ConversationUpdate`.
- Add `selectedWorkflowStatus: WorkflowStatus | undefined` to `ManagementProjectionView`.
- Add `getSelectedWorkflowStatus()` private getter.
- Update `updateConversation`: pass `workflowStatus` to `createConversationSnapshot`.
- Update `select`: `selectedWorkflowStatus` included via getter in rebuilt view.
- Update `rebuild`: include `selectedWorkflowStatus` in `freezeView`.
- Update `createConversationSnapshot`: clone and freeze `workflowStatus`.
- Update `replace`: set `workflowStatus: undefined` (journal-based initial load).

#### Modified: `extensions/run-subagent/management-screen/hierarchy.ts`

- Add `workflowStatus?: WorkflowStatus` to `SelectedSessionHeaderOptions`.
- New function `renderSelectedWorkflowStatus`:
  - If `workflowStatus` is `undefined` or `width <= 0`: return empty array.
  - Render `Workflow: {workflowId} · {stageDescription}` with `normalizeTerminalDisplayText`.
  - Truncate with `truncateToWidth(text, width, "…")`.
  - Style with `theme.fg("dim", ...)`.
- Update `renderSelectedSessionHeader`: append workflow status line after metadata.

#### Modified: `extensions/run-subagent/management-screen/screen.ts`

- In `renderSelectedHeader`: pass `selectedWorkflowStatus` from `this.view` to `renderSelectedSessionHeader` options.

### Requirement Coverage

| Requirement | How satisfied |
|---|---|
| R1: Display for active agent with workflow | `extractWorkflowStatus` extracts state from entries, `renderSelectedWorkflowStatus` renders the line |
| R2: Absence without workflow | `extractWorkflowStatus` returns `undefined` when no workflow-state entries found |
| R3: Absence for completed agents | `readActiveEntries` unavailable for torn-down handles; inactive branch loads set `workflowStatus: undefined` |
| R4: Width truncation | `truncateToWidth(text, width, "…")` — same mechanism as prompt and metadata rows |
| R5: Absence without selection | `selectedWorkflowStatus` is `undefined` when `selectedStableKey === null` |

## Overengineering and Overspecification Considerations

- No child-side changes: the data path already exists via `get_entries`. Adding a new RPC command, custom event type, or handle-based caching would be unnecessary complexity.
- No `InvocationHandle` modifications: extraction happens in `SelectedConversationLoader` from `entriesById`, which already maintains the full merged entry set. No incremental update concerns.
- No new timer mechanism: workflow status piggybacks on existing periodic refresh cycles. The `entriesById` Map is updated on every refresh.
- Extraction function is pure and stateless: takes entries, returns `WorkflowStatus | undefined`. No side effects, no external dependencies.
- Five files touched (1 new, 4 modified). Each change is small and follows existing patterns (`liveStatus`, `notification`, `projectionSavedTokens`).

## Open Questions

None. All questions resolved during problem-definition and technical-solution interviews.

## References

- `docs/specs/features/subagent-workflow-status/problem-statement.md` — Problem Statement
- `docs/specs/features/subagent-workflow-status/domain-glossary.md` — Domain Glossary
- `docs/specs/features/subagent-workflow-status/light-prd.md` — Light PRD with approved requirements
- `pi-package/extensions/workflow/index.ts:848` — `commitWorkflowStateChange`, `pi.appendEntry` call
- `pi-package/extensions/workflow/index.ts:83` — `WORKFLOW_STATE_ENTRY = "workflow-state"`
- `pi-package/extensions/workflow/status-indicator.ts` — Main agent workflow status indicator (reference for format and styling)
- `pi-package/extensions/run-subagent/management-screen/selected-conversation.ts:154` — `updateTransientState` (extraction point)
- `pi-package/extensions/run-subagent/management-screen/hierarchy.ts:440` — `renderSelectedSessionHeader` (rendering point)
- `pi-package/extensions/run-subagent/projection.ts` — `ManagementProjectionView`, `ConversationSnapshot` (data model)
- pi source: `dist/core/session-manager.js:820` — `appendCustomEntry`, `getEntries` (evidence for data availability)
