# run-subagent

## Purpose

`run-subagent` provides exactly four agent-facing tools:

- `subagent_start` starts a callable agent in a new saved logical session.
- `subagent_steer` sends another prompt to a directly owned logical session.
- `subagent_wait` waits for terminal feedback from selected active direct children.
- `subagent_query` asks a separate auxiliary model a focused question using one saved direct-child conversation as context. It does not invoke the child agent.

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
| `enabled` | No | Boolean | `true` | Enables runtime behavior. When `false`, all four tool definitions remain registered, the runtime and management screen do not start, and every execution fails closed. |
| `maxDepth` | No | Non-negative safe integer | `1` | Sets the maximum delegation depth. At or beyond this depth, all four subagent tools and both model-visible subagent sections are removed. Unrelated agent tools remain active. |
| `extensionDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/extension-description.md` | Replaces the shared model-visible Subagents rules with the file's trimmed content. |
| `startDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/start-description.md` | Replaces the model-visible `subagent_start` description with the file's trimmed content. |
| `steerDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/steer-description.md` | Replaces the model-visible `subagent_steer` description with the file's trimmed content. |
| `waitDescriptionPromptFile` | No | Non-empty absolute path | Bundled `prompts/wait-description.md` | Replaces the model-visible `subagent_wait` description with the file's trimmed content. |
| `query` | No | Object | `{}` | Configures the auxiliary model and system prompt used by `subagent_query`. |

Each description file must be readable and contain non-whitespace text after trimming. The keys are independent: an omitted key keeps its matching bundled description even when another description uses a custom file.

`query` accepts only these fields:

| Name | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `model.id` | No | `provider/model` string | Calling agent's current model | Selects a model from the calling Pi process's registry. |
| `model.thinking` | No | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Calling agent's current thinking level | Selects reasoning for the auxiliary request. `off` omits the provider reasoning option. |
| `systemPromptFile` | No | Non-empty absolute path | Bundled `prompts/query-system.md` | Supplies trimmed non-empty text as the auxiliary system prompt. |

Before each model turn, the extension evaluates the active tools after main-agent selection, child tool policy, and depth filtering. If any subagent tool is active, the resolved extension description is appended to the system prompt inside `<subagent_tools_guidelines>...</subagent_tools_guidelines>`. When `subagent_start` is active, each callable agent is appended with its escaped ID and description:

```xml
<available_subagents note="List of available subagent IDs">
<agent id="SubAgentExtractor">
Extracts facts without analysis.
</agent>
</available_subagents>
```

At or beyond `maxDepth`, none of the four subagent tools, `<subagent_tools_guidelines>`, or `<available_subagents>` is included in model context.

Example:

```json
{
  "enabled": true,
  "maxDepth": 2,
  "extensionDescriptionPromptFile": "/absolute/path/to/subagents-rules.md",
  "startDescriptionPromptFile": "/absolute/path/to/subagent-start.md",
  "steerDescriptionPromptFile": "/absolute/path/to/subagent-steer.md",
  "waitDescriptionPromptFile": "/absolute/path/to/subagent-wait.md",
  "query": {
    "model": {
      "id": "provider/model",
      "thinking": "medium"
    },
    "systemPromptFile": "/absolute/path/to/subagent-query-system.md"
  }
}
```

The configuration object accepts only the seven top-level keys listed above. Invalid JSON, unsupported keys, invalid values, or one unreadable or empty configured prompt file fail the complete configuration closed. All four tools remain registered with bundled descriptions, while runtime behavior and the management screen remain disabled. Existing operations fail with `start_failed`; `subagent_query` fails with `query_failed`. No valid custom value from the same configuration is applied.

Configuration and description files are read once while the extension runtime starts and before Pi creates its first model snapshot. Restart Pi to apply file or configuration changes; the extension does not reload them in a running session.

The root agent has depth `0`. With the default `maxDepth` of `1`, the root can start direct children, but those children cannot delegate further.

