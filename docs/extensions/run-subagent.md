# run-subagent

## Purpose

`run-subagent` adds two tools. `run_subagent` starts an independent child session with a configured callable agent. `resume_subagent` continues a saved child session with the original agent.

## Configuration file

Default file: `~/.pi/agent/agent-suite/run-subagent/config.json`.

If the file is missing, the extension is enabled with default settings.

## Full configuration example

```json
{
  "enabled": true,
  "maxDepth": 1,
  "widgetLineBudget": 7,
  "runDescriptionPromptFile": "/absolute/path/to/run-subagent-description.md",
  "resumeDescriptionPromptFile": "/absolute/path/to/resume-subagent-description.md"
}
```

## Parameters

| Name | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables or disables both subagent tools. Set to `false` to prevent their registration. |
| `maxDepth` | No | Integer greater than or equal to `0` | `1` | Limits nested subagent calls. `0` removes both tools from the active tool list. |
| `widgetLineBudget` | No | Integer greater than or equal to `1` | `7` | Limits the live widget to this many content lines, including its header, agent rows, and omission summaries. The separator above the widget is not counted. |
| `runDescriptionPromptFile` | No | Non-empty absolute file path string | Bundled `run_subagent` description | Replaces the `run_subagent` description with the trimmed file contents. |
| `resumeDescriptionPromptFile` | No | Non-empty absolute file path string | Bundled `resume_subagent` description | Replaces the `resume_subagent` description with the trimmed file contents. |

Configured description files must be readable and non-empty after trimming whitespace. The config object accepts only `enabled`, `maxDepth`, `widgetLineBudget`, `runDescriptionPromptFile`, and `resumeDescriptionPromptFile`.

## Agent definitions

Callable agents come from the shared agent registry documented in [main-agent-selection](main-agent-selection.md). Global definitions under `~/.pi/agent/agent-suite/agent-selection/agents` are extended by `<cwd>/.pi/agents`.

`run-subagent` rebuilds the registry for the current working directory when it creates callable-agent guidance and when it validates a tool call. A project override therefore supplies the child prompt, model, thinking level, tools, and callable subagents. Each child resolves its own `tools` patterns against its complete runtime tool catalog, independently of the caller's catalog. Resumed sessions keep their original agent ID but use its current definition for the same working directory.

## Authentication startup recovery

Before allocating a new child session, `run-subagent` resolves the selected model credentials through the parent model registry. A parent authentication failure returns immediately without starting child `pi`.

Concurrent child calls share one FIFO startup gate. The gate allows one child Pi process at a time to start and complete prompt preflight, including credential loading. A successful prompt response releases the gate while the child continues its full run, so agent execution remains parallel. Prompt rejection, process exit, and spawn failure also release the gate. Cancellation before process creation removes the call from the queue without starting Pi; cancellation after process creation uses the child RPC abort path.

A fresh child can still temporarily miss OAuth credentials when an independent Pi process holds the shared `auth.json` lock. After successful parent authentication, `run-subagent` retries only the matching `No API key found for <provider>` startup failure. Every retry re-enters the startup gate. Recovery requires an exit code of zero, no child output or execution events, and no child session file. The original attempt and up to three retries use the same numeric session ID and child UUID. Exponential randomized delays reduce repeated lock contention with external Pi processes. Resumed sessions, failures after session creation, and other errors are not retried.

## Live progress

Interactive TUI mode sends one initial partial update to populate the historical call with the resolved model and thinking level. Later live progress appears only in the widget and focused browser. RPC and other non-TUI modes keep every intermediate tool update for nested progress propagation.

The header counts every direct and nested logical child session. It also shows the number of concrete displayed sessions, total recorded sessions, and the `Ctrl+Shift+G` browser shortcut.

### Automatic view

The automatic body follows these rules:

- Failed and aborted work is selected before running work.
- Running work is selected before completed work.
- Sessions within one status class are ordered by their latest update time.
- A nested session is shown only with its complete visible ancestor path.
- A parent with only hidden descendants shows their aggregate on the parent row.
- A partially visible branch ends with a local omission summary.
- Hidden root branches keep a root-level summary when the line budget permits it or attention-bearing work is hidden.
- Completed sessions use remaining rows after failed, aborted, and running work.
- With `widgetLineBudget` set to `1`, only the aggregate header fits.

