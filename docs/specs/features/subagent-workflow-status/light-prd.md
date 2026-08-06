# Idea: Subagent Workflow Status in Management Screen

## Definitions

See `docs/specs/features/subagent-workflow-status/domain-glossary.md` for full glossary.

Key terms used in this PRD:
- **Workflow state**: `WorkflowState` containing `workflow.id`, `workflow.stages`, and `route` (array of stage IDs; last element is the active stage).
- **Conversation pane header**: Top section of the right pane in the management screen. Shows agent name, goal, elapsed time, model, context tokens.
- **Poll-on-selection**: Update model where the management screen reads current state from the child when the user selects or refreshes an agent.
- **InvocationHandle**: In-memory state for one active child process. Survives management screen close/reopen while child runs. Torn down when child process terminates.

## Context and Problem

The management screen shows agent identity, goal, timing, model, and transient live status for each subagent. It does not show the subagent's current workflow state (workflow ID and active stage). The user cannot see which workflow stage a subagent is working on without reading its conversation.

Workflow state lives in the child process's `WorkflowRuntime.state`. No existing data channel (RPC events, runtime wire protocol, `get_entries` response) carries workflow state from child to parent.

## Goal

The management screen shows the workflow status (workflow ID and active stage description) in the conversation pane header for the selected subagent. The status reflects the child's workflow state at the time of selection or refresh.

## Scenarios

1. **Active agent with workflow**: User selects a running SubAgentExtractor using the InformationExtraction workflow. Header shows `Workflow: InformationExtraction · Identify relevant source locations`.
2. **Active agent without workflow**: User selects a running subagent that has no workflow. Header shows no workflow line.
3. **Completed agent**: User selects a finished subagent (✓). Header shows no workflow line.
4. **No selection**: No agent is selected. Header is empty, same as current behavior.
5. **Workflow transition**: SubAgent transitions from stage A to stage B while selected. On next refresh cycle, header updates to show stage B.

## Scope and Non-Scope

**In scope:**
- Display workflow status in the conversation pane header of the management screen.
- Create a data path from the child's workflow extension to the parent's management screen.

**Out of scope:**
- Real-time push updates of workflow transitions (poll-on-selection is sufficient).
- Workflow status in the hierarchy list pane.
- Workflow status for completed agents (handle torn down, no durable storage).
- A placeholder line when no workflow is active.
- Changes to the main agent's workflow status indicator.

## Requirements

### R1: Workflow status display

When the user selects an **active** subagent **with a workflow**, the conversation pane header displays the line `Workflow: {workflowId} · {stageDescription}`. The line reflects the subagent's current workflow state at the time of selection or periodic refresh.

### R2: Absence without workflow

When the user selects an active subagent **without a workflow**, no workflow status line appears.

### R3: Absence for completed agents

When the user selects a **completed** subagent, no workflow status line appears.

### R4: Width truncation

The workflow status line is truncated to the conversation pane width with ellipsis `"…"`, using the same mechanism (`truncateToWidth`) as the prompt and metadata rows in the header. Truncation respects terminal display width (wide characters, ANSI escape codes).

### R5: Absence without selection

When no agent is selected, the workflow status line does not appear. The header remains empty, same as current behavior.

## Open Questions

None. All scope questions resolved during problem-definition and requirement-approval interviews.

## References

- `docs/specs/features/subagent-workflow-status/problem-statement.md` — Problem Statement
- `docs/specs/features/subagent-workflow-status/domain-glossary.md` — Domain Glossary
- `pi-package/extensions/workflow/status-indicator.ts` — Main agent workflow status indicator
- `pi-package/extensions/run-subagent/management-screen/hierarchy.ts` — `renderSelectedSessionHeader`, `truncateToWidth` usage
- `pi-package/extensions/run-subagent/projection.ts` — `ManagementProjectionView`
- `pi-package/extensions/run-subagent/invocation-supervisor.ts` — `readActiveEntries`, `InvocationHandle`
