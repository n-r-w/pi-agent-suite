# Domain Glossary

## Terms

- **Management screen**: TUI overlay (Ctrl+Alt+S) showing all subagent sessions. Left pane: agent hierarchy. Right pane: conversation of selected agent. Bottom: steer input.

- **Workflow state**: Current state of the workflow extension: `WorkflowState` containing `workflow.id`, `workflow.stages`, and `route` (array of stage IDs; last element is the active stage).

- **Workflow status indicator**: Main agent mechanism (`installWorkflowStatusIndicator` in `extensions/workflow/status-indicator.ts`) that publishes `Workflow: {workflowId} · {stageDescription}` to the session-status panel.

- **Child process**: pi subprocess executing a subagent. Communicates with parent via RPC on stdio: JSONL events on stdout, RPC requests on stdin.

- **Projection**: Immutable view model (`ManagementProjectionView` in `extensions/run-subagent/projection.ts`) feeding the management screen rendering. Contains nodes, selectedConversation, selectedLiveStatus, selectedNotification, selectedProjectionSavedTokens.

- **Live status**: Transient agent status (`LiveAgentStatus` in `extensions/run-subagent/live-status.ts`): working, retrying, compacting, summarizingBranch. Derived from child RPC events via `reduceLiveAgentStatus`.

- **Session-status panel**: Shared status row mechanism in the main agent TUI (`shared/session-status-panel.ts`). Used by workflow and other extensions to publish persistent status lines.

- **RPC wire protocol**: Message protocol between parent and child (`RuntimeWireMessage` in `extensions/run-subagent/runtime-wire.ts`): requests, responses, settlements. Carries knowledge operations, agent operations, journal, branch queries.

- **Conversation pane header**: Top section of the right pane in the management screen. Shows agent name, goal, elapsed time, model, context tokens. The workflow status line will appear here, below the timing/model line.

- **InvocationHandle**: In-memory state for one active child process (`invocation-supervisor.ts`). Holds process reference, RPC pending map, transient state (liveStatus, notification, projectionSavedTokens). Survives management screen close/reopen while child runs. Torn down when child process terminates.

- **readActiveEntries**: Method on `InvocationSupervisor` that sends `get_entries` RPC to the child process and returns `ActiveConversationEntries` (entries, leafId, liveStatus, projectionSavedTokens, notification). Called on each agent selection or refresh cycle.

- **Poll-on-selection**: Update model where the management screen reads current state from the child when the user selects or refreshes an agent, rather than receiving real-time push updates.