Connectors are derived after the visible tree is selected. A visible descendant therefore cannot retain a connector to a hidden parent or sibling.

### Selected-session view

Selecting a child session in the browser switches the widget from the aggregate overview to that session. Selection uses the internal `childSessionId`, so it remains stable while other sessions start or finish and while the selected session is resumed.

A root session uses one header row:

```text
✓ Root: YandexExtractor #2 · Delegate identity checks · openai-codex/gpt-5.6-luna/low · 18k/372k · 85.3s
```

When the line budget permits a second row, a nested session shows its direct parent and root-relative depth:

```text
✓ Child: YandexExtractor #1 · Delegate identity checks · openai-codex/gpt-5.6-luna/low · 18k/372k · 85.3s
Parent: SubAgentExtractor #2 · Delegate catalog checks · Depth 1
```

The first selected-session row starts with the same symbol as the overview: `➜` for a running new session, `⇆` for a running continuation, `✓` for success, `✗` for failure, or `■` for an abort. A terminal symbol replaces the running invocation symbol when work ends. Runtime model details and tool event payloads use the normal foreground color; status symbols, tool names, context pressure, and elapsed time retain their semantic styling. The remaining rows within `widgetLineBudget` show the latest retained tool events in chronological order without tree connectors. `tool_call`, `tool_result`, and tool execution `error` events each use one row. Assistant output and assistant failures are excluded. Rows do not wrap and are clipped to terminal width. The selected-session view does not scroll.

Select `Automatic view` in the browser to resume aggregate selection. The selected logical session is stored with the current main session and restored when that session reopens.

### Browser

Open the complete session list with either:

- `/subagents`
- `Ctrl+Shift+G`

The browser uses Pi `SelectList` behavior:

- `Up` and `Down` navigate and scroll through every recorded root and nested child session.
- `Enter` shows the selected child session in the widget or applies `Automatic view`.
- `Escape` or `Ctrl+C` closes the browser without changing the current mode.

Browser labels append `Root` for root sessions or root-relative `Depth N` for nested sessions. Nested descriptions also name the direct parent. The browser preserves selection by `childSessionId` while the invocation `runId`, live status, elapsed time, context usage, and activity descriptions change.

### Session identity and row content

Each logical child session shows the short numeric `sessionId` used for continuation. A running new session renders as `➜ Sage #2 · Review widget navigation`. Resuming it updates the same row, returns it to `running`, replaces its task and invocation state, and uses the continuation symbol, for example `⇆ Sage #2 · Verify project quality gates`. Completed descendants absent from the latest resume snapshot remain attached to the session. `childSessionId` is the internal logical-row identity, while `runId` identifies the latest invocation. Numeric session IDs are local to the owning Pi session, so separate nested branches may display the same number.

Each overview agent row uses one visual terminal line:

- Elapsed time uses milliseconds below one second, then seconds, `m:ss`, or `h:mm:ss`.
- Context usage shows rounded whole-thousand token counts such as `190k/372k`; unknown overflow usage uses `~/372k`.
- Projection savings remain first and use the same rounding, for example `~20k/190k/372k`. Context pressure colors still use the unrounded usage percentage.
- Tool activity shows the most recent tool name followed by its serialized call arguments, even when a later assistant event completes the run. Captured argument text is limited to 240 UTF-16 code units and 240 terminal columns, then clipped to the remaining row width with `…`. Tool result payloads are not shown in overview rows; failures and empty searches use compact outcome labels. Terminal control sequences and standalone C0/C1 controls are removed. Terminal line whitespace is folded without rewriting other Unicode content.

When a mixed omission summary does not fit in verbose form, it uses status icons while preserving every non-zero count. For example, `3 nested: 1 running · 1 failed · 1 done` becomes `3 nested: ⏳1 ✗1 ✓1`.

Rows are clipped by terminal display width after grapheme-aware plain-text selection and before theme colors are applied. This preserves composed Unicode characters and prevents ANSI reset sequences from leaking into the parent widget style.

## Historical tool rendering