## Callable agents and tool policy

Callable agents come from the shared agent registry documented in [main-agent-selection](main-agent-selection.md). Global definitions under `~/.pi/agent/agent-suite/agent-selection/agents` are extended or replaced by definitions under `<cwd>/.pi/agents`.

A project agent definition supplies the child prompt, model, thinking level, tool patterns, workflow policy, and callable subagents. Each child resolves its own tool patterns against its complete runtime tool catalog. The caller's active tool list does not become the child's tool list.

An agent definition can allow any subset of the four tools by name. At or beyond the configured depth limit, all four subagent tools are removed while unrelated child tools remain active. Invalid child tool policy fails closed by activating no child tools.

The optional `workflows` frontmatter field restricts the child to listed workflow IDs. Matching is exact and case-sensitive after NFC normalization; omission allows all workflows, and `workflows: []` denies every workflow. Unknown or NFC-equivalent duplicate names reject the launch before authorization and process startup. The launcher sends canonical IDs to the child through its owned environment; callers do not configure this transport directly.

## Startup acceptance

Child prompt startup is serialized across package child launchers until each initial prompt is accepted, rejected, or fails to start. Accepted invocations then run concurrently.

Before delivery, leading `/` characters are removed from a child prompt. If no non-whitespace text remains, the prompt is rejected. This prevents a child prompt from entering Pi's extension-command path.

The selected model is resolved once before recovery. `ModelRegistry.hasConfiguredAuth(model)` must report configured authorization; otherwise no child process or retry is created. Every attempt then acquires the package-wide FIFO startup slot and calls `ModelRegistry.getApiKeyAndHeaders(model)`. An unavailable credential result releases the slot and waits before another attempt without creating a process.

Only a failed RPC response for the first `prompt` can trigger child replacement. Its first error line must be exactly `No API key found for <provider>.` for the selected provider, and the prompt must not have been accepted. Status, projection, extension, and other service events do not block recovery. A failed process exits before the FIFO slot is released. A successful prompt response permanently ends recovery for that operation. Initial starts and terminal-session continuations use this policy; active steering does not start a process and does not use it.

The shared policy reads one configuration file during extension startup. When `PI_AGENT_SUITE_DIR` is empty or unset, it appends `agent-suite/child-startup/config.json` to Pi's agent directory. Pi resolves that directory from a non-empty `PI_CODING_AGENT_DIR`, otherwise from `~/.pi/agent`. When `PI_AGENT_SUITE_DIR` is non-empty, the file is `$PI_AGENT_SUITE_DIR/child-startup/config.json`. No other configuration path is checked.

Default configuration:

```json
{
  "authRetry": {
    "maxRetries": 10,
    "delayMs": 2000
  }
}
```

`maxRetries` is a non-negative integer and counts retries after the first attempt. `delayMs` is a positive integer and applies as a fixed delay without exponential growth or randomization. A missing file or omitted field uses the displayed defaults. An unreadable file, malformed JSON, unsupported key, or invalid value rejects extension loading.

Each attempt appends a `child-auth-startup-diagnostic` session entry containing the launcher, provider, attempt counts, stage, prompt-acceptance state, decision, fixed reason code, and duration. The record excludes credentials and `auth.json` content. Exhausted recovery returns the original sanitized failure followed by the final recovery reason and retains the structured attempt records on `ChildAuthStartupRecoveryError`.

## Compact session status panel

In interactive root TUI mode, the extension publishes an `Agents` row above Pi's editor after the session owns at least one direct or nested subagent:

```text
Agents: ⧗ 0 · ✓ 1 · ✗ 0 · ■ 0 · Ctrl+Shift+G
```

