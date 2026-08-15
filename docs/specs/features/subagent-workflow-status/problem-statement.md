# Problem Statement

## Context

The subagent management screen (Ctrl+Alt+S) lets the user monitor multiple concurrent subagent sessions. Each subagent runs in a child pi process with its own workflow extension. The main agent screen shows a workflow status line at the bottom: `Workflow: Analysis · Generate user response or requested output artifact`. The management screen does not show equivalent information for subagents.

## Problem Statement

The management screen does not display the current workflow state (workflow ID and active stage) of a selected subagent. The user cannot see which workflow stage a subagent is working on without reading its conversation.

## Who is Affected

The main agent user who launches multiple subagents with workflows (SubAgentExtractor, SubAgentAnalystComplex, SubAgentCoderComplex, etc.). Each subagent may be assigned a different workflow, and the user needs to assess progress across agents.

## Evidence

Code analysis of the pi-harness codebase (commit at working tree):

1. **Main agent workflow status**: `extensions/workflow/status-indicator.ts` publishes `Workflow: {workflowId} · {stageDescription}` via `installWorkflowStatusIndicator` → `acquireSessionStatusRow` from `shared/session-status-panel.ts`.

2. **Management screen data model**: `ManagementProjectionView` (in `extensions/run-subagent/projection.ts`) contains `nodes`, `selectedConversation`, `selectedLiveStatus`, `selectedNotification`, `selectedProjectionSavedTokens`. None of these fields carry workflow state.

3. **Child-to-parent event stream**: `InvocationSupervisor.handleRpcEvent` processes all child stdout JSONL events via `updatePresentationState`, which extracts three transient fields: `liveStatus` (via `reduceLiveAgentStatus`), `notification` (via `readNotification`), `projectionSavedTokens` (via `readProjectionUpdate`). No workflow state is extracted.

4. **RPC wire protocol**: `runtime-wire.ts` defines operations: `knowledge_*`, `agent_operation`, `append_journal`, `query_branch`, `append_history`, `cancel_wait`, `cancel_operation`. No operation carries workflow state.

5. **`readActiveEntries`**: sends `get_entries` RPC to the child process on each call. The response contains session entries and `leafId`. Transient state (`liveStatus`, `notification`, `projectionSavedTokens`) is read from in-memory `InvocationHandle`, not from the child response.

## Impact

- The user cannot distinguish which stage each subagent is on from the management screen overview.
- The user must expand each subagent's conversation and read tool calls to infer workflow progress.
- For 3+ concurrent subagents, monitoring workflow progress requires sequential manual inspection.

## Current State

- The workflow extension runs inside the child process and tracks `WorkflowRuntime.state` (workflow definition, route of stage IDs, active stage).
- The child's workflow status indicator (`installWorkflowStatusIndicator`) writes to the child's session-status panel, which is not visible to the parent.
- The parent's management screen shows: agent name, goal, elapsed time, model, context tokens, transient live status (working/retrying/compacting), and transient notifications.
- `InvocationHandle` survives management screen close/reopen while the child process runs. The handle is torn down when the child process terminates.

## Desired Outcome

The management screen shows the workflow status (workflow ID and active stage description) in the conversation pane header for the selected subagent. The status updates when the user selects or refreshes an agent. The status line is absent when the subagent has no active workflow or has completed.

## Success Metrics

1. Selecting an active subagent with a workflow shows the workflow ID and active stage in the conversation pane header.
2. Selecting an active subagent without a workflow shows no workflow line.
3. Selecting a completed subagent shows no workflow line.
4. The workflow status reflects the current stage at the time of selection or refresh (not necessarily real-time).

## Scope

- Add workflow status display to the conversation pane header of the management screen.
- Create a data path from the child's workflow extension to the parent's management screen.

## Out of Scope / Non-Goals

- Real-time push updates of workflow transitions (poll-on-selection is sufficient).
- Workflow status in the hierarchy list pane.
- Workflow status for completed agents (handle torn down, no durable storage).
- A placeholder line when no workflow is active.
- Changes to the main agent's workflow status indicator.

## Constraints

- The child process runs with `--no-extensions` and loads extensions via `-e <packagePath>`. The workflow extension is loaded this way.
- The child RPC event stream (stdout JSONL) is the only runtime data channel from child to parent.
- `readActiveEntries` already polls the child via `get_entries` RPC on each selection or refresh cycle.
- Both poll-based and push-based approaches require a new data path — existing channels do not carry workflow state.

## Assumptions

1. The child process's workflow extension tracks state in `WorkflowRuntime.state` and can expose it through a mechanism the parent can query. **Verification**: confirmed by reading `extensions/workflow/workflow.ts` and `extensions/workflow/index.ts`.
2. The `InvocationHandle` survives management screen close/reopen. **Verification**: confirmed by reading `InvocationSupervisor.handles` Map lifecycle and coordinator retention.

## Open Questions

None. All scope questions resolved during problem-definition interview.
