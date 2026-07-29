# run-subagent

## Purpose

`run-subagent` provides exactly three agent-facing tools:

- `subagent_start` starts a callable agent in a new saved logical session.
- `subagent_steer` sends another prompt to a directly owned logical session.
- `subagent_wait` waits for terminal feedback from selected active direct children.

Start and steer return after the child accepts the prompt. They do not wait for the child invocation to finish.

## Configuration

Default file: `~/.pi/agent/agent-suite/run-subagent/config.json`.

If the file is missing, the extension uses:

```json
{
  "enabled": true,
  "maxDepth": 1
}
```

| Name | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables runtime behavior. When `false`, all three tool definitions remain registered, the runtime and management screen do not start, and every execution fails closed with `start_failed`. |
| `maxDepth` | No | Non-negative safe integer | `1` | Sets the maximum depth for creating new logical sessions. At or beyond this depth, `subagent_start` and callable-agent guidance are removed; `subagent_steer` and `subagent_wait` remain available for saved direct children. |
| `extensionDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/extension-description.md` | Replaces the shared model-visible Subagents V2 rules with the file's trimmed content. |
| `startDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/start-description.md` | Replaces the model-visible `subagent_start` description with the file's trimmed content. |
| `steerDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/steer-description.md` | Replaces the model-visible `subagent_steer` description with the file's trimmed content. |
| `waitDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/wait-description.md` | Replaces the model-visible `subagent_wait` description with the file's trimmed content. |

Each description file must be readable and contain non-whitespace text after trimming. The keys are independent: an omitted key keeps its matching bundled description even when another description uses a custom file.

Before each model turn, the extension evaluates the active tools after main-agent selection, child tool policy, and depth filtering. If `subagent_start`, `subagent_steer`, or `subagent_wait` is active, the resolved extension description is appended to the system prompt inside `<subagent_tools_guidelines>...</subagent_tools_guidelines>`. The callable-agent list is appended only when `subagent_start` remains active. Neither the shared extension description nor callable-agent guidance is appended when none of the three tools is active.

Example:

```json
{
  "enabled": true,
  "maxDepth": 2,
  "extensionDescriptionPromptFile": "/absolute/path/to/subagents-rules.md",
  "startDescriptionPromptFile": "/absolute/path/to/subagent-start.md",
  "steerDescriptionPromptFile": "/absolute/path/to/subagent-steer.md",
  "waitDescriptionPromptFile": "/absolute/path/to/subagent-wait.md"
}
```

The configuration object accepts only the six keys listed above. Invalid JSON, unsupported keys, invalid values, or one invalid description file fail the complete configuration closed. All three tools remain registered with bundled descriptions, runtime behavior and the management screen remain disabled, and every execution fails with `start_failed`; no valid custom description from the same configuration is applied.

Configuration and description files are read once while the extension runtime starts and before Pi creates its first model snapshot. Restart Pi to apply file or configuration changes; the extension does not reload them in a running session.

The root agent has depth `0`. With the default `maxDepth` of `1`, the root can start direct children, but those children cannot delegate further.

## Callable agents and tool policy

Callable agents come from the shared agent registry documented in [main-agent-selection](main-agent-selection.md). Global definitions under `~/.pi/agent/agent-suite/agent-selection/agents` are extended or replaced by definitions under `<cwd>/.pi/agents`.

A project agent definition supplies the child prompt, model, thinking level, tool patterns, and callable subagents. Each child resolves its own tool patterns against its complete runtime tool catalog. The caller's active tool list does not become the child's tool list.

An agent definition can allow any subset of the three tools by name. The configured depth limit removes `subagent_start` at the limit without changing `subagent_steer`, `subagent_wait`, or unrelated child tools. Invalid child tool policy fails closed by activating no child tools.

## Startup acceptance

Child prompt startup is serialized across package child launchers until each initial prompt is accepted, rejected, or fails to start. Accepted invocations then run concurrently.

Before delivery, leading `/` characters are removed from a child prompt. If no non-whitespace text remains, the prompt is rejected. This prevents a child prompt from entering Pi's extension-command path.

After parent authentication succeeds, a provider-matching missing-credential rejection can be retried only before the child shows other activity. The original attempt and up to three retries each use a fresh process. Cancellation, other startup failures, failures after child activity, and runtime transport failures are not retried.

## Interactive management screen