The row counts running, successful, failed, and aborted sessions across the complete owned hierarchy. It shares one panel and one upper separator with other package status producers. The separator and ordinary row text use Pi's dim color; the four agent icons retain their semantic accent, success, error, and warning colors. When the hierarchy becomes empty, only the `Agents` row disappears; other rows remain visible. Every row is clipped to the terminal width and ends with `…` when content is hidden.

RPC and print modes do not construct or publish the interactive status panel.

## Interactive management screen

In interactive TUI mode, either entry opens the same full-terminal overlay:

- `/subagents`
- `Ctrl+Shift+G`

The overlay is available only after the interactive root runtime starts. RPC and print modes do not construct the management screen or register its command and shortcut.

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

The second row shows status and the initial prompt. The third row shows available elapsed time, model ID, and token usage relative to the context window. While the selected invocation is active, its elapsed time is derived from `startedAtMs` and refreshed once per second. Terminal sessions show the finalized `elapsedMs`. Single-line header fields fold ASCII spaces and terminal spacing characters into one ordinary space before width clipping. Elapsed time is rounded down to whole seconds and uses seconds below one minute, `mm:ss` below one hour, and `h:mm:ss` from one hour. Token values below 1,000 are shown as integers; values of 1,000 or more use `k` with at most one decimal place, such as `34k/190k`. Elapsed time and model ID are each omitted when unavailable. Token usage appears only when both the used-token count and context-window size are available; otherwise the complete token/context value is omitted without a synthetic `0/...`, `?/...`, or context-window-only placeholder. A positive `context-projection` status prefixes the active usage, for example `~139k/344k/372k`, and updates without a new conversation entry. A zero, invalid, missing, or cleared projection status removes only that prefix. While the invocation is active, the header uses usage from the latest loaded assistant response only when its model matches the invocation model. Terminal invocation metadata takes precedence over the live projection snapshot. A continuation on another model does not reuse usage measured by the prior model.

### Responsive layout

Wide mode reserves at least 24 terminal columns for the hierarchy and 40 for the selected-session pane, excluding the two outer borders and the separator. A total width of 67 columns is therefore the first wide layout. At 66 columns or fewer, the screen uses one pane.

Wide mode shows the hierarchy on the left and the selected header, conversation, and editor on the right. Every new overlay starts with hierarchy focus; in one-pane mode it always opens on the hierarchy. Confirming a selected node opens its full-width conversation and editor. `Escape` returns from that pane to the hierarchy; another `Escape` closes the overlay. In wide mode, `Escape` closes the overlay directly.

### Conversation presentation

The conversation shows the selected saved session's active root-to-leaf branch in chronological order. Selecting another node replaces the conversation and moves its viewport to the latest content. Context-projection custom entries are excluded, and custom entries with `display: false` are not shown.

#### Live runtime status

An active selected session shows the child Pi runtime status between the conversation and editor:

- `Working...`
- retry countdown;
- manual, automatic, or context-overflow compaction;
- branch summarization.

The status is transient projection state, not a synthetic session entry, so it never appears in saved history. The active invocation retains the latest state and includes it in each selected-session snapshot. Opening or switching selection therefore does not require the original event to arrive again.

The row uses Pi's public `Loader`. It does not advertise a cancellation key because `Escape` remains owned by overlay navigation and closing.

Presentation uses Pi's public conversation components:

- User messages use `UserMessageComponent`.
- Assistant messages use `AssistantMessageComponent`, including Pi's assistant text and thinking presentation.
- Tool calls and their matching results use `ToolExecutionComponent`.
- Displayable custom messages use `CustomMessageComponent` with its standard custom-type text or Markdown presentation.

The management pane removes `OSC 133;A/B/C` shell-history markers from nested component rows before composition. These terminal-global markers corrupt Ghostty when an overlay redraw emits them again. Visible text, SGR styling, and OSC 8 hyperlinks are preserved.

Tool presentation follows three paths:

- Pi built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`) use Pi's built-in tool definition.
- Package tools publish their exact call, result, and shell presentation through Pi's shared extension event bus. The management pane resolves these presentations by tool name, independent of extension load order and Jiti module isolation. This covers the four Subagents tools, MCP wrapper tools, `consult_advisor`, and `convene_council`.
- Other tool names use the universal presentation: the JSON call preview starts on the tool-name row and occupies at most two visual lines; collapsed results occupy at most five visual lines and include a hidden-line count with the configured expansion key; expanded results use full Markdown; failures use error styling; and Pi supplies the normal tool shell.
- Collapsed arbitrary text uses the same whitespace, JSON-string, and terminal-control normalization as MCP tool previews. Expanded result text remains unchanged.

`Ctrl+O`, the default `app.tools.expand` binding, toggles all tool and custom-message expansion states regardless of focus. Each overlay samples Pi's current main-conversation tool-expansion state when that overlay opens. Toggling expansion inside the overlay changes only that open overlay and does not change the main conversation.

Conversation scrolling uses the configured up, down, page-up, and page-down bindings and counts wrapped visual rows. New content remains visible while the viewport is at the bottom. After the user scrolls upward, new content does not move the viewport. The pane does not show a scroll percentage.

Selection loads the complete saved root-to-leaf branch through Pi's public `SessionManager` after an asynchronous file preflight, then publishes its latest dependency-complete user turn. The screen reveals preceding turns from that in-memory branch until Pi's rendered rows fill the current conversation viewport. `Loading earlier messages…` marks the upper boundary of an incomplete preview. Its scroll column uses `⋮` and `▒` instead of a proportional thumb because the visible row count is still growing. Adding earlier entries preserves the top visible component and its row offset. When the root turn becomes visible, the normal proportional scroll thumb replaces the loading track.

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

Session creation, status changes, continuations, and selected-conversation activity update the overlay without changing a still-valid selection. A continuation updates the existing logical-session node instead of adding another node. Active selection requests the complete append-order entry set through Pi RPC `get_entries` and combines it with the supervisor's latest transient runtime status. The response's `leafId` selects the current branch without reading the concurrently written session file. Later refreshes request only entries after the last received entry ID. Activity received while the initial request is in flight schedules an incremental refresh after the selected loader owns that snapshot, so an entry appended after the opening snapshot was produced does not wait for another activity event. If one valid response exceeds the normal RPC line buffer, it is parsed as a stream. Scalar entry strings longer than 4,096 characters in that oversized response retain their first 4,095 characters followed by `…`. When an active session terminates, its final saved branch is loaded through `SessionManager`.

The installed Pi version owns saved-session parsing and migration; the extension does not interpret Pi's storage format. Only the selected complete saved branch or complete active entry set is retained in memory. Changing selection discards its conversation payload. An in-flight saved-session load is allowed to finish because `SessionManager.open()` can migrate the file, but its stale result cannot publish after another session becomes selected. Concurrent requests for the same saved file share one loading operation. If a selected-conversation refresh fails, Pi shows an error notification and the last successfully loaded conversation remains visible.

Reopening the overlay in the same extension runtime retains expanded hierarchy branches and the selected session only while those sessions still exist. The conversation payload is reloaded instead of retained while the overlay is closed. Independently, every reopened overlay resamples Pi's current main-conversation tool-expansion state; tool-expansion changes from the prior overlay are not retained. Hierarchy scroll resets to the top, focus and one-pane state reset to the hierarchy. If the retained selection is missing or invalid, the first visible root is selected.

Closing the overlay returns to the unchanged main conversation editor and viewport, clears the selected-conversation payload, and stops applying background refreshes. An in-flight `SessionManager.open()` operation finishes without publishing its result. Shutting down the owning runtime performs the same cleanup.

## Tool requests

Every request is a closed object. Extra properties are rejected.

### `subagent_start`

Starts a callable agent in a new saved logical session.

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `agentId` | Yes | Trimmed single-line Unicode string | Exact NFC-normalized ID of an available callable agent. |
| `taskName` | Yes | Trimmed single-line string with schema length 3–60 | Short name for the delegated task. |
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
| `timeout` | Yes | Integer from `1` through `3600` | Maximum wait duration in seconds. |

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
  "elapsedSeconds": 3,
  "output": "Final child output"
}
```