Collapsed calls show `Name` from `taskName` and a wrapped `Task` preview from `prompt`, without progress rows. The `Name:` and `Task:` labels are bold; their values use the theme's `muted` color. After a new session is allocated, the `run_subagent` header adds `#N`. A `resume_subagent` call immediately shows the persisted agent and requested `#N`; an unknown session shows only `#N` until execution reports the session error. Runtime resolution adds the model and thinking level, while the final result adds context usage and elapsed time. Expanded calls retain the header and `Name`, omit the `Task` preview, and show the complete prompt once under `Prompt`. Completed calls also show the final answer, failure, or abort result. Expanded calls do not show the intermediate event timeline or a separate stderr section.

## Child session logs

A `run_subagent` call starts child `pi` with a saved JSONL session. A `resume_subagent` call continues the saved session at its active leaf.

Child sessions are stored outside the normal project session list:

```text
~/.pi/agent/agent-suite/run-subagent/sessions/
```

If `PI_AGENT_SUITE_DIR` is set, the same `run-subagent/sessions/` path is created under that suite directory.

The tool result `details` includes:

| Field | Meaning |
| --- | --- |
| `formatVersion` | Persisted widget-details format version. |
| `sessionId` | Short positive integer used by `resumeSession` and displayed as `#N` within the owning session. |
| `isResume` | `true` for `resume_subagent` invocations and `false` for new sessions. |
| `childSessionId` | Pi-compatible UUIDv7 assigned to the child session. |
| `childSessionDir` | Directory passed to child `pi` through `--session-dir`. |
| `childSessionPath` | JSONL session file path when the file is found after child exit. |

## Tool input

`run_subagent` starts a new session:

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `agentId` | Yes | String | Callable agent ID to run. |
| `taskName` | Yes | String with 3–60 characters | Unique 2–6 word action-and-object name for this invocation. Concurrent calls use distinct names based on task focus. |
| `prompt` | Yes | String | Complete task prompt for an independent child conversation. |

`resume_subagent` continues an existing session:

| Name | Required | Type or shape | Meaning |
| --- | --- | --- | --- |
| `resumeSession` | Yes | Positive integer | Short session ID returned by an earlier invocation in the current owning session. |
| `taskName` | Yes | String with 3–60 characters | New action-and-object name for this follow-up invocation. |
| `prompt` | Yes | String | Changed requirements, review findings, decisions, and acceptance criteria needed for the follow-up. |

Both tools expose closed root object schemas with `additionalProperties: false`. Calling models receive all required properties without a root union.

### Tool availability

- Agent tool lists must explicitly allow `resume_subagent`; allowing `run_subagent` does not add it automatically.
- `run_subagent` is the master capability. If it is not active, `resume_subagent` is removed even when listed.
- Reaching `maxDepth` removes both tools and their callable-agent guidance.
- Removing delegation tools does not change any other tool selected by the child definition.
- Setting `enabled` to `false` prevents both tools from being registered.

## Session continuation

Every child run that starts returns its short ID before the child response:

```text
Subagent session: 1

<child response>
```

Use `resume_subagent` with the returned number to send follow-up work to the same conversation:

```json
{
  "resumeSession": 1,
  "taskName": "Repair review findings",
  "prompt": "Apply the reviewer findings and rerun the affected checks."
}
```

Continuation follows these rules:

- The saved mapping supplies the original `agentId`; callers cannot replace it during continuation.
- The working directory must match the original run.
- The saved JSONL file must still exist and pass Pi session validation.
- One main-agent runtime cannot start two child processes for the same session concurrently.
- Missing, conflicting, foreign, or active session IDs fail without starting a new session.
- A resumed run uses the current model, thinking level, tools, and instructions configured for the same agent.
- When an invocation is aborted, descendant snapshots still marked as running are finalized as aborted before persistence. Resuming the parent retains those descendants as terminal history instead of showing them as active.
- The resumed child resolves the current tool patterns against its own runtime catalog, not the resuming caller's catalog.

The numeric alias, child UUID, child session directory, `agentId`, and working directory are persisted as a Pi custom session entry. The current main-session branch also retains versioned invocation-start and browser-selection entries. Terminal tool-result details rebuild completed widget state; a start without a later terminal result reopens as `aborted`. Unknown or malformed widget records reset only the affected reconstructed widget or selection state. They do not invalidate the child-session registry or modify child JSONL files.

Custom entries do not participate in LLM context. Provider adapters build model-facing tool results from `content`, which contains the short numeric ID but not the UUID, directory, or registry mapping.