In interactive TUI mode, either entry opens the same full-terminal overlay:

- `/subagents`
- `Ctrl+Shift+G`

The overlay is available only after the interactive root runtime starts. RPC and print modes do not construct the management screen or register its command and shortcut. The extension does not install a subagent widget in the normal conversation view.

### Hierarchy and selected-session header

The hierarchy contains every recorded root and descendant session beneath its direct caller. Siblings retain creation order. Each node uses two visual rows: the first shows its expansion marker, status, agent ID, and owner-local session ID; the second shows its task name. Caller connectors, indentation, collapsing, and scrolling keep arbitrary-depth hierarchies navigable.

Owner-local session IDs can repeat under different callers. Selection and message routing use the owning session together with its local ID, so a status update, repeated numeric ID, or update elsewhere in the tree does not move the selection. If the selected session disappears, selection moves to the first visible root; an empty hierarchy has no selection.

The status symbols are:

- `●` for an active invocation;
- `✓` for successful completion;
- `✗` for failure;
- `■` for abort.

The outer title shows `SUBAGENTS` and the total session count, followed by non-zero `●<running>`, `✗<failed>`, and `✓<completed>` counts in that order. Aborted sessions keep `■` on their hierarchy nodes but have no title aggregate. With no sessions, the title is `SUBAGENTS · 0 total`, while the selected-session pane and editor remain empty.

The selected-session header shows the caller ancestry from the root session through the selected session. Every segment contains the agent ID and its owner-local session ID. If the ancestry does not fit, the oldest ancestors are removed first and `… ›` marks the omission; the selected identity remains visible. The header never displays `Path:`, child UUIDs, or routing identities.

Its second row shows status and task, followed in order by available elapsed time, model ID, and token usage relative to the context window. Elapsed time is rounded down to whole seconds and uses seconds below one minute, `mm:ss` below one hour, and `h:mm:ss` from one hour. Token values below 1,000 are shown as integers; values of 1,000 or more use `k` with at most one decimal place, such as `34k/190k`. Elapsed time and model ID are each omitted when unavailable. Token usage appears only when both the used-token count and context-window size are available; otherwise the complete token/context value is omitted without a synthetic `0/...`, `?/...`, or context-window-only placeholder. While the invocation is active, the header uses usage from the latest loaded assistant response only when its model matches the invocation model. Terminal invocation metadata takes precedence. A continuation on another model does not reuse usage measured by the prior model.

### Responsive layout

Wide mode reserves at least 24 terminal columns for the hierarchy and 40 for the selected-session pane, excluding the two outer borders and the separator. A total width of 67 columns is therefore the first wide layout. At 66 columns or fewer, the screen uses one pane.

Wide mode shows the hierarchy on the left and the selected header, conversation, and editor on the right. Every new overlay starts with hierarchy focus; in one-pane mode it always opens on the hierarchy. Confirming a selected node opens its full-width conversation and editor. `Escape` returns from that pane to the hierarchy; another `Escape` closes the overlay. In wide mode, `Escape` closes the overlay directly.

### Conversation presentation

The conversation shows the selected saved session's active root-to-leaf branch in chronological order. Selecting another node replaces the conversation and moves its viewport to the latest content. Context-projection custom entries are excluded, and custom entries with `display: false` are not shown.

Presentation uses Pi's public conversation components:

- User messages use `UserMessageComponent`.
- Assistant messages use `AssistantMessageComponent`, including Pi's assistant text and thinking presentation.
- Tool calls and their matching results use `ToolExecutionComponent`.
- Displayable custom messages use `CustomMessageComponent` with its standard custom-type text or Markdown presentation.

Tool presentation follows three paths:

- Pi built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`) use Pi's built-in tool definition.
- Package tools reuse their registered call and result presentation. This covers the three Subagents V2 tools, MCP wrapper tools, `consult_advisor`, and `convene_council`.
- Other tool names use the universal presentation: a compact name and JSON call preview of at most two visual lines, a collapsed result of at most five visual lines, a hidden-line count with the configured expansion key, full Markdown when expanded, error styling for failures, and Pi's normal tool shell.

`Ctrl+O`, the default `app.tools.expand` binding, toggles all tool and custom-message expansion states regardless of focus. Each overlay samples Pi's current main-conversation tool-expansion state when that overlay opens. Toggling expansion inside the overlay changes only that open overlay and does not change the main conversation.

Conversation scrolling uses the configured up, down, page-up, and page-down bindings and counts wrapped visual rows. New content remains visible while the viewport is at the bottom. After the user scrolls upward, new content does not move the viewport. The pane does not show a scroll percentage.

Selection first reads the latest dependency-complete user turn from the end of the session JSONL file. The screen requests preceding turns until Pi's rendered rows fill the current conversation viewport, then the remaining selected branch loads asynchronously. `Loading earlier messages…` marks the upper boundary of an incomplete preview. Its scroll column uses `⋮` and `▒` instead of a proportional thumb because the complete row count is not yet known. Adding earlier entries preserves the top visible component and its row offset. When loading completes, the normal proportional scroll thumb replaces the loading track.

### Focus, editing, and message routing

`Tab` and `Shift+Tab` cycle through the focus zones available in the current layout. Wide mode offers hierarchy, conversation, and editor focus when a session is selected. Narrow hierarchy mode has only hierarchy focus; narrow conversation mode cycles between conversation and editor. These keys, tool expansion, navigation, and `Escape` are consumed by the overlay rather than sent to the child session.

With hierarchy focus:

- Up and down move through visible nodes in creation order.
- Left collapses an expanded branch; otherwise it selects the direct parent.
- Right expands a collapsed branch; otherwise it selects the first child.

With conversation focus, up and down scroll by visual row and page-up and page-down scroll by page. With editor focus, Pi's editor owns text navigation, paste, multiline input, and submission.

Submitting an empty editor is a no-op. Pi clears submitted text while acceptance is pending. If the selected session accepts the message, the editor stays clear and the selected branch refreshes. If routing rejects the message or throws an error, the exact submitted text is restored and Pi shows an error notification.

The overlay can message any selected descendant, including one whose numeric ID repeats elsewhere. Routing uses the selected session's complete owner-qualified identity. An active invocation receives the message as steering; a terminal session starts a continuation of the same saved logical session.

### Updates, errors, restoration, and disposal

Session creation, status changes, continuations, and selected-conversation activity update the overlay without changing a still-valid selection. A continuation updates the existing logical-session node instead of adding another node. For an active persisted session, selection requests only entries after the latest complete JSONL entry and uses the response's `leafId` to join those entries to the persisted preview. Later refreshes continue from the last received entry ID. Before the first assistant response creates the session file, the small in-memory branch is read through `get_entries`. If one valid response exceeds the normal JSONL buffer, it is parsed as a stream. Scalar entry strings longer than 4,096 characters in that oversized response retain their first 4,095 characters followed by `…`. When an active session terminates, its selected branch is reloaded asynchronously from the final JSONL file snapshot.

Only the selected conversation, its reverse JSONL cursor, and its incremental active entries are retained in memory. Changing selection aborts the previous cursor and discards its conversation payload. A stale load cannot publish after another session becomes selected. If a selected-conversation refresh fails, Pi shows an error notification and the last successfully loaded conversation remains visible.

Reopening the overlay in the same extension runtime retains expanded hierarchy branches and the selected session only while those sessions still exist. The conversation payload is reloaded instead of retained while the overlay is closed. Independently, every reopened overlay resamples Pi's current main-conversation tool-expansion state; tool-expansion changes from the prior overlay are not retained. Hierarchy scroll resets to the top, focus and one-pane state reset to the hierarchy. If the retained selection is missing or invalid, the first visible root is selected.

Closing the overlay returns to the unchanged main conversation editor and viewport, clears the selected-conversation payload, and stops its background refreshes. Shutting down the owning runtime performs the same cleanup.

## Tool requests

Every request is a closed object. Extra properties are rejected.

### `subagent_start`

Starts a callable agent in a new saved logical session.

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `agentId` | Yes | String | ID of an available callable agent. |
| `taskName` | Yes | String containing 3–60 Unicode code points | Short name for the delegated task. |
| `prompt` | Yes | String containing at least one non-whitespace Unicode code point | Initial child prompt. |

After the child accepts the prompt, the tool returns:

```json
{
  "outcome": "accepted",
  "sessionId": 1
}
```

The child can remain active after this result. If the request fails before acceptance, no logical session, persistence record, feedback, or owner-history message is created.

### `subagent_steer`

Sends a prompt to a directly owned logical session.

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `sessionId` | Yes | Positive integer | Owner-local session ID returned by `subagent_start`. |
| `prompt` | Yes | String containing at least one non-whitespace Unicode code point | Prompt to deliver. |

After the child accepts the prompt, the tool returns:

```json
{
  "outcome": "accepted",
  "sessionId": 1
}
```

For an active session, the current invocation accepts the prompt as steering. For a terminal session, a new invocation continues the same saved logical session. The session ID and saved session identity do not change.

If terminal completion and steering overlap, exactly one invocation accepts the prompt: the active invocation or the next continuation. A successful result never means that the invocation has finished.

### `subagent_wait`

Waits for the first terminal feedback from selected direct children that are active when the wait begins.

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `sessionIds` | Yes | Non-empty array of distinct positive integers | Directly owned logical sessions to observe. |
| `timeoutMs` | Yes | Integer from `1` through `2147483647` | Maximum wait duration in milliseconds. |

Listed terminal sessions are ignored. If none of the listed sessions is active, the tool returns immediately:

```json
{
  "outcome": "no_active_sessions"
}
```

If selected feedback is observed strictly before the timeout, the tool returns one of these shapes:

```json
{
  "outcome": "feedback",
  "sessionId": 1,
  "status": "success",
  "output": "Final child output"
}
```

```json
{
  "outcome": "feedback",
  "sessionId": 1,
  "status": "failure",
  "error": "Failure details"
}
```

```json
{
  "outcome": "feedback",
  "sessionId": 1,
  "status": "abort",
  "error": "Abort details"
}
```

If no selected feedback is observed strictly before the timeout, the tool returns:

```json
{
  "outcome": "timeout"
}
```

Timeout does not stop or change any child. Feedback observed at the timeout boundary belongs to owner history rather than the timed-out wait.

Each owner can have at most one active wait. When eligible waits overlap, one becomes active and every other call fails with `wait_already_active`. A wait observes only the selected sessions that were active when that wait began.

## Feedback delivery

Each normally terminal invocation produces one feedback value with status `success`, `failure`, or `abort`. That feedback has one destination:

- The matching active wait returns it once.
- If no matching active wait can return it, it enters the direct owner's conversation history once.

Feedback returned by a wait is not duplicated in owner history. If several selected children finish before one wait settles, the wait returns one feedback value and the others enter owner history. Those other values cannot be consumed by a later wait.

If normal feedback is selected for a matching wait but the owning runtime stops before that wait can return, the feedback is saved for owner history and delivered once when the owner session reopens.

History delivery follows the owner's turn boundary:

- If the owner is idle, feedback is added without starting a new agent turn.
- If the owner is processing a turn, feedback is added after the current assistant turn finishes its tool calls and before the next model request.

A timeout, a no-active result, or feedback from an unselected child does not change child execution.

## Pi cancellation

Pi cancellation uses one ordering boundary for each root or nested operation:

- A start or terminal-session steer is ordered against prompt acceptance.
- An active-session steer is ordered against dispatch reservation.
- A wait is ordered against feedback, timeout, or no-active settlement.

When cancellation wins:

- A start or terminal-session steer completes process and bridge cleanup without recording a new logical session or continuation.
- An active-session steer canceled before dispatch sends no steering prompt, applies no prompt, and sends no child abort.
- A wait removes its admission, timer, resolver, and bridge correlation before cancellation becomes observable. Later child feedback follows normal owner-history delivery.
- The tool call propagates as Pi cancellation. It returns neither a normal Subagents V2 outcome nor a failed Subagents V2 `{ code, message }` result.

Once active-steer dispatch is reserved, cancellation cannot win. If child Pi returns a successful steer response, the call returns the accepted result and applies the prompt exactly once, even when the parent observed cancellation before receiving that response. A rejected child steer response remains `message_rejected`; no child abort is sent in either case.

For a nested active steer, the root cancellation acknowledgment states whether cancellation won before dispatch. When dispatch won, the worker waits for the original steer response, returns that accepted or failed outcome, and closes the original and cancellation correlations once.

For start or terminal-session steer, prompt acceptance first keeps the accepted result and tracked logical-session or invocation state. For a wait, settlement first keeps its feedback, timeout, or no-active result and any selected feedback destination. Later cancellation does not undo a completed outcome.

## Session identity

`sessionId` is a positive integer local to the direct owner. Different owners, including owners in separate branches, can use the same number for different logical sessions. Therefore, `subagent_steer` and `subagent_wait` can address only the caller's direct children.

Accepted session IDs increase within each saved owner session and remain stable across later continuations. A failed start can consume a candidate number, so accepted IDs can contain gaps. A skipped number identifies no logical session.

The original callable agent identity remains attached to the saved logical session. A terminal continuation uses that agent's current definition resolved for the owning runtime's working directory.

## Process lifetime and terminal outcomes

Each active invocation runs in a separate saved child Pi process owned by the Pi runtime that started it. The process remains supervised after start or steer acceptance and does not outlive its owning runtime.

Normal completion produces exactly one terminal state and one feedback disposition:

- successful completion becomes terminal success;
- failed completion becomes terminal failure;
- child abort becomes terminal abort.

Normal child completion uses Pi RPC `agent_settled`. A low-level `agent_end` is not terminal because Pi can still perform an automatic retry, compact the context and retry, or process a queued continuation. Parent cancellation, transport failure, and process exit remain independent terminal boundaries because they can prevent `agent_settled` from arriving.

If an accepted child process exits before a normal terminal event, the invocation becomes terminal failure. Its failure feedback states that the child exited without a terminal event and includes the available exit code, signal, or both. The saved logical session remains available for later continuation.

When the owning Pi runtime stops first:

- every active child invocation owned by that runtime becomes terminal abort;
- active waits cease;
- runtime-forced abort feedback is not returned by a wait or added to owner history;
- child processes and invocations started beneath them are stopped;
- saved logical sessions remain available for reopening and later continuation.

If communication between an owning runtime and a child runtime fails, the affected runtime fails closed: its active work is stopped, its waits cease, and no reconnect or response retry is attempted. Feedback already selected for normal delivery keeps its one destination instead of being delivered twice or lost.

At a completion, process-exit, runtime-stop, or fail-stop boundary, the first observed outcome wins. Later competing observations do not replace the terminal state or create another feedback destination.

## Persistence and reopening

Child sessions are stored under:

```text
~/.pi/agent/agent-suite/run-subagent/sessions/
```

When `PI_AGENT_SUITE_DIR` is set, the same `run-subagent/sessions/` path is used under that suite directory.

The owning Pi session saves logical-session identity, direct-owner relationships, accepted continuations, terminal outcomes, and whether feedback was returned by a wait or added to history. This state remains outside model context. Reopening recursively restores every saved descendant with the same owner-local ID and saved child conversation, regardless of the current `maxDepth`. Lowering `maxDepth` prevents deeper `subagent_start` calls but does not hide historical sessions.

A saved invocation that was active but has no saved terminal outcome reopens as terminal abort. Its logical session remains continuable through `subagent_steer` with the same owner-local ID.

Reopening also completes delivery for terminal feedback interrupted by shutdown. Feedback already returned by a wait or added to history keeps that destination. Otherwise, feedback is added to owner history once. Repeated reopening does not duplicate the history message or change the selected terminal state.

## Failed tool results

Failed calls use Pi's failed-tool channel with `{ code, message }` and no normal `outcome`. `message` is human-readable; its exact wording is not a contract.

| Code | Applies to | Meaning and retry condition |
| --- | --- | --- |
| `invalid_request` | All three tools | The closed request contract is violated. Retry with corrected input. |
| `agent_unavailable` | `subagent_start` | `agentId` does not identify an available callable agent. Retry after availability changes. |
| `unknown_session` | `subagent_steer`, `subagent_wait` | No addressed ID is known as a non-owned session, and at least one addressed ID is unknown. Retry with corrected input. |
| `not_owner` | `subagent_steer`, `subagent_wait` | An addressed session is known but is not directly owned by the caller. For a wait containing unknown and known non-owned IDs, this code takes precedence. Retry with corrected input. |
| `message_rejected` | `subagent_start`, `subagent_steer` | A structurally valid initial or steering prompt was rejected. A start or steer may be retried in a later call. |
| `start_failed` | `subagent_start`, terminal-session `subagent_steer` | The required invocation could not start or exited before accepting its prompt. A later call may retry. |
| `wait_already_active` | `subagent_wait` | The owner already has the one permitted active wait, or this call lost an overlapping admission. Retry after the active wait ends. |

Structural request violations produce `invalid_request` before session, ownership, availability, or runtime checks. Each failed call returns one applicable code. A retry is a new call and does not retroactively change the failed call.