```json
{
  "outcome": "feedback",
  "sessionId": 1,
  "status": "failure",
  "elapsedSeconds": 3,
  "error": "Failure details"
}
```

```json
{
  "outcome": "feedback",
  "sessionId": 1,
  "status": "abort",
  "elapsedSeconds": 3,
  "error": "Abort details"
}
```

`elapsedSeconds` is the total child invocation runtime, not the time spent inside the current wait. The value is rounded up to a whole second and has a one-second minimum.

If no selected feedback is observed strictly before the timeout, the tool returns:

```json
{
  "outcome": "timeout"
}
```

Timeout does not stop or change any child. Feedback observed at the timeout boundary belongs to owner history rather than the timed-out wait.

Each owner can have at most one active wait. When eligible waits overlap, one becomes active and every other call fails with `wait_already_active`. A wait observes only the selected sessions that were active when that wait began.

### `subagent_query`

Asks one auxiliary model a focused question using a directly owned saved child conversation.

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `sessionId` | Yes | Positive integer | Owner-local ID of one direct child. |
| `question` | Yes | String containing at least one non-whitespace Unicode code point | Question XML-escaped and appended after the saved conversation inside one `<question>...</question>` block. |

A successful call returns only the auxiliary model's answer as tool-result text. The default tool shell shows the pending question as a bounded plain-text preview or a complete expanded Markdown section. After completion, the collapsed view shows the elapsed time, clips the normalized question to one visual row without wrapping, and bounds the plain-text answer preview. The expanded view shows the complete question and answer as separate Markdown sections.

The operation does not start, steer, wait for, resume, stop, or invoke the child agent. It reads one saved root-to-leaf branch through Pi's public `SessionManager`, validates every entry, applies only `context-projection` replacements persisted in that branch, appends one XML-escaped `<question>...</question>` block, and sends no tools to the auxiliary model. The child system prompt and the calling agent's project context are not copied.

The auxiliary model request runs in the Pi process of the calling agent. That process supplies the configured or current model, thinking level, authentication, cancellation signal, and cost attribution. A worker process requests only the authorized saved branch from the root runtime; that internal payload contains `sessionId` but not the question, session path, model, credentials, system prompt, answer, usage, or cost.

The query does not retry, truncate the branch, read process-local projection replacements, or merge current loaded-skill state. A missing or empty saved session, invalid branch, unavailable model or authentication, oversized input, provider failure, or empty text response fails with `query_failed`.

## Feedback delivery

Each normally terminal invocation produces one feedback value with status `success`, `failure`, or `abort`. That feedback has one destination:

- The matching active wait returns it once.
- If no matching active wait can return it, it enters the direct owner's conversation history once.

Feedback returned by a wait is not duplicated in owner history. If several selected children finish before one wait settles, the wait returns one feedback value and the others enter owner history. Those other values cannot be consumed by a later wait.

If normal feedback is selected for a matching wait but the owning runtime stops before that wait can return, the feedback is saved for owner history and delivered once when the owner session reopens.

History delivery includes `Duration: N seconds` between the completion header and child output or error. `N` follows the same total-invocation rounding rule as `elapsedSeconds`. When final invocation metadata contains context usage and positive projection savings, the `subagent_wait` card and direct feedback header render the shared `~saved/current/window` context value.

History delivery follows the owner's turn boundary:

- If the owner is idle, feedback is added without starting a new agent turn.
- If the owner is processing a turn, feedback is added after the current assistant turn finishes its tool calls and before the next model request.

A timeout, a no-active result, or feedback from an unselected child does not change child execution.

