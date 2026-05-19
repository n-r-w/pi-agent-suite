# structured-prompt

## Purpose

`structured-prompt` owns the `/prompt` command and the `ctrl+alt+p` shortcut for creating structured user requests from a focused form.

## Behavior

- Registers command `/prompt`.
- Registers shortcut `ctrl+alt+p` as a best-effort default.
- Reads configuration from `~/.pi/agent/agent-suite/structured-prompt/config.json`.
- Is enabled by default when `config.json` is missing.
- Does not register the command or shortcut when `enabled` is `false`.
- Does not register the command or shortcut when config is invalid.
- Requires interactive UI.
- Opens a centered custom UI overlay.
- Captures these sections in order:
  - Goal
  - Task
  - Context
  - Criteria
  - Constraints
  - Work order
- Supports multi-line section text.
- Shows a review screen before sending.
- Omits empty sections from the generated prompt.
- Sends the generated prompt as one user message when the agent is idle.
- When the agent is busy, asks whether to queue the generated prompt as a follow-up.
- Sends no message when the form is cancelled.
- Sends no message when every section is empty.

`/prompt` is the reliable entry point. `ctrl+alt+p` can be intercepted by a terminal, operating system, or user keybinding before Pi receives it.

## Configuration

File: `~/.pi/agent/agent-suite/structured-prompt/config.json`.

```json
{
  "enabled": true
}
```

Options:

- `enabled`: default `true`. Enables or disables `/prompt` and `ctrl+alt+p`.

Unsupported keys make the config invalid. The first version does not support custom sections or shortcut configuration.

## Generated prompt format

Only non-empty sections are included. Section order is fixed.

Example:

```md
## Goal
Create structured requests.

## Task
Implement the structured-prompt extension.

## Constraints
Keep tests isolated.
```

## Verification

Tests must verify:

- default command and shortcut registration when the config file is missing;
- command and shortcut omission when `enabled` is `false`;
- command and shortcut omission when config is invalid;
- command and shortcut use the same submit flow;
- UI-unavailable mode sends no message;
- cancel sends no message;
- empty submit sends no message;
- idle submit sends one generated user message;
- busy submit asks before follow-up delivery;
- rejecting follow-up sends no message;
- accepting follow-up queues the generated prompt as `followUp`;
- empty sections are omitted from the generated prompt;
- multi-line section text is preserved;
- terminal navigation escape sequences are not inserted into section text;
- rendered form rows stay within the requested width.