## Pi cancellation

Pi cancellation uses one ordering boundary for each root or nested operation:

- A start or terminal-session steer is ordered against prompt acceptance.
- An active-session steer is ordered against dispatch reservation.
- A wait is ordered against feedback, timeout, or no-active settlement.
- A query cancellation stops its in-flight auxiliary model request without changing the child session.

When cancellation wins:

- A start or terminal-session steer completes process and bridge cleanup without recording a new logical session or continuation.
- An active-session steer canceled before dispatch sends no steering prompt, applies no prompt, and sends no child abort.
- A wait removes its admission, timer, resolver, and bridge correlation before cancellation becomes observable. Later child feedback follows normal owner-history delivery.
- A query returns no answer and no `query_failed` result after caller cancellation wins.
- The tool call propagates as Pi cancellation. It returns neither a normal Subagents outcome nor a failed Subagents `{ code, message }` result.

Once active-steer dispatch is reserved, cancellation cannot win. If child Pi returns a successful steer response, the call returns the accepted result and applies the prompt exactly once, even when the parent observed cancellation before receiving that response. A rejected child steer response remains `message_rejected`; no child abort is sent in either case.

For a nested active steer, the root cancellation acknowledgment states whether cancellation won before dispatch. When dispatch won, the worker waits for the original steer response, returns that accepted or failed outcome, and closes the original and cancellation correlations once.

For start or terminal-session steer, prompt acceptance first keeps the accepted result and tracked logical-session or invocation state. For a wait, settlement first keeps its feedback, timeout, or no-active result and any selected feedback destination. Later cancellation does not undo a completed outcome.

## Session identity

`sessionId` is a positive integer local to the direct owner. Different owners, including owners in separate branches, can use the same number for different logical sessions. Therefore, `subagent_steer`, `subagent_wait`, and `subagent_query` can address only the caller's direct children.

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

Failed calls use Pi's failed-tool channel with `{ code, message }` and no normal `outcome`. Known causes use concise stable messages without process or storage details. An unavailable saved query conversation returns `Subagent is not ready, please try again after some time`. Unknown causes retain a bounded prefix of their original message after terminal-control and bidirectional-control removal, single-line whitespace normalization, and grapheme-safe truncation to 2,000 UTF-16 code units. An empty sanitized message becomes `Unknown error`. The same safety boundary applies to failure and abort feedback returned by `subagent_wait`.

| Code | Applies to | Meaning and retry condition |
| --- | --- | --- |
| `invalid_request` | All four tools | The closed request contract is violated. Retry with corrected input. |
| `agent_unavailable` | `subagent_start` | `agentId` does not identify an available subagent. Retry after availability changes. |
| `unknown_session` | `subagent_steer`, `subagent_wait`, `subagent_query` | No addressed ID is known as a non-owned session, and at least one addressed ID is unknown. Retry with corrected input. |
| `not_owner` | `subagent_steer`, `subagent_wait`, `subagent_query` | An addressed session is known but is not directly owned by the caller. For a wait containing unknown and known non-owned IDs, this code takes precedence. Retry with corrected input. |
| `message_rejected` | `subagent_start`, `subagent_steer` | A structurally valid initial or steering prompt was rejected. A start or steer may be retried in a later call. |
| `start_failed` | `subagent_start`, terminal-session `subagent_steer` | The required invocation could not start or exited before accepting its prompt. A later call may retry. |
| `query_failed` | `subagent_query` | The saved branch or auxiliary model request could not produce an answer. Retry after correcting the identified session, configuration, context size, authentication, or provider issue. |
| `wait_already_active` | `subagent_wait` | The owner already has the one permitted active wait, or this call lost an overlapping admission. Retry after the active wait ends. |

Structural request violations produce `invalid_request` before session, ownership, availability, or runtime checks. Each failed call returns one applicable code. A retry is a new call and does not retroactively change the failed call.
